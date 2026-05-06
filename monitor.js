const snmp = require('net-snmp');
const { Pool } = require('pg');
require('dotenv').config();

// Store the previous poll's byte counters to calculate deltas
const previousPollState = {};

// Database connection pool+
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
    {
        // Firmware version 4.6.1
        // CAMBIUM MIB file: /usr/share/snmp/mibs/CAMBIUM-PMP80211-MIB.txt
        // Role: AP — cambiumSTADLRSSI/SNR are SM-only OIDs, not available on AP side
        ip: '10.10.10.2',
        name: 'Bunawan AP',
        linkId: 1,
        community: community_string,
        version: snmp.Version2c,
        ifIndex: 1,
        type: 'Cambium',
        role: 'AP'
    },
    {
        // Firmware version 4.8.1
        // CAMBIUM MIB file: /usr/share/snmp/mibs/CAMBIUM-ePMP-4.8.0-MIB.txt
        // Role: SM — this is the subscriber side, exposes RSSI/SNR scalars
        ip: '10.10.10.3',
        name: 'Panabo Gateway (Bunawan)',
        linkId: 1,
        community: community_string,
        version: snmp.Version2c,
        ifIndex: 1,
        type: 'Cambium',
        role: 'SM'
    },
    {
        // Firmware version 4.8.1
        // CAMBIUM MIB file: /usr/share/snmp/mibs/CAMBIUM-ePMP-4.8.0-MIB.txt
        // Role: AP — AP side of the Carmen link
        ip: '10.10.10.4',
        name: 'Panabo Gateway (Carmen)',
        linkId: 2,
        community: community_string,
        version: snmp.Version2c,
        ifIndex: 1,
        type: 'Cambium',
        role: 'AP'
    },
    {
        // Firmware version 4.6.1
        // CAMBIUM MIB file: /usr/share/snmp/mibs/CAMBIUM-PMP80211-MIB.txt
        // Role: SM — subscriber side of Carmen link, exposes RSSI/SNR scalars
        ip: '10.10.10.5',
        name: 'Carmen AP',
        linkId: 2,
        community: community_string,
        version: snmp.Version2c,
        ifIndex: 1,
        type: 'Cambium',
        role: 'SM'
    },
    {
        // NOTE: This is the Aruba 9012 Device, no Aruba MIB file available
        ip: '10.10.10.1',
        name: 'SMPC Davao Aruba Gateway',
        linkId: 4,
        community: community_string,
        version: snmp.Version2c,
        ifIndex: 8,
        type: 'Aruba'
    },
    {
        // NOTE: This is the Aruba 9012 Device, no Aruba MIB file available
        ip: '10.10.10.6',
        name: 'SCPC Carmen Aruba Gateway',
        linkId: 3,
        community: community_string,
        version: snmp.Version2c,
        ifIndex: 3,
        type: 'Aruba'
    }
];

// OIDs verified from CAMBIUM-PMP80211-MIB.txt and CAMBIUM-ePMP-4.8.0-MIB.txt
// Both MIB versions share identical OID assignments.
// Scalar OIDs must end in .0 to address the single instance.
// NOTE: sysUpTime uses the standard SNMPv2 OID (returns numeric TimeTicks) instead of
// cambiumSystemUptime which returns a string ("dddd:hh:mm:ss") incompatible with BIGINT.
const CAMBIUM_OIDS = {
    sysUpTime:  '1.3.6.1.2.1.1.3.0',              // Standard sysUpTime — numeric TimeTicks (BIGINT-safe)
    rssi:       '1.3.6.1.4.1.17713.21.1.2.3.0',   // cambiumSTADLRSSI — SM Downlink RSSI in dBm (SM role only)
    snr:        '1.3.6.1.4.1.17713.21.1.2.18.0',  // cambiumSTADLSNR — SM Downlink SNR in dBm (SM role only)
    rxBytes64:  '1.3.6.1.4.1.17713.21.2.1.2.0',   // cambiumEthRXBytes — Ethernet RX counter
    txBytes64:  '1.3.6.1.4.1.17713.21.2.1.8.0',   // cambiumEthTXBytes — Ethernet TX counter
    cpuLoad:    '1.3.6.1.4.1.17713.21.2.1.64.0',  // sysCPUUsage
};

// Standard IF-MIB OIDs for non-Cambium devices (e.g., Aruba).
// These require the interface index (ifIndex) to be appended.
const ARUBA_OIDS = {
    sysUpTime:  '1.3.6.1.2.1.1.3.0',             // Standard SNMPv2 sysUpTime
    rxBytes64:  '1.3.6.1.2.1.31.1.1.1.6.',        // IF-MIB ifHCInOctets base (append ifIndex)
    txBytes64:  '1.3.6.1.2.1.31.1.1.1.10.',       // IF-MIB ifHCOutOctets base (append ifIndex)
};

async function pollDevice(device) {
    return new Promise((resolve, reject) => {
        const session = snmp.createSession(device.ip, device.community, { version: device.version });

        // Select the correct OID set based on device type
        const isCambium = device.type === 'Cambium';
        const oids = isCambium ? CAMBIUM_OIDS : ARUBA_OIDS;

        // Cambium counters are scalar (no ifIndex needed).
        // Aruba uses standard IF-MIB which requires appending the ifIndex.
        const deviceRxOid = isCambium ? oids.rxBytes64 : oids.rxBytes64 + device.ifIndex;
        const deviceTxOid = isCambium ? oids.txBytes64 : oids.txBytes64 + device.ifIndex;

        const oidsToFetch = [oids.sysUpTime, deviceRxOid, deviceTxOid];
        // Only SM-role Cambium devices expose the RSSI/SNR scalar OIDs.
        // AP-role devices do not have these and will return NoSuchInstance.
        if (isCambium && device.role === 'SM') {
            oidsToFetch.push(oids.rssi, oids.snr);
        }

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
                        if (vb.oid === oids.sysUpTime) metrics.uptime = vb.value;
                        if (isCambium && vb.oid === oids.rssi) metrics.rssi = vb.value;
                        if (isCambium && vb.oid === oids.snr) metrics.snr = vb.value;

                        // net-snmp returns 64-bit counters as Buffers. We convert them to standard Numbers for math.
                        if (vb.oid === deviceRxOid) currentRxBytes = Number('0x' + vb.value.toString('hex'));
                        if (vb.oid === deviceTxOid) currentTxBytes = Number('0x' + vb.value.toString('hex'));
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