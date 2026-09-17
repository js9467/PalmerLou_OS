#!/bin/bash
echo "=== Launch and immediately watch for process ==="
pkill -9 -f "palmer-lou-apps/youtube-tv" 2>/dev/null || true
sleep 0.5

cat > /tmp/ytv.json << 'EOF'
{"appId":"youtube-tv","name":"YouTube TV","launchUrl":"https://tv.youtube.com/","launchLabel":"YouTube TV","requestSource":"kiosk"}
EOF

curl -s -X POST http://127.0.0.1:8787/api/launch/app \
  -H "Content-Type: application/json" -d @/tmp/ytv.json > /dev/null &

# Watch for the process every 0.5s for 8 seconds
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
  sleep 0.5
  PROCS=$(pgrep -af "youtube-tv" 2>/dev/null | grep -v "pgrep\|diag\|grep" | head -3)
  if [ -n "$PROCS" ]; then
    echo "[${i}x0.5s] FOUND: $PROCS"
  else
    echo "[${i}x0.5s] no youtube-tv process"
  fi
done

echo ""
echo "=== Journal for chromium/youtube-tv (last 30 lines) ==="
journalctl --no-pager -n 50 2>/dev/null | grep -i "chromium\|youtube-tv\|scope\|crash\|killed\|signal" | tail -20
