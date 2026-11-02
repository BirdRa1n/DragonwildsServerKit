#!/bin/sh
# Builds the module and publishes module and panel to the server.
# Restarts dragonwilds and dwkit-panel, which DISCONNECTS PLAYERS: warn them first.
#
#   DWK_SSH=root@your-server sh tools/deploy.sh
#
# Set DWK_SSH_KEY to use a specific SSH key.
set -e
: "${DWK_SSH:?Set DWK_SSH to the server, for example root@your-server}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
sh mod/scripts/build.sh 2>&1 | grep -E "error|warning:|libdwkit" | cut -c1-160
SSH="-o BatchMode=yes -o ConnectTimeout=20 ${DWK_SSH_KEY:+-i $DWK_SSH_KEY}"
TMP=$(mktemp -d)
tar --owner=0 --group=0 -czf "$TMP/panel.tgz" -C panel server.js src public
ssh $SSH "$DWK_SSH" 'systemctl stop dwkit-panel dragonwilds; sleep 2'
scp -q $SSH "$TMP/panel.tgz" mod/build/libdwkit.so "$DWK_SSH:/tmp/"
rm -rf "$TMP"
ssh $SSH "$DWK_SSH" sh -s <<'EOF'
K=/opt/dragonwilds-kit
L=/opt/dragonwilds-server/RSDragonwilds/Saved/Logs/RSDragonwilds.log
mv /tmp/libdwkit.so $K/
tar -xzf /tmp/panel.tgz -C $K/panel
rm -f /tmp/panel.tgz
chown -R dragonwilds:dragonwilds $K
rm -f $L
systemctl start dragonwilds
for i in $(seq 1 16); do
  sleep 5
  grep -q "START SESSION - Success" $L 2>/dev/null && break
done
sleep 3
systemctl start dwkit-panel
sleep 2
echo "server=$(systemctl is-active dragonwilds) panel=$(systemctl is-active dwkit-panel)"
echo "join code: $(grep JoinCode $L | tail -n 1 | grep -oE 'value\[[A-Z0-9-]+\]' | tr -d 'value[]')"
EOF
