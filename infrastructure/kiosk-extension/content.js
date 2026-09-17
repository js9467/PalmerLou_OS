(function() {
  // Auto-show virtual keyboard when any text input is focused (critical for touchscreen kiosk)
  document.addEventListener('focusin', function(e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      if (navigator.virtualKeyboard) {
        navigator.virtualKeyboard.overlaysContent = false;
        navigator.virtualKeyboard.show();
      }
    }
  }, true);

  // Don't inject home button on Palmer Lou itself
  if (window.location.hostname === '127.0.0.1' && window.location.port === '8787') {
    return;
  }

  function goHome(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    // The backend minimizes this window and raises Palmer Lou via xdotool — no navigation needed.
    fetch('http://127.0.0.1:8787/api/launch/return', {
      method: 'POST',
      cache: 'no-store',
      mode: 'no-cors'
    }).catch(function() {});
  }

  function ensureButton() {
    if (document.getElementById('palmer-lou-home-btn')) { return; }
    if (!document.body) { return; }
    var btn = document.createElement('div');
    btn.id = 'palmer-lou-home-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Return to Palmer Lou');
    btn.textContent = '\u2302';
    btn.addEventListener('click', goHome, true);
    btn.addEventListener('touchend', goHome, true);
    btn.addEventListener('pointerup', goHome, true);
    document.body.appendChild(btn);
  }

  ensureButton();
  setInterval(ensureButton, 1000);

  var _push = history.pushState;
  history.pushState = function() { _push.apply(this, arguments); setTimeout(ensureButton, 100); };
  window.addEventListener('popstate', function() { setTimeout(ensureButton, 100); });
})();
