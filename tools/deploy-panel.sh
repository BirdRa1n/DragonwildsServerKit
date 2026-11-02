#!/bin/sh
# Publishes only the panel. The game keeps running and nobody is disconnected;
# panel sessions end, so whoever is logged in must log in again.
#
#   DWK_SSH=root@your-server sh tools/deploy-panel.sh
#
# With --static, only the web files and game data are replaced. The panel keeps running,
# so nobody is logged out. Use it when nothing outside panel/public changed.
#
# Set DWK_SSH_KEY to use a specific SSH key.
set -e
: "${DWK_SSH:?Set DWK_SSH to the server, for example root@your-server}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
SSH="-o BatchMode=yes -o ConnectTimeout=20 ${DWK_SSH_KEY:+-i $DWK_SSH_KEY}"
TMP=$(mktemp -d)
if [ "$1" = "--static" ]; then
  tar --owner=0 --group=0 -czf "$TMP/panel.tgz" -C panel public
  RESTART=""
else
  tar --owner=0 --group=0 -czf "$TMP/panel.tgz" -C panel server.js src public
  RESTART="systemctl restart dwkit-panel; sleep 2"
fi
scp -q $SSH "$TMP/panel.tgz" "$DWK_SSH:/tmp/"
rm -rf "$TMP"
ssh $SSH "$DWK_SSH" "RESTART='$RESTART' sh -s" <<'EOF'
K=/opt/dragonwilds-kit
tar -xzf /tmp/panel.tgz -C $K/panel
rm -f /tmp/panel.tgz
chown -R dragonwilds:dragonwilds $K/panel
eval "$RESTART"
echo "server=$(systemctl is-active dragonwilds) panel=$(systemctl is-active dwkit-panel)"
EOF
