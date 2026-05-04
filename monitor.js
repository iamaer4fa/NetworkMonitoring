const snmp = require('net-snmp');
const { Pool } = require('pg');
require('dotenv').config();

// Store the previous poll's byte counters to calculate deltas
const previousPollState = {};

// Database connection pool
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});
const community_string = process.env.COMMUNITY_STRING

// Network Topology Mapping (Mapping IPs to your ptp_links table IDs)
const devices = [
    { ip: '10.10.10.2', name: 'Bunawan AP', linkId: 1, community: community_string, version: snmp.Version2c },
    { ip: '10.10.10.3', name: 'Panabo Gateway (Bunawan)', linkId: 1, community: community_string, version: snmp.Version2c },
    { ip: '10.10.10.4', name: 'Panabo Gateway (Carmen)', linkId: 2, community: community_string, version: snmp.Version2c },
    { ip: '10.10.10.5', name: 'Carmen AP', linkId: 2, community: community_string, version: snmp.Version2c }
];

// NOTE: You will need to extract the exact numeric OIDs from your CAMBIUM MIB files.
// These are placeholder standard/generic OIDs for demonstration.
const OIDS = {
    sysUpTime: '1.3.6.1.2.1.1.3.0',
    rssi: '1.3.6.1.4.1.17713.21.1.2.1.0', // Replace with exact Cambium RSSI OID
    snr: '1.3.6.1.4.1.17713.21.1.2.2.0',  // Replace with exact Cambium SNR OID
    rxBytes64: '1.3.6.1.2.1.31.1.1.1.6.1',  // 64-bit HC In Octets (Index 1)
    txBytes64: '1.3.6.1.2.1.31.1.1.1.10.1', // 64-bit HC Out Octets (Index 1)
    cpuLoad: '1.3.6.1.4.1.17713.1.2.2.1.4.1', // Cambium cnReach CPU Load
    noiseFloor: '1.3.6.1.4.1.17713.1.2.2.1.7.1' // Cambium cnReach Noise Floor

};

async function pollDevice(device) {
    return new Promise((resolve, reject) => {
        const session = snmp.createSession(device.ip, device.community, { version: device.version });

        // Add the new 64-bit OIDs to our fetch list
        const oidsToFetch = [OIDS.sysUpTime, OIDS.rssi, OIDS.snr, OIDS.rxBytes64, OIDS.txBytes64];

        session.get(oidsToFetch, (error, varbinds) => {
            if (error) {
                console.error(`[${device.name}] SNMP Error: ${error.message}`);
                // Return nulls and 0 Mbps on failure to trigger alerts properly
                resolve({ linkId: device.linkId, uptime: null, rssi: null, snr: null, rxMbps: 0, txMbps: 0, isUp: false });
            } else {
                let metrics = { linkId: device.linkId, isUp: true, rxMbps: 0, txMbps: 0 };
                let currentRxBytes = 0;
                let currentTxBytes = 0;

                varbinds.forEach((vb) => {
                    if (snmp.isVarbindError(vb)) {
                        console.error(`[${device.name}] OID Error: ${snmp.varbindError(vb)}`);
                    } else {
                        if (vb.oid === OIDS.sysUpTime) metrics.uptime = vb.value;
                        if (vb.oid === OIDS.rssi) metrics.rssi = vb.value;
                        if (vb.oid === OIDS.snr) metrics.snr = vb.value;

                        // net-snmp returns 64-bit counters as Buffers. We convert them to standard Numbers for math.
                        if (vb.oid === OIDS.rxBytes64) currentRxBytes = Number('0x' + vb.value.toString('hex'));
                        if (vb.oid === OIDS.txBytes64) currentTxBytes = Number('0x' + vb.value.toString('hex'));
                    }
                });

                // --- BANDWIDTH DELTA CALCULATION LOGIC ---
                if (previousPollState[device.linkId]) {
                    const prev = previousPollState[device.linkId];

                    const rxDelta = currentRxBytes - prev.rx;
                    const txDelta = currentTxBytes - prev.tx;

                    // Only calculate if the AP didn't reboot (which resets counters to 0)
                    if (rxDelta >= 0 && txDelta >= 0) {
                        metrics.rxMbps = (rxDelta * 8) / (300 * 1000000);
                        metrics.txMbps = (txDelta * 8) / (300 * 1000000);
                    }
                }

                // Save current state for the NEXT 5-minute poll
                previousPollState[device.linkId] = { rx: currentRxBytes, tx: currentTxBytes };
                // -----------------------------------------

                session.close();
                resolve(metrics); // Resolves the promise with the fully enriched metrics object
            }
        });
    });
}

async function saveMetricsToDb(metrics) {
    const query = `
        INSERT INTO link_metrics (link_id, rssi_dbm, snr_db, uptime_ticks, is_link_up,throughput_rx_mbps,throughput_tx_mbps)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    for (const data of metrics) {
        try {
            await pool.query(query, [data.linkId, data.rssi, data.snr, data.uptime, data.isUp, data.rxMbps, data.txMbps]);
            console.log(`Successfully saved metrics for Link ID: ${data.linkId}`);
        } catch (err) {
            console.error(`Database Error for Link ID ${data.linkId}:`, err.message);
        }
    }
}

async function runPoller() {
    console.log(`Starting SNMP poll across Davao del Norte infrastructure...`);
    const pollPromises = devices.map(device => pollDevice(device));
    const results = await Promise.all(pollPromises);

    await saveMetricsToDb(results);
    console.log(`Polling cycle complete.\n---`);
}

// Run the poller every 5 minutes (300,000 ms)
setInterval(runPoller, 300000);

// Initial run
runPoller();