#!/bin/bash
set -e

# Write valid JSON
cat > /tmp/ytv.json << 'EOF'
{"appId":"youtube-tv","name":"YouTube TV","launchUrl":"https://tv.youtube.com/","launchLabel":"YouTube TV","requestSource":"kiosk"}
EOF

echo "=== Killing any running app processes ==="
pkill -f palmer-lou-apps 2>/dev/null || true
sleep 1

echo "=== Launching YouTube TV via API ==="
RESPONSE=$(curl -s -X POST http://127.0.0.1:8787/api/launch/app \
  -H 'Content-Type: application/json' \
  -d @/tmp/ytv.json)
echo "$RESPONSE"

sleep 3

echo ""
echo "=== Running processes after launch ==="
pgrep -af palmer-lou-apps 2>/dev/null || echo "no palmer-lou-apps processes"

echo ""
echo "=== Built launch command (from launcher.js) ==="
# Check what command the compiled code would produce
node -e "
const env = process.env;
const cmds = JSON.parse(env.PALMER_LOU_LAUNCH_COMMANDS || '{}');
const cmd = cmds['youtube-tv'];
console.log('configured command:', cmd);
" 2>/dev/null || true

echo ""
echo "=== Check for Singleton lock ==="
ls -la /home/palmerlou/snap/chromium/common/palmer-lou-apps/youtube-tv/Default/Singleton* 2>/dev/null || echo "no singleton lock"

echo ""
echo "=== Last 10 lines of syslog (Chromium crashes) ==="
journalctl -n 20 --no-pager 2>/dev/null | grep -i 'chromium\|crash\|youtube' | tail -10 || echo "none"
