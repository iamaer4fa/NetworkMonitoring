# Network Monitoring System

A Node.js-based network monitoring and alerting system designed to track network link metrics via SNMP and dispatch automated email alerts using PostgreSQL triggers.

## Overview

This project consists of two main components:

1. **SNMP Poller (`monitor.js`)**
   - Polls network devices (e.g., Cambium access points and gateways) every 5 minutes using SNMP.
   - Collects telemetry data including Uptime, RSSI, SNR, and RX/TX bandwidth metrics.
   - Saves the gathered metrics to a PostgreSQL database (`link_metrics` table).

2. **Alert Manager (`alert_manager.js`)**
   - Runs as a persistent service listening for `network_alerts` notifications from PostgreSQL (via the `LISTEN` command).
   - Receives payloads triggered by database conditions (e.g., bandwidth capacity exhaustion, link degradation, or link downtime).
   - Dispatches formatted HTML email alerts to the IT/MIS team via an internal SMTP relay using Nodemailer.

## Prerequisites

- Node.js
- PostgreSQL Database
- Network devices supporting SNMP (configured with appropriate community strings)
- SMTP Server (for email alerts)

## Installation

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables. Create a `.env` file in the root directory based on your environment:
   ```env
   DB_USER=your_db_user
   DB_HOST=your_db_host
   DB_NAME=your_db_name
   DB_PASSWORD=your_db_password
   DB_PORT=5432
   COMMUNITY_STRING=your_snmp_community_string
   ```

3. Ensure your PostgreSQL database is set up with the required tables (`link_metrics`, `ptp_links`) and trigger functions that `NOTIFY network_alerts`. Check the `Backend/` directory for database migration scripts.

## Usage

### Running the Poller
To start the SNMP polling script (runs continuously with a 5-minute interval):
```bash
node monitor.js
```

### Running the Alert Manager
To start listening for database triggers and sending email notifications:
```bash
node alert_manager.js
```

## Dependencies
- `net-snmp`: For SNMP polling
- `pg`: PostgreSQL client
- `nodemailer`: For sending email notifications
- `dotenv`: For environment variable management

## License
ISC
