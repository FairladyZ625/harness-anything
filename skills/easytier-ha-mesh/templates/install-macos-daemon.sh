#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash $0" >&2
  exit 1
fi

SRC_USER="${SUDO_USER:-$USER}"
SRC_HOME="$(dscl . -read "/Users/$SRC_USER" NFSHomeDirectory | awk '{print $2}')"
SRC_BIN_DIR="${EASYTIER_SRC_BIN_DIR:-$SRC_HOME/.local/bin}"
SRC_CFG="${EASYTIER_SRC_CFG:-$SRC_HOME/.config/easytier/config.toml}"

install -d -m 755 /usr/local/bin /etc/easytier /var/log/easytier
install -m 755 "$SRC_BIN_DIR/easytier-core" /usr/local/bin/easytier-core
install -m 755 "$SRC_BIN_DIR/easytier-cli" /usr/local/bin/easytier-cli
install -m 600 "$SRC_CFG" /etc/easytier/config.toml

/usr/local/bin/easytier-core -c /etc/easytier/config.toml --multi-thread true --bind-device true --check-config

PLIST="/Library/LaunchDaemons/com.easytier.ha-edge.plist"
cat > "$PLIST" <<'PLISTEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.easytier.ha-edge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/easytier-core</string>
    <string>-c</string>
    <string>/etc/easytier/config.toml</string>
    <string>--multi-thread</string>
    <string>true</string>
    <string>--bind-device</string>
    <string>true</string>
  </array>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>65536</integer>
  </dict>
  <key>HardResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>65536</integer>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/easytier/ha-edge.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/easytier/ha-edge.log</string>
</dict>
</plist>
PLISTEOF

chown root:wheel "$PLIST"
chmod 644 "$PLIST"

launchctl bootout system/com.easytier.ha-edge 2>/dev/null || true
sleep 1
launchctl bootstrap system "$PLIST"
sleep 3

/usr/local/bin/easytier-cli node
/usr/local/bin/easytier-cli peer
/usr/local/bin/easytier-cli route
