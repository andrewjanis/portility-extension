/**
 * floating-widget.js
 * Portility — floating action button injected on supported AI chat pages
 * (claude.ai, chatgpt.com, gemini.google.com).
 *
 * Renders a small circular bubble anchored near the message composer (not
 * pinned to the page corner). Clicking it flies out 3 labeled cards, one by
 * one in order, in a diagonal staircase above the bubble (Port My Chat,
 * then Port My Profile, then Second Opinion). Picking one stashes the
 * desired action in chrome.storage.local and asks background.js
 * to open the toolbar popup, which auto-clicks the matching button on load
 * (see popup.js's portility_pending_tool_action handling).
 *
 * Loaded after content-shared.js (for window.portilityTrack from posthog.js)
 * and before the platform-specific content script.
 */

(function () {
  'use strict';

  var PLATFORM = /claude\.ai/i.test(location.hostname)
    ? 'claude'
    : /chatgpt\.com/i.test(location.hostname)
      ? 'chatgpt'
      : /gemini\.google\.com/i.test(location.hostname)
        ? 'gemini'
        : 'unknown';

  // Same brand teal used for "View full comparison" in popup.html.
  var ACCENT_COLOR = '#14b8a6';

  var dismissed = false; // session-only (in-memory), reset on reload/nav
  var menuOpen = false;

  function track(eventName, props) {
    try {
      if (typeof window.portilityTrack === 'function') {
        window.portilityTrack(eventName, props || {});
      }
    } catch (e) { /* non-critical */ }
  }

  function findComposer() {
    if (PLATFORM === 'claude') {
      return document.querySelector('div.ProseMirror[contenteditable="true"]')
        || document.querySelector('div[contenteditable="true"]')
        || document.querySelector('textarea');
    }
    if (PLATFORM === 'chatgpt') {
      return document.querySelector('#prompt-textarea')
        || document.querySelector('div[contenteditable="true"]')
        || document.querySelector('textarea');
    }
    if (PLATFORM === 'gemini') {
      return document.querySelector('.ql-editor[contenteditable="true"]')
        || document.querySelector('rich-textarea div[contenteditable="true"]')
        || document.querySelector('div[contenteditable="true"]')
        || document.querySelector('textarea');
    }
    return null;
  }

  chrome.storage.local.get('portility_floating_widget_enabled', function (result) {
    if (result.portility_floating_widget_enabled === false) return; // explicit opt-out
    init();
  });

  function init() {
    if (dismissed) return;

    var host = document.createElement('div');
    host.id = 'portility-floating-root';
    host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
    document.body.appendChild(host);

    var shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = [
      '.bubble-wrap { position: relative; width: 48px; height: 48px; }',
      '.bubble {',
      '  width: 48px; height: 48px; border-radius: 50%; border: none; padding: 0;',
      '  cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.25); background: transparent;',
      '  display: block;',
      '}',
      '.bubble img { width: 100%; height: 100%; border-radius: 50%; display: block; }',
      '.dismiss-btn {',
      '  position: absolute; top: -4px; right: -4px; width: 14px; height: 14px;',
      '  border-radius: 50%; background: #9ca3af; color: #fff; border: none;',
      '  font-size: 9px; line-height: 14px; text-align: center; padding: 0;',
      '  cursor: pointer; display: none; box-shadow: 0 1px 3px rgba(0,0,0,0.3); z-index: 2;',
      '}',
      '.bubble-wrap:hover .dismiss-btn { display: block; }',
      '.burst { position: absolute; inset: 0; pointer-events: none; }',
      '.burst-item {',
      '  position: absolute; bottom: 4px; right: 4px;',
      '  display: flex; align-items: center; gap: 7px;',
      '  background: #f7f8f9; border-radius: 10px; padding: 9px 14px 9px 12px;',
      '  box-shadow: 0 3px 10px rgba(0,0,0,0.16);',
      '  transform: translate(0, 0) scale(0.5);',
      '  opacity: 0; pointer-events: none;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  font-size: 13px; font-weight: 700; color: ' + ACCENT_COLOR + ';',
      '  white-space: nowrap; cursor: pointer; user-select: none;',
      '  transition: transform 140ms cubic-bezier(.34,1.56,.64,1), opacity 100ms ease;',
      '  transform-origin: bottom right;',
      '}',
      '.burst-item svg { flex-shrink: 0; }',
      '.burst.open .burst-item {',
      '  opacity: 1; pointer-events: auto;',
      '  transform: translate(var(--dx), var(--dy)) scale(1);',
      '}',
    ].join('\n');
    shadow.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'bubble-wrap';

    // Staircase targets: each card flies out to its own spot above/left of
    // the bubble, one at a time in order (chat, then profile, then second
    // opinion) via increasing transition-delay.
    var ICON_CHAT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="' + ACCENT_COLOR + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="' + ACCENT_COLOR + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var ICON_PROFILE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="' + ACCENT_COLOR + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="7" r="4" stroke="' + ACCENT_COLOR + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var ICON_SECOND_OPINION = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" stroke="' + ACCENT_COLOR + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" stroke="' + ACCENT_COLOR + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="17" r=".5" fill="' + ACCENT_COLOR + '" stroke="' + ACCENT_COLOR + '"/></svg>';

    var ITEMS = [
      { action: 'port_chat', label: 'Port My Chat', icon: ICON_CHAT, dx: -130, dy: -60, delay: 0 },
      { action: 'port_profile', label: 'Port My Profile', icon: ICON_PROFILE, dx: -25, dy: -115, delay: 60 },
      { action: 'second_opinion', label: 'Second Opinion', icon: ICON_SECOND_OPINION, dx: 90, dy: -165, delay: 120 },
    ];

    var burst = document.createElement('div');
    burst.className = 'burst';
    ITEMS.forEach(function (item) {
      var el = document.createElement('div');
      el.className = 'burst-item';
      el.dataset.action = item.action;
      el.innerHTML = item.icon + '<span>' + item.label + '</span>';
      el.style.setProperty('--dx', item.dx + 'px');
      el.style.setProperty('--dy', item.dy + 'px');
      el.style.transitionDelay = item.delay + 'ms';
      burst.appendChild(el);
    });

    var bubble = document.createElement('button');
    bubble.className = 'bubble';
    bubble.title = 'Portility';
    var img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/floating-button.png');
    img.alt = 'Portility';
    bubble.appendChild(img);

    var dismissBtn = document.createElement('button');
    dismissBtn.className = 'dismiss-btn';
    dismissBtn.textContent = '\u00d7';
    dismissBtn.title = 'Hide for this page';

    wrap.appendChild(burst);
    wrap.appendChild(bubble);
    wrap.appendChild(dismissBtn);
    shadow.appendChild(wrap);

    bubble.addEventListener('click', function () {
      setMenuOpen(!menuOpen);
    });

    dismissBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      dismissed = true;
      window.removeEventListener('resize', positionHost);
      clearInterval(positionPoll);
      host.remove();
    });

    burst.addEventListener('click', function (e) {
      var item = e.target.closest('.burst-item');
      if (!item) return;
      var action = item.dataset.action;
      chrome.storage.local.set({ portility_pending_tool_action: action });
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP_FOR_ACTION' });
      track('floating_widget_tool_selected', { action: action, platform: PLATFORM });
      setMenuOpen(false);
    });

    document.addEventListener('click', function (e) {
      if (!menuOpen) return;
      if (host.contains(e.target)) return;
      setMenuOpen(false);
    }, true);

    function setMenuOpen(open) {
      menuOpen = open;
      burst.classList.toggle('open', open);
      if (open) track('floating_widget_menu_opened', { platform: PLATFORM });
    }

    // ── Position just below the message composer's bottom-right corner ─────
    // (outside the box, not overlapping it) instead of the page corner.
    //
    // findComposer() only locates the inner editable text node (e.g. the
    // ProseMirror/contenteditable div), not the full visible input card —
    // the card also contains a toolbar (model picker, mic, send button)
    // either beside or below the text, plus padding around it. Using the
    // editable node's own rect directly made the bubble land inside the
    // card, overlapping that toolbar. The toolbar sits to the RIGHT of the
    // text on ChatGPT/Gemini but BELOW it (same width) on Claude, so a
    // purely geometric "wider ancestor" search doesn't generalize. Instead,
    // climb ancestors looking for the nearest one styled like the visible
    // rounded white/opaque card (border-radius + opaque background) and
    // anchor to that.
    function findComposerCardRect() {
      var composer = findComposer();
      if (!composer) return null;
      var rect = composer.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      var node = composer;
      for (var i = 0; i < 10 && node.parentElement; i++) {
        node = node.parentElement;
        var nrect = node.getBoundingClientRect();
        if (nrect.width <= 0 || nrect.height <= 0) continue;
        // Bail once we're clearly past the input card into a much larger
        // page section (e.g. the whole composer+sidebar wrapper).
        if (nrect.height > 220 || nrect.height > rect.height + 160) break;
        var cs = window.getComputedStyle(node);
        var radius = parseFloat(cs.borderTopLeftRadius) || 0;
        var bg = cs.backgroundColor || '';
        var isTransparent = bg === 'transparent' || /rgba\([^)]*,\s*0\s*\)/.test(bg) || bg === '';
        if (radius >= 10 && !isTransparent) {
          return nrect;
        }
      }
      return rect;
    }

    function positionHost() {
      var rowRect = findComposerCardRect();
      var gapBelow = 14;
      if (rowRect) {
        // CSS `bottom` sets the distance from the viewport bottom to the
        // host's OWN bottom edge — it does not account for the host's
        // height, so without subtracting it the 48px-tall bubble extended
        // upward from a point only gapBelow past the row's bottom, overlapping
        // most of the input pill instead of sitting fully below it.
        var hostHeight = host.getBoundingClientRect().height || 48;
        var bottom = Math.max(12, window.innerHeight - rowRect.bottom - gapBelow - hostHeight);
        var right = Math.max(12, window.innerWidth - rowRect.right);
        host.style.bottom = bottom + 'px';
        host.style.right = right + 'px';
        return;
      }
      // Fallback: page corner if composer can't be located yet.
      host.style.bottom = '20px';
      host.style.right = '20px';
    }

    positionHost();
    window.addEventListener('resize', positionHost);
    // Chat SPAs re-render the composer as the sidebar/layout changes; a
    // lightweight poll is simpler and more robust than per-platform observers.
    var positionPoll = setInterval(positionHost, 1000);

    track('floating_widget_shown', { platform: PLATFORM });
  }
})();
