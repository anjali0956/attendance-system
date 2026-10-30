#!/bin/bash
# One-time setup for a fresh Ubuntu 24.04 DigitalOcean Droplet.
# Run as root:  bash setup.sh <public-git-repo-url> <admin-password>
# The admin password must use letters and numbers only.
set -e
REPO="$1"; PASS="$2"
if [ -z "$REPO" ] || [ -z "$PASS" ]; then echo "Usage: bash setup.sh <repo-url> <admin-password>"; exit 1; fi
if ! [[ "$PASS" =~ ^[A-Za-z0-9]{10,}$ ]]; then echo "Password: letters and numbers only, at least 10 characters."; exit 1; fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
# A new Droplet often runs its own updates for the first few minutes, so wait for them.
APT="apt-get -o DPkg::Lock::Timeout=300"

$APT update
$APT install -y curl git gnupg ufw build-essential python3 debian-keyring debian-archive-keyring apt-transport-https

IP=$(curl -fsS https://api.ipify.org)
if ! [[ "$IP" =~ ^[0-9.]+$ ]]; then echo "Couldn't find this server's public IP address."; exit 1; fi
HOST="${IP}.sslip.io"     # free hostname that points at your IP, so HTTPS works without buying a domain

# Extra memory on disk, so installing works on the smallest Droplet
if [ -z "$(swapon --show)" ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
$APT install -y nodejs

# Caddy (web server that gets a free HTTPS certificate automatically)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
$APT update
$APT install -y caddy

# App code
rm -rf /opt/attendance
git clone "$REPO" /opt/attendance
cd /opt/attendance/server
npm ci --omit=dev

# Settings. ALLOW_UNVERIFIED=1 is for testing with a sideloaded APK.
# Remove that line once the app is installed from Google Play and the Google setup is done.
cat > /etc/attendance.env <<ENV
ADMIN_PASSWORD=${PASS}
PACKAGE_NAME=com.example.attendance
ALLOW_UNVERIFIED=1
DB_FILE=/var/lib/attendance/attendance.db
HOST=127.0.0.1
PORT=3000
ENV
chmod 600 /etc/attendance.env

id attendance >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin attendance
cat > /etc/systemd/system/attendance.service <<UNIT
[Unit]
Description=Attendance server
After=network.target

[Service]
User=attendance
WorkingDirectory=/opt/attendance/server
EnvironmentFile=/etc/attendance.env
ExecStart=/usr/bin/node server.js
Restart=always
StateDirectory=attendance

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now attendance

cat > /etc/caddy/Caddyfile <<CADDY
${HOST} {
    reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl restart caddy

# Firewall: only SSH and the web server can be reached from outside
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443
ufw --force enable

# The dashboard should answer "please sign in" (401) if the server is running
sleep 3
STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/admin || true)
if [ "$STATUS" != "401" ]; then
  echo "The server did not start properly (got: ${STATUS}). See:  journalctl -u attendance -n 50"
  exit 1
fi

echo
echo "Done. Your server address is:  https://${HOST}"
echo "Manager dashboard:             https://${HOST}/admin   (any username, your password)"
echo "To update later:  cd /opt/attendance && git pull && cd server && npm ci --omit=dev && systemctl restart attendance"
