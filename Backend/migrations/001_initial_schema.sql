CREATE TABLE network_sites (
    site_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    site_name VARCHAR(100) NOT NULL,
    role VARCHAR(50) NOT NULL, -- e.g., 'Main Plant', 'Gateway', 'Branch'
    location GEOGRAPHY(Point, 4326) NOT NULL,
    hardware_model VARCHAR(100), -- e.g., 'Aruba 9012'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ptp_links (
    link_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_site_id INT REFERENCES network_sites(site_id),
    target_site_id INT REFERENCES network_sites(site_id),
    signal_path GEOGRAPHY(LineString, 4326),
    frequency_ghz DECIMAL(4,2), 
    max_capacity_mbps INT,
    status VARCHAR(20) DEFAULT 'Active'
);
-- Spatial index for fast geographic queries
CREATE INDEX idx_network_sites_location ON network_sites USING GIST (location)

CREATE INDEX idx_ptp_links_path ON ptp_links USING GIST (signal_path);

CREATE TABLE link_metrics (
    metric_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    link_id INT REFERENCES ptp_links(link_id),
    poll_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    rssi_dbm INT,
    snr_db INT,
    mcs_index INT,
    uptime_ticks BIGINT,
    is_link_up BOOLEAN
);

-- Index for time-series queries (crucial for dashboards and alerting)
CREATE INDEX idx_link_metrics_time ON link_metrics(poll_timestamp DESC);
CREATE INDEX idx_link_metrics_link_time ON link_metrics(link_id, poll_timestamp DESC);


CREATE OR REPLACE FUNCTION notify_link_degradation()
RETURNS TRIGGER AS $$
DECLARE
    alert_payload JSON;
    v_source_name VARCHAR;
    v_target_name VARCHAR;
    v_hardware VARCHAR;
    v_max_capacity INT;
    v_high_traffic_count INT;
BEGIN
    -- 1. Fetch Location AND Max Capacity from the static topology table
    SELECT 
        s_source.site_name, s_target.site_name, s_source.hardware_model, p.max_capacity_mbps
    INTO 
        v_source_name, v_target_name, v_hardware, v_max_capacity
    FROM ptp_links p
    JOIN network_sites s_source ON p.source_site_id = s_source.site_id
    JOIN network_sites s_target ON p.target_site_id = s_target.site_id
    WHERE p.link_id = NEW.link_id;

    -- 2. HARD OUTAGE CHECK (Existing Logic)
    IF NEW.is_link_up = FALSE OR NEW.rssi_dbm < -80 THEN
        alert_payload = json_build_object(
            'event', 'LINK_DEGRADATION',
            'severity', 'CRITICAL',
            'link_id', NEW.link_id,
            'source_site', v_source_name,
            'target_site', v_target_name,
            'rssi_dbm', NEW.rssi_dbm,
            'timestamp', NEW.poll_timestamp
        );
        PERFORM pg_notify('network_alerts', alert_payload::text);
        RETURN NEW;
    END IF;

    -- 3. CAPACITY EXHAUSTION CHECK (New Logic: 15-Minute Rolling Window)
    IF (NEW.throughput_rx_mbps + NEW.throughput_tx_mbps) > (v_max_capacity * 0.90) THEN
        
        -- Count how many of the LAST 3 polls (15 mins) were above 90%
        SELECT COUNT(*) INTO v_high_traffic_count
        FROM (
            SELECT throughput_rx_mbps, throughput_tx_mbps
            FROM link_metrics
            WHERE link_id = NEW.link_id
            ORDER BY poll_timestamp DESC
            LIMIT 3
        ) AS recent_polls
        WHERE (throughput_rx_mbps + throughput_tx_mbps) > (v_max_capacity * 0.90);

        -- If all 3 polls (15 mins) are congested, fire the alert
        IF v_high_traffic_count = 3 THEN
            alert_payload = json_build_object(
                'event', 'CAPACITY_EXHAUSTION',
                'severity', 'WARNING',
                'link_id', NEW.link_id,
                'source_site', v_source_name,
                'target_site', v_target_name,
                'current_throughput', (NEW.throughput_rx_mbps + NEW.throughput_tx_mbps),
                'max_capacity', v_max_capacity,
                'timestamp', NEW.poll_timestamp
            );
            PERFORM pg_notify('network_alerts', alert_payload::text);
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach the trigger to your metrics table
CREATE TRIGGER trigger_link_degradation
AFTER INSERT ON link_metrics
FOR EACH ROW
EXECUTE FUNCTION notify_link_degradation();

-- 1. Create the physical network sites first
INSERT INTO network_sites (site_name, role, location, hardware_model) 
VALUES
('Bunawan Plant', 'Main Plant', ST_SetSRID(ST_MakePoint(125.64946596937014, 7.248111469919785), 4326), 'Cambium AP'),
('Panabo Relay', 'Gateway', ST_SetSRID(ST_MakePoint(125.69574212142204, 7.31415239029441), 4326), 'Cambium AP'),
('Carmen Plant', 'Branch', ST_SetSRID(ST_MakePoint(125.6149794722596, 7.381445703124257), 4326), 'Cambium AP');

-- We convert MHz to GHz to match your database schema. 
-- 4995 MHz = 4.99 GHz | 5260 MHz = 5.26 GHz

INSERT INTO ptp_links (link_id, source_site_id, target_site_id, frequency_ghz, max_capacity_mbps) 
OVERRIDING SYSTEM VALUE
VALUES 
(1, 1, 2, 4.99, 400), -- Link 1: Bunawan to Panabo Gateway
(2, 2, 3, 5.26, 400); -- Link 2: Panabo Gateway to Carmen


-- 1. Update Link 1 (Bunawan to Panabo): Insert historical data.

