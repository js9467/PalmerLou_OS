#!/bin/bash
echo "=== ALL CHROMIUM PROCESSES ==="
for pid in $(pgrep -f chromium); do
  echo "--- PID $pid ---"
  sudo cat /proc/$pid/cmdline 2>/dev/null | tr '\0' ' ' | head -c 500
  echo ""
done

echo ""
echo "=== KIOSK SCRIPT ==="
cat /usr/local/bin/palmer-lou-kiosk.sh

echo ""
echo "=== EXTENSION FILES ==="
ls -la /opt/palmer-lou/infrastructure/kiosk-extension/
cat /opt/palmer-lou/infrastructure/kiosk-extension/manifest.json
