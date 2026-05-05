/*
 * TESTING INSTRUCTIONS:
 * 1. Open Chrome and go to chrome://extensions
 * 2. Enable Developer Mode (toggle in top right)
 * 3. Click "Load unpacked"
 * 4. Select the drewery-extension folder
 * 5. Open claude.ai in a new tab
 * 6. Start or open a conversation with at least one exchange
 * 7. Click The Drewery icon in the Chrome toolbar
 * 8. Open a new Claude chat tab
 * 9. Paste (Cmd+V or Ctrl+V)
 * 10. Verify the framing text and conversation appear correctly
 */

/**
 * background.js
 * Portility — Manifest V3 service worker.
 *
 * Responsibilities:
 * 1. Listen for CONVERSATION_STATUS from content.js → toggle icon.
 * 2. On EXTRACTION_SUCCESS → show green checkmark for 2 s then revert.
 * 3. Track PostHog analytics events.
 *
 * Note: Extraction is triggered from popup.js — the popup owns the click action.
 */

'use strict';

// ─── Icon sets ────────────────────────────────────────────────────────────────
const ICONS = {
  active: {
    16: 'icons/icon16_active.png',
    48: 'icons/icon48_active.png',
    128: 'icons/icon128_active.png',
  },
  gray: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  check: {
    16: 'icons/icon16_check.png',
    48: 'icons/icon48_check.png',
    128: 'icons/icon128_check.png',
  },
};

// ─── Analytics ────────────────────────────────────────────────────────────────
// Minimal inline PostHog capture — no content script dependency needed here.
const POSTHOG_API_KEY = 'phc_Am8QxJfBbaSQVfEbANuaPVWWfeEWoKQEqK7QKo38Y9fD';
const POSTHOG_HOST = 'https://app.posthog.com';

// Persistent distinct_id stored in chrome.storage.local
let _distinctId = null;

async function getDistinctId() {
  if (_distinctId) return _distinctId;
  try {
    const data = await chrome.storage.local.get('drewery_distinct_id');
    if (data.drewery_distinct_id) {
      _distinctId = data.drewery_distinct_id;
    } else {
      _distinctId =
        'drewery-bg-' +
        Math.random().toString(36).slice(2) +
        '-' +
        Date.now().toString(36);
      await chrome.storage.local.set({ drewery_distinct_id: _distinctId });
    }
  } catch (e) {
    _distinctId = 'drewery-bg-fallback';
  }
  return _distinctId;
}

async function trackEvent(eventName, properties) {
  if (!POSTHOG_API_KEY || POSTHOG_API_KEY === 'INSERT_POSTHOG_API_KEY_HERE') {
    return;
  }
  try {
    const distinctId = await getDistinctId();
    const payload = {
      api_key: POSTHOG_API_KEY,
      event: eventName,
      distinct_id: distinctId,
      properties: Object.assign(
        { $lib: 'drewery-extension', $lib_version: '1.0.0' },
        properties || {}
      ),
      timestamp: new Date().toISOString(),
    };
    fetch(POSTHOG_HOST + '/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {
    // Never let analytics break the extension
  }
}

// ─── Icon helpers ─────────────────────────────────────────────────────────────
function setIcon(tabId, iconSet, title) {
  chrome.action.setIcon({ tabId, path: ICONS[iconSet] }, () => {
    void chrome.runtime.lastError; // suppress errors if tab closed
  });
  if (title) {
    chrome.action.setTitle({ tabId, title }, () => {
      void chrome.runtime.lastError;
    });
  }
}

// Track per-tab revert timers so rapid clicks don't stack
const checkmarkTimers = new Map();

function showCheckmark(tabId) {
  // Clear any pending revert
  if (checkmarkTimers.has(tabId)) {
    clearTimeout(checkmarkTimers.get(tabId));
  }

  setIcon(tabId, 'check', 'Copied to clipboard!');

  const timer = setTimeout(() => {
    setIcon(tabId, 'active', 'Extract conversation');
    checkmarkTimers.delete(tabId);
  }, 2000);

  checkmarkTimers.set(tabId, timer);
}

// ─── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (message, sender) {
  const tabId = sender && sender.tab && sender.tab.id;

  if (message.type === 'CONVERSATION_STATUS') {
    if (tabId == null) return;
    if (message.hasConversation) {
      setIcon(tabId, 'active', 'Extract conversation');
    } else {
      setIcon(tabId, 'gray', 'Open a conversation to use Portility');
    }
    return;
  }

  if (message.type === 'EXTRACTION_SUCCESS') {
    if (tabId != null) {
      showCheckmark(tabId);
    }
    trackEvent('drewery_extract_success', {
      message_count: message.messageCount || 0,
    });
    return;
  }

  if (message.type === 'EXTRACTION_FAILED') {
    trackEvent('drewery_extract_failed', {
      error: message.error || 'unknown',
    });
    return;
  }
});

// ─── Toolbar click ────────────────────────────────────────────────────────────
// Extraction is now triggered from popup.js — the popup owns the click action.
// background.js continues to manage icon state and analytics only.
