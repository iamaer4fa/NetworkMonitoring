const { Client } = require('pg');
const nodemailer = require('nodemailer');
require('dotenv').config();

// SMTP Configuration (Port 25, No Auth)
const transporter = nodemailer.createTransport({
    host: 'smpc.steniel.com.ph',
    port: 25,
    secure: false, // Must be false for port 25
    tls: {
        // Do not fail on invalid certs if your internal relay uses self-signed certificates
        rejectUnauthorized: false
    }
});

// Simple HTML escaping helper to prevent HTML injection
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Email Dispatch Function
async function sendEmailAlert(payload) {
    const isDown = payload.is_link_up === false;
    const isResolved = payload.status === 'RESOLVED';

    let emailBody = '';
    const sourceSite = escapeHtml(payload.source_site || '');
    const targetSite = escapeHtml(payload.target_site || '');
    const hardware = escapeHtml(payload.hardware || '');
    const frequency = escapeHtml(payload.frequency || '');
    
    const rssi = (payload.rssi_dbm !== null && payload.rssi_dbm !== undefined) 
        ? payload.rssi_dbm + ' dBm' 
        : (isDown ? 'UNREACHABLE' : 'N/A');
    const snr = (payload.snr_db !== null && payload.snr_db !== undefined) 
        ? payload.snr_db + ' dB' 
        : 'N/A';
        
    const timestampStr = payload.timestamp 
        ? new Date(payload.timestamp).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) 
        : new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });

    let subjectLine = `[${payload.severity}] Network Alert [${payload.status}]: ${sourceSite} to ${targetSite}`;

    if (payload.event === 'CAPACITY_EXHAUSTION') {
        if (isResolved) {
            emailBody = `
                <h2 style="color: #5cb85c;">Bandwidth Congestion Resolved</h2>
                <p>Traffic on the link between <strong>${sourceSite}</strong> and <strong>${targetSite}</strong> has dropped below the 90% utilization threshold.</p>
                <ul>
                    <li><strong>Max Link Capacity:</strong> ${payload.max_capacity} Mbps</li>
                    <li><strong>Current Throughput:</strong> <span style="color: #5cb85c; font-weight:bold;">${payload.current_throughput ? payload.current_throughput.toFixed(2) : '0.00'} Mbps</span></li>
                    <li><strong>Timestamp:</strong> ${timestampStr}</li>
                </ul>
                <br>
                <p style="font-size: 12px; color: #666;"><em>This is an automated message generated from MIS Steniel.</em></p>
            `;
        } else {
            emailBody = `
                <h2 style="color: #f0ad4e;">Bandwidth Capacity Exhausted (15+ Minutes)</h2>
                <p>The link between <strong>${sourceSite}</strong> and <strong>${targetSite}</strong> has exceeded 90% utilization for three consecutive polling cycles.</p>
                <p>This may result in high latency or dropped VoIP packets. Please investigate for unusual data transfers or consider traffic shaping (QoS).</p>
                <ul>
                    <li><strong>Max Link Capacity:</strong> ${payload.max_capacity} Mbps</li>
                    <li><strong>Current Sustained Throughput:</strong> <span style="color: #d9534f; font-weight:bold;">${payload.current_throughput ? payload.current_throughput.toFixed(2) : '0.00'} Mbps</span></li>
                    <li><strong>Timestamp:</strong> ${timestampStr}</li>
                </ul>
                <br>
                <p style="font-size: 12px; color: #666;"><em>This is an automated message generated from MIS Steniel.</em></p>
            `;
        }
    } else if (payload.event === 'LINK_DEGRADATION') {
        if (isResolved) {
            emailBody = `
                <h2 style="color: #5cb85c;">Network Link Resolved (Healed)</h2>
                <p>The automated monitoring system has detected that the link has returned to normal operational status.</p>
                
                <h3 style="border-bottom: 1px solid #ccc; padding-bottom: 5px;">Location & Hardware Detail</h3>
                <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%; max-width: 600px;">
                    <tr>
                        <td style="background-color: #f8f9fa; width: 35%;"><strong>Impacted Route</strong></td>
                        <td><strong>${sourceSite} ➔ ${targetSite}</strong></td>
                    </tr>
                    <tr>
                        <td style="background-color: #f8f9fa;"><strong>Hardware Model</strong></td>
                        <td>${hardware}</td>
                    </tr>
                    <tr>
                        <td style="background-color: #f8f9fa;"><strong>Operating Frequency</strong></td>
                        <td>${frequency ? frequency + ' GHz' : 'N/A'}</td>
                    </tr>
                </table>

                <h3 style="border-bottom: 1px solid #ccc; padding-bottom: 5px; margin-top: 20px;">Telemetry Data</h3>
                <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%; max-width: 600px;">
                    <tr>
                        <td style="background-color: #f8f9fa; width: 35%;"><strong>Current RSSI</strong></td>
                        <td><strong style="color: #5cb85c;">${rssi}</strong></td>
                    </tr>
                    <tr>
                        <td style="background-color: #f8f9fa;"><strong>Current SNR</strong></td>
                        <td>${snr}</td>
                    </tr>
                    <tr>
                        <td style="background-color: #f8f9fa;"><strong>Timestamp</strong></td>
                        <td>${timestampStr}</td>
                    </tr>
                </table>
                <br>
                <p style="font-size: 12px; color: #666;"><em>This is an automated message generated from MIS Steniel.</em></p>
            `;
        } else {
            emailBody = `
                <h2 style="color: ${isDown ? '#d9534f' : '#f0ad4e'};">Network Link Alert Triggered</h2>
                <p>The automated monitoring system has detected an anomaly requiring technician attention.</p>
                
                <h3 style="border-bottom: 1px solid #ccc; padding-bottom: 5px;">Location & Hardware Detail</h3>
                <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%; max-width: 600px;">
                    <tr>
                        <td style="background-color: #f8f9fa; width: 35%;"><strong>Impacted Route</strong></td>
                        <td><strong>${sourceSite} ➔ ${targetSite}</strong></td>
                    </tr>
                    <tr>
                        <td style="background-color: #f8f9fa;"><strong>Hardware Model</strong></td>
                        <td>${hardware}</td>
                    </tr>
                    <tr>
                        <td style="background-color: #f8f9fa;"><strong>Operating Frequency</strong></td>
                        <td>${frequency ? frequency + ' GHz' : 'N/A'}</td>
                    </tr>
                </table>

                <h3 style="border-bottom: 1px solid #ccc; padding-bottom: 5px; margin-top: 20px;">Telemetry Data</h3>
                <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%; max-width: 600px;">
                    <tr>
                        <td style="background-color: #f8f9fa; width: 35%;"><strong>Current RSSI</strong></td>
                        <td><strong style="color: ${isDown ? '#d9534f' : '#f0ad4e'};">${rssi}</strong></td>
                    </tr>
                    <tr>
                        <td style="background-color: #f8f9fa;"><strong>Current SNR</strong></td>
                        <td>${snr}</td>
                    </tr>
                    <tr>
                        <td style="background-color: #f8f9fa;"><strong>Timestamp</strong></td>
                        <td>${timestampStr}</td>
                    </tr>
                </table>
                <br>
                <p style="font-size: 12px; color: #666;"><em>This is an automated message generated from MIS Steniel.</em></p>
            `;
        }
    }

    const mailOptions = {
        from: '"Network Monitoring System - NO REPLY" <network-alerts@steniel.com.ph>',
        to: process.env.ALERT_TO || 'mis@steniel.com.ph',
        cc: process.env.ALERT_CC || 'allan.registos@steniel.com.ph',
        subject: subjectLine,
        html: emailBody
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email Sent] Alert delivered to ${mailOptions.to} (Message ID: ${info.messageId})`);
    } catch (error) {
        console.error(`[Email Failed] Could not route through smpc.steniel.com.ph:`, error.message);
    }
}

let client;
let isReconnecting = false;

function createClient() {
    client = new Client({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: parseInt(process.env.DB_PORT || '5432'),
    });

    client.on('error', (err) => {
        console.error('Database client error:', err.message);
        reconnect();
    });

    client.on('notification', async (msg) => {
        try {
            const payload = JSON.parse(msg.payload);
            console.log(`\n🚨 ALERT RECEIVED for Link ID ${payload.link_id} [${payload.event} - ${payload.status}] 🚨`);
            // Trigger the email
            await sendEmailAlert(payload);
        } catch (e) {
            console.error('Error processing notification payload:', e.message);
        }
    });
}

async function reconnect() {
    if (isReconnecting) return;
    isReconnecting = true;
    console.log("Attempting to connect/reconnect to database...");

    try {
        if (client) {
            await client.end().catch(() => {});
        }
    } catch (e) {}

    let delay = 1000;
    while (true) {
        try {
            createClient();
            await client.connect();
            await client.query('LISTEN network_alerts');
            console.log("Connected to PostgreSQL. Listening for network alerts...");
            isReconnecting = false;
            break;
        } catch (err) {
            console.error(`Database connection failed: ${err.message}. Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, 60000); // Max 60 seconds delay
        }
    }
}

// Start the listener
reconnect();