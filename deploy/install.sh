#!/usr/bin/env bash
# TRATA CRM – one-command install / update for an Ubuntu 22.04 or 24.04 server (AWS EC2 or Lightsail).
#
#   sudo bash deploy/install.sh crm.tratadigital.com you@tratadigital.com
#
# Safe to run again later to update the app: your data and .env are kept.
set -euo pipefail

DOMAIN="${1:-crm.tratadigital.com}"
EMAIL="${2:-}"
APP_DIR=/opt/trata-crm
APP_USER=trata
PORT="${PORT:-3000}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mXX  %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo:  sudo bash deploy/install.sh $DOMAIN you@example.com"
[ -f "$SRC_DIR/package.json" ] || die "Run this from inside the unzipped trata-crm folder."
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "This script is written for Ubuntu. You have: ${PRETTY_NAME:-unknown}. Continuing anyway."
if systemctl is-active --quiet apache2 2>/dev/null; then
  die "Apache is running on this server. This script uses nginx. Ask your developer to add a reverse proxy for $DOMAIN -> 127.0.0.1:$PORT in Apache instead."
fi

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# --no-upgrade: never upgrade packages that are already installed (safe on a shared server)
apt-get install -y --no-upgrade ca-certificates curl gnupg nginx build-essential python3 sqlite3 rsync openssl

NODE_MAJOR=0
command -v node >/dev/null && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

say "Creating app user and copying files to $APP_DIR"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$APP_DIR/data" "$APP_DIR/backups"
rsync -a --delete \
  --exclude node_modules --exclude data --exclude backups --exclude .env --exclude test \
  "$SRC_DIR"/ "$APP_DIR"/
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "Installing app dependencies"
cd "$APP_DIR"
# Pass through proxy / extra-certificate settings if this server uses them (normally none).
PASS_ENV=()
for v in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy NODE_EXTRA_CA_CERTS; do
  [ -n "${!v:-}" ] && PASS_ENV+=("$v=${!v}")
done
for v in $(compgen -e | grep '^npm_config_' || true); do PASS_ENV+=("$v=${!v}"); done
sudo -u "$APP_USER" -H env HOME="$APP_DIR" "${PASS_ENV[@]}" npm ci --omit=dev --no-audit --no-fund

if [ ! -f "$APP_DIR/.env" ]; then
  say "Creating $APP_DIR/.env with a new import key"
  cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
COOKIE_SECURE=true
IMPORT_KEY=$(openssl rand -hex 24)
EOF
fi
grep -q '^SETUP_CODE=' "$APP_DIR/.env" || echo "SETUP_CODE=$(openssl rand -hex 4 | tr 'a-f' 'A-F')-$(openssl rand -hex 4 | tr 'a-f' 'A-F')" >> "$APP_DIR/.env"
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

say "Setting up the background service (systemd)"
cat > /etc/systemd/system/trata-crm.service <<EOF
[Unit]
Description=TRATA CRM
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=NODE_ENV=production
ExecStart=$(command -v node) src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable trata-crm >/dev/null
systemctl restart trata-crm
ok=0; for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 1; curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { ok=1; break; }; done
[ "$ok" = 1 ] || { journalctl -u trata-crm -n 40 --no-pager; die "The app did not start. See the log above."; }
echo "App is running on 127.0.0.1:$PORT"

say "Configuring nginx for $DOMAIN"
LISTEN6=""
[ -f /proc/net/if_inet6 ] && LISTEN6="listen [::]:80;"
cat > /etc/nginx/sites-available/trata-crm <<EOF
server {
    listen 80;
    $LISTEN6
    server_name $DOMAIN;
    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/trata-crm /etc/nginx/sites-enabled/trata-crm
nginx -t
systemctl reload nginx
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 'Nginx Full' >/dev/null; fi

say "Daily database backup (keeps 14 days)"
cat > /etc/cron.daily/trata-crm-backup <<EOF
#!/bin/sh
set -e
cd $APP_DIR
sqlite3 data/crm.sqlite ".backup 'backups/crm-\$(date +%F).sqlite'"
chown $APP_USER:$APP_USER backups/*.sqlite
find backups -name 'crm-*.sqlite' -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/trata-crm-backup

say "HTTPS certificate"
PUBLIC_IP="$(curl -fsS --max-time 5 https://checkip.amazonaws.com || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ -z "$EMAIL" ]; then
  warn "No email given, so HTTPS was skipped. Run again with your email as the 2nd argument once DNS is ready."
elif [ -z "$DNS_IP" ] || [ "$DNS_IP" != "$PUBLIC_IP" ]; then
  warn "$DOMAIN points to '${DNS_IP:-nothing}', but this server is '$PUBLIC_IP'."
  warn "Add a DNS 'A' record:  crm  ->  $PUBLIC_IP   then run this script again for HTTPS."
else
  apt-get install -y --no-upgrade certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
  echo "HTTPS is on. Certificates renew automatically."
fi

USERS="$(sudo -u "$APP_USER" sqlite3 "$APP_DIR/data/crm.sqlite" 'SELECT COUNT(*) FROM users;' 2>/dev/null || echo 0)"
say "Done"
echo "CRM address : https://$DOMAIN"
echo "Import key  : $(grep ^IMPORT_KEY= "$APP_DIR/.env" | cut -d= -f2)   (paste this into the Google Sheet: TRATA Leads -> Connect to CRM...)"
if [ "$USERS" = "0" ]; then
  echo
  echo "Next: open https://$DOMAIN and create your admin login there."
  echo "Setup code  : $(grep ^SETUP_CODE= "$APP_DIR/.env" | cut -d= -f2)"
fi
