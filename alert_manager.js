const { Client } = require('pg');
const nodemailer = require('nodemailer');
const emailAddresses = {
    to: 'mis@steniel.com.ph',
    cc: 'allan.registos@steniel.com.ph',
}

// 1. Database Configuration
const client = new Client({
    user: 'networkguy',
    host: 'localhost',
    database: 'steniel_networks',
    password: 'KljNB6dylVQoxEHoEhmJuAOC',
    port: 5432,
});

// 2. SMTP Configuration (Port 25, No Auth)
const transporter = nodemailer.createTransport({
    host: 'smpc.steniel.com.ph',
    port: 25,
    secure: false, // Must be false for port 25
    tls: {
        // Do not fail on invalid certs if your internal relay uses self-signed certificates
        rejectUnauthorized: false
    }
});

// 3. Email Dispatch Function
async function sendEmailAlert(payload) {
    // Determine the severity based on the payload data
    const isDown = payload.rssi_dbm === null || payload.is_link_up === false;
    const severity = isDown ? 'CRITICAL' : 'WARNING';

    let emailBody = '';
    let subjectLine = `[${payload.severity}] Network Alert: ${payload.source_site} to ${payload.target_site}`;

    if (payload.event === 'CAPACITY_EXHAUSTION') {
        emailBody = `
            <h2 style="color: #f0ad4e;">Bandwidth Capacity Exhausted (15+ Minutes)</h2>
            <p>The link between <strong>${payload.source_site}</strong> and <strong>${payload.target_site}</strong> has exceeded 90% utilization for three consecutive polling cycles.</p>
            <p>This may result in high latency or dropped VoIP packets. Please investigate for unusual data transfers or consider traffic shaping (QoS).</p>
            <ul>
                <li><strong>Max Link Capacity:</strong> ${payload.max_capacity} Mbps</li>
                <li><strong>Current Sustained Throughput:</strong> <span style="color: #d9534f; font-weight:bold;">${payload.current_throughput.toFixed(2)} Mbps</span></li>
                <li><strong>Timestamp:</strong> ${new Date(payload.timestamp).toLocaleString('en-PH')}</li>
            </ul>
        `;
    } else if (payload.event === 'LINK_DEGRADATION') {
        emailBody = `<h2 style="color: ${isDown ? '#d9534f' : '#f0ad4e'};">Network Link Alert Triggered</h2>
            <p>The automated monitoring system has detected an anomaly requiring technician attention.</p>
            
            <h3 style="border-bottom: 1px solid #ccc; padding-bottom: 5px;">Location & Hardware Detail</h3>
            <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%; max-width: 600px;">
                <tr>
                    <td style="background-color: #f8f9fa; width: 35%;"><strong>Impacted Route</strong></td>
                    <td><strong>${payload.source_site} ➔ ${payload.target_site}</strong></td>
                </tr>
                <tr>
                    <td style="background-color: #f8f9fa;"><strong>Hardware Model</strong></td>
                    <td>${payload.hardware}</td>
                </tr>
                <tr>
                    <td style="background-color: #f8f9fa;"><strong>Operating Frequency</strong></td>
                    <td>${payload.frequency} GHz</td>
                </tr>
            </table>

            <h3 style="border-bottom: 1px solid #ccc; padding-bottom: 5px; margin-top: 20px;">Telemetry Data</h3>
            <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%; max-width: 600px;">
                <tr>
                    <td style="background-color: #f8f9fa; width: 35%;"><strong>Current RSSI</strong></td>
                    <td><strong style="color: ${isDown ? '#d9534f' : '#000'};">${payload.rssi_dbm !== null ? payload.rssi_dbm + ' dBm' : 'UNREACHABLE'}</strong></td>
                </tr>
                <tr>
                    <td style="background-color: #f8f9fa;"><strong>Current SNR</strong></td>
                    <td>${payload.snr_db !== null ? payload.snr_db + ' dB' : 'N/A'}</td>
                </tr>
                <tr>
                    <td style="background-color: #f8f9fa;"><strong>Timestamp</strong></td>
                    <td>${new Date(payload.timestamp).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}</td>
                </tr>
            </table>
            <br>
            <p style="font-size: 12px; color: #666;"><em>This is an automated message generated from MIS Steniel.</em></p>
        `;
    }


    const mailOptions = {
        from: '"Network Monitoring System - NO REPLY" <network-alerts@steniel.com.ph>',
        to: emailAddresses.to,
        cc: emailAddresses.cc,
        subject: subjectLine,
        html: emailBody
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email Sent] Alert delivered to mis@steniel.com.ph (Message ID: ${info.messageId})`);
    } catch (error) {
        console.error(`[Email Failed] Could not route through smpc.steniel.com.ph:`, error.message);
    }
}

// 4. Start the Alert Listener
async function startAlertListener() {
    await client.connect();

    client.query('LISTEN network_alerts');
    console.log("Listening for PostgreSQL network alerts...");

    client.on('notification', async (msg) => {
        const payload = JSON.parse(msg.payload);
        console.log(`\n🚨 ALERT RECEIVED for Link ID ${payload.link_id} 🚨`);

        // Trigger the email
        await sendEmailAlert(payload);
    });
}

startAlertListener();