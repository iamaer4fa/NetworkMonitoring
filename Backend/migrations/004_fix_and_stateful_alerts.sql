-- Add device_ip to link_metrics
ALTER TABLE link_metrics ADD COLUMN device_ip VARCHAR(50) NOT NULL DEFAULT '';

-- Create index on device_ip for faster queries
CREATE INDEX idx_link_metrics_device_ip ON link_metrics(device_ip);

-- Create active_alerts table
CREATE TABLE active_alerts (
    alert_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    link_id INT REFERENCES ptp_links(link_id) ON DELETE CASCADE,
    device_ip VARCHAR(50) NOT NULL DEFAULT '',
    event VARCHAR(50) NOT NULL, -- 'LINK_DEGRADATION', 'CAPACITY_EXHAUSTION'
    severity VARCHAR(20) NOT NULL,
    first_triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (link_id, device_ip, event)
);

-- Drop the old trigger to avoid conflict
DROP TRIGGER IF EXISTS trigger_link_degradation ON link_metrics;

-- Recreate notify_link_degradation trigger function
CREATE OR REPLACE FUNCTION notify_link_degradation()
RETURNS TRIGGER AS $$
DECLARE
    alert_payload JSON;
    v_source_name VARCHAR;
    v_target_name VARCHAR;
    v_hardware VARCHAR;
    v_frequency DECIMAL;
    v_max_capacity INT;
    v_high_traffic_count INT;
    v_alert_exists BOOLEAN;
BEGIN
    -- 1. Fetch Location, Hardware, Frequency AND Max Capacity from the static topology table
    SELECT 
        s_source.site_name, 
        s_target.site_name, 
        s_source.hardware_model, 
        p.frequency_ghz, 
        p.max_capacity_mbps
    INTO 
        v_source_name, 
        v_target_name, 
        v_hardware, 
        v_frequency, 
        v_max_capacity
    FROM ptp_links p
    JOIN network_sites s_source ON p.source_site_id = s_source.site_id
    JOIN network_sites s_target ON p.target_site_id = s_target.site_id
    WHERE p.link_id = NEW.link_id;

    -- 2. HARD OUTAGE / DEGRADATION CHECK
    IF NEW.is_link_up = FALSE OR (NEW.rssi_dbm IS NOT NULL AND NEW.rssi_dbm < -80) THEN
        -- Check if alert already exists
        SELECT EXISTS (
            SELECT 1 FROM active_alerts 
            WHERE link_id = NEW.link_id AND device_ip = NEW.device_ip AND event = 'LINK_DEGRADATION'
        ) INTO v_alert_exists;

        IF NOT v_alert_exists THEN
            INSERT INTO active_alerts (link_id, device_ip, event, severity)
            VALUES (NEW.link_id, NEW.device_ip, 'LINK_DEGRADATION', CASE WHEN NEW.is_link_up = FALSE THEN 'CRITICAL' ELSE 'WARNING' END);

            alert_payload = json_build_object(
                'event', 'LINK_DEGRADATION',
                'status', 'TRIGGERED',
                'severity', CASE WHEN NEW.is_link_up = FALSE THEN 'CRITICAL' ELSE 'WARNING' END,
                'link_id', NEW.link_id,
                'device_ip', NEW.device_ip,
                'source_site', v_source_name,
                'target_site', v_target_name,
                'hardware', v_hardware,
                'frequency', v_frequency,
                'rssi_dbm', NEW.rssi_dbm,
                'snr_db', NEW.snr_db,
                'timestamp', NEW.poll_timestamp
            );
            PERFORM pg_notify('network_alerts', alert_payload::text);
        ELSE
            -- Just update the last triggered timestamp and severity
            UPDATE active_alerts 
            SET last_triggered_at = CURRENT_TIMESTAMP,
                severity = CASE WHEN NEW.is_link_up = FALSE THEN 'CRITICAL' ELSE 'WARNING' END
            WHERE link_id = NEW.link_id AND device_ip = NEW.device_ip AND event = 'LINK_DEGRADATION';
        END IF;
    ELSE
        -- Condition is normal. Check if we need to resolve an active alert.
        SELECT EXISTS (
            SELECT 1 FROM active_alerts 
            WHERE link_id = NEW.link_id AND device_ip = NEW.device_ip AND event = 'LINK_DEGRADATION'
        ) INTO v_alert_exists;

        IF v_alert_exists THEN
            DELETE FROM active_alerts 
            WHERE link_id = NEW.link_id AND device_ip = NEW.device_ip AND event = 'LINK_DEGRADATION';

            alert_payload = json_build_object(
                'event', 'LINK_DEGRADATION',
                'status', 'RESOLVED',
                'severity', 'INFO',
                'link_id', NEW.link_id,
                'device_ip', NEW.device_ip,
                'source_site', v_source_name,
                'target_site', v_target_name,
                'hardware', v_hardware,
                'frequency', v_frequency,
                'rssi_dbm', NEW.rssi_dbm,
                'snr_db', NEW.snr_db,
                'timestamp', NEW.poll_timestamp
            );
            PERFORM pg_notify('network_alerts', alert_payload::text);
        END IF;
    END IF;

    -- 3. CAPACITY EXHAUSTION CHECK (15-Minute Rolling Window per device_ip)
    IF v_max_capacity IS NOT NULL AND v_max_capacity > 0 THEN
        -- Count how many of the LAST 3 polls (15 mins) for this device were above 90%
        SELECT COUNT(*) INTO v_high_traffic_count
        FROM (
            SELECT throughput_rx_mbps, throughput_tx_mbps
            FROM link_metrics
            WHERE link_id = NEW.link_id AND device_ip = NEW.device_ip
            ORDER BY metric_id DESC
            LIMIT 3
        ) AS recent_polls
        WHERE (throughput_rx_mbps + throughput_tx_mbps) > (v_max_capacity * 0.90);

        -- If all 3 polls (15 mins) are congested, fire the alert
        IF v_high_traffic_count = 3 THEN
            SELECT EXISTS (
                SELECT 1 FROM active_alerts 
                WHERE link_id = NEW.link_id AND device_ip = NEW.device_ip AND event = 'CAPACITY_EXHAUSTION'
            ) INTO v_alert_exists;

            IF NOT v_alert_exists THEN
                INSERT INTO active_alerts (link_id, device_ip, event, severity)
                VALUES (NEW.link_id, NEW.device_ip, 'CAPACITY_EXHAUSTION', 'WARNING');

                alert_payload = json_build_object(
                    'event', 'CAPACITY_EXHAUSTION',
                    'status', 'TRIGGERED',
                    'severity', 'WARNING',
                    'link_id', NEW.link_id,
                    'device_ip', NEW.device_ip,
                    'source_site', v_source_name,
                    'target_site', v_target_name,
                    'current_throughput', (NEW.throughput_rx_mbps + NEW.throughput_tx_mbps),
                    'max_capacity', v_max_capacity,
                    'timestamp', NEW.poll_timestamp
                );
                PERFORM pg_notify('network_alerts', alert_payload::text);
            ELSE
                UPDATE active_alerts 
                SET last_triggered_at = CURRENT_TIMESTAMP
                WHERE link_id = NEW.link_id AND device_ip = NEW.device_ip AND event = 'CAPACITY_EXHAUSTION';
            END IF;
        ELSE
            -- Normal/uncongested. Resolve alert if active.
            SELECT EXISTS (
                SELECT 1 FROM active_alerts 
                WHERE link_id = NEW.link_id AND device_ip = NEW.device_ip AND event = 'CAPACITY_EXHAUSTION'
            ) INTO v_alert_exists;

            IF v_alert_exists THEN
                DELETE FROM active_alerts 
                WHERE link_id = NEW.link_id AND device_ip = NEW.device_ip AND event = 'CAPACITY_EXHAUSTION';

                alert_payload = json_build_object(
                    'event', 'CAPACITY_EXHAUSTION',
                    'status', 'RESOLVED',
                    'severity', 'INFO',
                    'link_id', NEW.link_id,
                    'device_ip', NEW.device_ip,
                    'source_site', v_source_name,
                    'target_site', v_target_name,
                    'current_throughput', (NEW.throughput_rx_mbps + NEW.throughput_tx_mbps),
                    'max_capacity', v_max_capacity,
                    'timestamp', NEW.poll_timestamp
                );
                PERFORM pg_notify('network_alerts', alert_payload::text);
            END IF;
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
