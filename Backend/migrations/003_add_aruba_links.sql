INSERT INTO ptp_links (link_id, source_site_id, target_site_id, frequency_ghz, max_capacity_mbps) 
OVERRIDING SYSTEM VALUE
VALUES 
-- Link 3: SMPC Aruba Relay Gateway (Panabo routing back to Bunawan)
(3, 2, 1, NULL, 400), 

-- Link 4: Bunawan Aruba Core Gateway (Bunawan routing to the P2P Network)
(4, 1, 2, NULL, 400);