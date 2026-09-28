# TRATA CRM

Your own lead CRM at **https://crm.tratadigital.com**. It runs on your AWS server with a login for each team member. There are no monthly fees and no lead limits.

```
Instagram ad → Meta Instant Form → Google Sheet (already working) → CRM (every 5 min)
```

**What the team can do**
- **Dashboard:** new leads today, hot leads waiting, follow-ups due, win rate, and a "Do today" list.
- **Leads:** search and filter by status, priority, person, or due follow-ups.
- **Pipeline:** a board with a column for each status.
- **Lead page:** one-tap WhatsApp and Call buttons, plus status, follow-up date, assigned person and notes. There is also a full history of who did what and when.
- **Team (admins only):** add people, reset passwords, and deactivate people who leave.
- **Admins** can download all leads as CSV and delete leads.
- It works on phones.

---

## Setup (about 20 minutes, one time)

You or your developer needs SSH access to the AWS server (EC2 or Lightsail, Ubuntu 22.04 or 24.04).

### 1. Open ports 80 and 443
- **Lightsail:** Instance → **Networking** → IPv4 Firewall. Make sure **HTTP (80)** and **HTTPS (443)** are listed.
- **EC2:** Instance → **Security** → Security group → Edit inbound rules. Add **HTTP 80** and **HTTPS 443** from anywhere.

### 2. Point the subdomain at the server
Go to your domain's DNS settings (wherever tratadigital.com is managed: GoDaddy, Route 53, Hostinger, and so on). Add one record:

| Type | Name / Host | Value |
|---|---|---|
| A | `crm` | your server's public IP |

To find the public IP, run `curl -s https://checkip.amazonaws.com` on the server. On Lightsail, use a **static IP** so the address doesn't change after a restart.

### 3. Upload and install
On your computer:
```bash
scp trata-crm.zip ubuntu@YOUR_SERVER_IP:~
```
On the server:
```bash
sudo apt-get install -y unzip
unzip trata-crm.zip && cd trata-crm
sudo bash deploy/install.sh crm.tratadigital.com hello@tratadigital.com
```
The script does all of the following:
- installs Node.js and nginx;
- runs the CRM as a background service that restarts on its own;
- sets up HTTPS (a free Let's Encrypt certificate that renews itself);
- turns on a daily database backup.

At the end it prints your **Import key**. Keep it for step 5.

> If step 2 hasn't taken effect yet, the script skips HTTPS and tells you. Wait 10–30 minutes, then run the same command again.

### 4. Create your admin login
```bash
cd /opt/trata-crm && sudo -u trata node scripts/create-admin.js
```
Enter your name, a login ID (for example `aniket`) and a password. The password is hidden as you type it.

Then open **https://crm.tratadigital.com** and log in. Go to the **Team** tab to add Prashant and the others. Give each person their login ID and password privately. Everyone can change their own password from the name menu at the top right.

### 5. Connect the Google Sheet (so leads flow in automatically)
1. Open the lead sheet, then go to **Extensions → Apps Script**.
2. Replace everything in **Code.gs** with `google-sheet/Code.gs` from this folder. This adds two menu items.
3. Click **+ → Script**, name it `CRMPush`, and paste in `google-sheet/CRMPush.gs`.
4. Click **Save**. Reload the Google Sheet.
5. In the sheet, choose **TRATA Leads → Connect to CRM…**
   - Address: `https://crm.tratadigital.com`
   - Import key: the key from step 3
6. Allow the permissions Google asks for. That's the "connect to an external service" permission the script needs to send leads to your CRM.

Every lead already in the sheet goes into the CRM straight away. New leads follow within about 5 minutes. A lead is never added twice.

> The old test files **CRM.gs** and **CRMPage.html** in the same Apps Script project are no longer needed. You can delete them.

---

## Day-to-day

- **Your team works in the CRM.** The Google Sheet is now just the pipe that brings leads in. Status changes made in the CRM are not copied back to the sheet.
- **Forgot the import key?** Run `sudo grep IMPORT_KEY /opt/trata-crm/.env`
- **Locked out as admin?** Run the step 4 command again with the same login ID. It resets the password.
- **Backups:** saved every night in `/opt/trata-crm/backups/` and kept for 14 days. For extra safety, also take a Lightsail/EC2 snapshot now and then.
- **Restore a backup:**
  ```bash
  sudo systemctl stop trata-crm
  sudo cp /opt/trata-crm/backups/crm-YYYY-MM-DD.sqlite /opt/trata-crm/data/crm.sqlite
  sudo chown trata:trata /opt/trata-crm/data/crm.sqlite
  sudo systemctl start trata-crm
  ```
- **Update to a new version:** unzip the new version and run the same `install.sh` command. Your data, logins and key are kept.
- **Logs:** `sudo journalctl -u trata-crm -n 100`

## Security built in
- Passwords are stored as bcrypt hashes. Login sessions are secure, HTTPS-only cookies.
- After 20 wrong login attempts, logins are blocked for 15 minutes.
- Members can view and work leads. Only admins can manage the team, delete leads or export data.
- The app itself is reachable only through nginx and HTTPS. The import endpoint requires the secret key.

## For developers
Node.js 20+, Express 5, SQLite (better-sqlite3). The database is `data/crm.sqlite`.
```bash
npm install
IMPORT_KEY=dev-key-at-least-20-chars COOKIE_SECURE=false npm start   # http://127.0.0.1:3000
npm test                                                             # API tests
```
Import API: `POST /api/import` with header `X-Import-Key` and body `{"leads":[{"lead_id","created_time","name","phone","business","need","start","campaign"}]}`
