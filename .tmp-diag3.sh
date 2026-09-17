#!/bin/bash
echo "=== YouTube TV profile state ==="
grep -o '"exit_type":"[^"]*"' /home/palmerlou/snap/chromium/common/palmer-lou-apps/youtube-tv/Default/Preferences 2>/dev/null | head -3
grep -o '"exited_cleanly":[a-z]*' /home/palmerlou/snap/chromium/common/palmer-lou-apps/youtube-tv/Default/Preferences 2>/dev/null | head -3

echo ""
echo "=== Clean and relaunch YouTube TV ==="
# Clear any crashed state from the profile
sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' /home/palmerlou/snap/chromium/common/palmer-lou-apps/youtube-tv/Default/Preferences 2>/dev/null
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' /home/palmerlou/snap/chromium/common/palmer-lou-apps/youtube-tv/Default/Preferences 2>/dev/null
rm -f /home/palmerlou/snap/chromium/common/palmer-lou-apps/youtube-tv/Default/Singleton* 2>/dev/null

echo "Profile cleaned."

echo ""
echo "=== Check looksLikeChromium regex against the configured command ==="
node -e "
const cmd = '/snap/bin/chromium --app=https://tv.youtube.com/';
const lower = cmd.toLowerCase();
const looksLike = /(^|\s)(chromium|chromium-browser|google-chrome|google-chrome-stable|chrome)(\s|$|\/)/.test(lower);
console.log('looksLikeChromium:', looksLike);
" 2>/dev/null

echo ""
echo "=== Try launching YouTube TV via API ==="
cat > /tmp/ytv.json << 'EOF'
{"appId":"youtube-tv","name":"YouTube TV","launchUrl":"https://tv.youtube.com/","launchLabel":"YouTube TV","requestSource":"kiosk"}
EOF
curl -s -X POST http://127.0.0.1:8787/api/launch/app -H "Content-Type: application/json" -d @/tmp/ytv.json
echo ""
sleep 4
echo ""
echo "=== Processes 4s after launch ==="
pgrep -af "palmer-lou-apps/youtube-tv" 2>/dev/null | head -5 || echo "no youtube-tv process"
