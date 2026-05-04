ALTER TABLE link_metrics 
ADD COLUMN throughput_rx_mbps DECIMAL(8,2),
ADD COLUMN throughput_tx_mbps DECIMAL(8,2),
ADD COLUMN latency_ms INT,
ADD COLUMN cpu_utilization_pct INT,
ADD COLUMN noise_floor_dbm INT;