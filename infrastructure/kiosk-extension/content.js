(function() {
  var CURSOR_STYLE_ID = 'palmer-lou-cursor-style';
  var CURSOR_DOT_ID = 'palmer-lou-cursor-dot';

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

  function ensureCursorStyle() {
    if (document.getElementById(CURSOR_STYLE_ID)) {
      return;
    }

    var style = document.createElement('style');
    style.id = CURSOR_STYLE_ID;
    style.textContent = [
      "html, body, * { cursor: none !important; }",
      "#" + CURSOR_DOT_ID + " {",
      "  position: fixed;",
      "  left: 0; top: 0;",
      "  width: 24px; height: 24px;",
      "  border-radius: 50%;",
      "  pointer-events: none;",
      "  z-index: 2147483647;",
      "  transform: translate(-50%, -50%);",
      "  background: radial-gradient(circle at 50% 50%, rgba(226, 248, 255, 0.98) 0 30%, rgba(57, 208, 255, 0.96) 31% 56%, rgba(24, 126, 186, 0.96) 57% 100%);",
      "  box-shadow: 0 0 0 8px rgba(57, 208, 255, 0.26), 0 0 24px rgba(57, 208, 255, 0.86);",
      "}",
      "#" + CURSOR_DOT_ID + ".hidden { opacity: 0; }"
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureCursorDot() {
    var dot = document.getElementById(CURSOR_DOT_ID);
    if (dot) {
      return dot;
    }

    dot = document.createElement('div');
    dot.id = CURSOR_DOT_ID;
    dot.className = 'hidden';
    document.body.appendChild(dot);
    return dot;
  }

  function attachCursorTracking() {
    var dot = ensureCursorDot();
    function moveTo(clientX, clientY) {
      dot.style.left = clientX + 'px';
      dot.style.top = clientY + 'px';
      dot.classList.remove('hidden');
    }

    document.addEventListener('mousemove', function(ev) {
      moveTo(ev.clientX, ev.clientY);
    }, true);

    document.addEventListener('pointermove', function(ev) {
      moveTo(ev.clientX, ev.clientY);
    }, true);

    document.addEventListener('mouseleave', function() {
      dot.classList.add('hidden');
    }, true);
  }

  var returnInFlight = false;

  function goHome() {
    if (returnInFlight) {
      return;
    }
    returnInFlight = true;
    setTimeout(function() { returnInFlight = false; }, 1500);

    // Route through the extension background worker so the request is not blocked
    // by the host page's Content-Security-Policy (e.g. YouTube/Netflix connect-src).
    try {
      chrome.runtime.sendMessage({ type: 'palmer-lou:return-home' }, function() {
        // Access lastError to avoid "Unchecked runtime.lastError" noise.
        void chrome.runtime.lastError;
      });
    } catch (err) {
      /* extension context unavailable */
    }
  }

  function ensureHomeButton() {
    if (document.getElementById('palmer-lou-home-btn')) {
      return;
    }
    if (!document.body) {
      return;
    }

    var btn = document.createElement('div');
    btn.id = 'palmer-lou-home-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Return to Palmer Lou home');
    btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 11.2 12 4l9 7.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 9.8V19a1 1 0 0 0 1 1H10v-5h4v5h3.5a1 1 0 0 0 1-1V9.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var handler = function(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      goHome();
    };
    btn.addEventListener('click', handler, true);
    btn.addEventListener('touchend', handler, true);

    document.body.appendChild(btn);
  }

  ensureCursorStyle();
  attachCursorTracking();
  ensureHomeButton();
  setInterval(ensureCursorStyle, 1500);
  setInterval(ensureCursorDot, 1500);
  setInterval(ensureHomeButton, 1000);

  var _push = history.pushState;
  history.pushState = function() { _push.apply(this, arguments); setTimeout(ensureHomeButton, 100); };
  window.addEventListener('popstate', function() { setTimeout(ensureHomeButton, 100); });
})();
