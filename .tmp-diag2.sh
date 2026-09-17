#!/bin/bash
# Check compiled launcher for isVideoApp and buildSafeChromiumAppFlags
echo "=== Checking compiled launcher.js for youtube-tv handling ==="
grep -n 'youtube-tv\|isVideoApp\|kiosk\|buildSafe' /opt/palmer-lou/apps/backend/dist/launcher.js 2>/dev/null | head -20

echo ""
echo "=== Try launching YouTube TV and watch for crash ==="
pkill -f palmer-lou-apps 2>/dev/null || true
sleep 1

# Build the launch command directly from env
source <(sudo cat /etc/palmer-lou/backend.env 2>/dev/null | grep PALMER_LOU_LAUNCH_COMMANDS | head -1)
YTV_CMD=$(node -e "try { const m = JSON.parse(process.env.PALMER_LOU_LAUNCH_COMMANDS || '{}'); console.log(m['youtube-tv'] || 'NOT_FOUND'); } catch(e) { console.log('PARSE_ERROR:' + e.message); }" 2>/dev/null)
echo "Raw configured command for youtube-tv: $YTV_CMD"

echo ""
echo "=== Run the YouTube TV command directly and capture output ==="
XAUTH=$(ls -1 /run/user/*/. mutter-Xwaylandauth.* 2>/dev/null | head -n 1)
echo "XAUTH: $XAUTH"

# Run it with visible output for 5 seconds
timeout 5 sudo -u palmerlou bash -lc "
  XAUTH=\$(ls -1 /run/user/\$(id -u palmerlou)/.mutter-Xwaylandauth.* 2>/dev/null | head -n 1)
  DISPLAY=:0 XAUTHORITY=\"\$XAUTH\" XDG_RUNTIME_DIR=/run/user/\$(id -u palmerlou)
  $YTV_CMD
" 2>&1 | head -30 || true

echo ""
echo "=== Check crash reports ==="
ls -t /home/palmerlou/snap/chromium/common/chromium/Crash\ Reports/attachments/*.dmp 2>/dev/null | head -3 || echo "no crash reports"
ls -t /home/palmerlou/.config/chromium/Crash\ Reports/attachments/*.dmp 2>/dev/null | head -3 || echo "no .config crash reports"
