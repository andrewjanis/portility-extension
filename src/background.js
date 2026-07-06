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

// ─── Load shared config & remote-config helpers ──────────────────────────────
importScripts('config.js', 'remote-config.js');

// ─── Remote config refresh (hourly via alarm) ────────────────────────────────
var CONFIG_ALARM_NAME = 'portility_config_refresh';

chrome.alarms.create(CONFIG_ALARM_NAME, { periodInMinutes: 60 });

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === CONFIG_ALARM_NAME) {
    fetchRemoteConfig(PROXY_URL);
  }
});

// Also fetch on startup / install
chrome.runtime.onStartup.addListener(function () {
  fetchRemoteConfig(PROXY_URL);
});

// ─── Dev reload: clear OAuth tokens ──────────────────────────────────────────
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  chrome.identity.clearAllCachedAuthTokens(function () {
    console.log('[BG] Cleared all cached OAuth tokens on reload');
  });
  // Fetch fresh remote config on install/update
  fetchRemoteConfig(PROXY_URL);
});

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
  // If the user is signed in, identify events by Firebase UID (stable across
  // sessions/devices) instead of the anonymous per-install id.
  try {
    const authData = await chrome.storage.local.get('firebase_uid');
    if (authData.firebase_uid) return authData.firebase_uid;
  } catch (e) { /* fall through to anonymous id */ }

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

// Sends a one-time $identify event linking the anonymous distinct_id to the
// Firebase UID (with email as a person property). Guarded by a stored flag
// so it only fires once per signed-in user, not on every event.
async function maybeIdentifyUser() {
  try {
    const data = await chrome.storage.local.get([
      'firebase_uid', 'google_login_hint', 'drewery_distinct_id', 'posthog_identified_uid',
    ]);
    if (!data.firebase_uid || data.posthog_identified_uid === data.firebase_uid) return;
    fetch(POSTHOG_HOST + '/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_API_KEY,
        event: '$identify',
        distinct_id: data.firebase_uid,
        properties: {
          $set: { email: data.google_login_hint || undefined },
          $anon_distinct_id: data.drewery_distinct_id,
        },
        timestamp: new Date().toISOString(),
      }),
      keepalive: true,
    }).catch(() => {});
    chrome.storage.local.set({ posthog_identified_uid: data.firebase_uid });
  } catch (e) { /* non-critical */ }
}

async function trackEvent(eventName, properties) {
  if (!POSTHOG_API_KEY || POSTHOG_API_KEY === 'INSERT_POSTHOG_API_KEY_HERE') {
    return;
  }
  try {
    maybeIdentifyUser(); // fire-and-forget, no-ops after the first call per user
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

// ─── Google Drive auth helpers ────────────────────────────────────────────────
const GDRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

async function checkGDriveAuthBg() {
  return new Promise(function (resolve) {
    chrome.identity.getAuthToken({ interactive: false, scopes: GDRIVE_SCOPES }, function (token) {
      if (chrome.runtime.lastError || !token) {
        resolve({ authenticated: false, accessToken: null });
      } else {
        resolve({ authenticated: true, accessToken: token });
      }
    });
  });
}

async function launchGDriveAuthFlowBg() {
  return new Promise(function (resolve, reject) {
    chrome.identity.getAuthToken({ interactive: true, scopes: GDRIVE_SCOPES }, function (token) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error('No token received from Drive auth'));
      } else {
        resolve({ authenticated: true, accessToken: token });
      }
    });
  });
}

// ─── Download/tab interception helpers ────────────────────────────────────────
function fetchAndCloseTab(tabId, url, sendResponse) {
  console.log('[BG] Fetching from tab URL:', url.substring(0, 150));
  // Close the tab first
  try { chrome.tabs.remove(tabId); } catch (e) {}

  (async function () {
    try {
      var resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var blob = await resp.blob();
      console.log('[BG] Downloaded from tab:', Math.round(blob.size / 1024), 'KB', blob.type);
      var reader = new FileReader();
      reader.onload = function () { sendResponse({ dataUrl: reader.result }); };
      reader.onerror = function () { sendResponse({ error: 'Failed to read blob' }); };
      reader.readAsDataURL(blob);
    } catch (err) {
      console.log('[BG] fetchAndCloseTab error:', err.message);
      sendResponse({ error: err.message || String(err) });
    }
  })();
}

// ─── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  const tabId = sender && sender.tab && sender.tab.id;

  if (message.type === 'CHECK_DRIVE_AUTH') {
    console.log('[BG] CHECK_DRIVE_AUTH received');
    checkGDriveAuthBg()
      .then(function (result) { console.log('[BG] CHECK_DRIVE_AUTH result:', result); sendResponse(result); })
      .catch(function (err) { console.log('[BG] CHECK_DRIVE_AUTH error:', err.message); sendResponse({ authenticated: false, accessToken: null }); });
    return true; // keep channel open for async sendResponse
  }

  if (message.type === 'START_GDRIVE_AUTH') {
    console.log('[BG] START_GDRIVE_AUTH received');
    launchGDriveAuthFlowBg()
      .then(function (result) { console.log('[BG] START_GDRIVE_AUTH result:', result); sendResponse(result); })
      .catch(function (err) { console.log('[BG] START_GDRIVE_AUTH error:', err.message); sendResponse({ authenticated: false, error: err.message }); });
    return true; // keep channel open for async sendResponse
  }

  // Fetch an image URL and return as base64 data URL (bypasses CORS for host_permissions)
  if (message.type === 'FETCH_IMAGE_DATA') {
    (async function () {
      try {
        var resp = await fetch(message.url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var blob = await resp.blob();
        var reader = new FileReader();
        reader.onload = function () { sendResponse({ dataUrl: reader.result }); };
        reader.onerror = function () { sendResponse({ error: 'Failed to read blob' }); };
        reader.readAsDataURL(blob);
      } catch (err) {
        sendResponse({ error: err.message || String(err) });
      }
    })();
    return true;
  }

  // Execute a function in the page's main world (bypasses CSP)
  if (message.type === 'MAIN_WORLD_CLICK') {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function (sel) {
        var el = document.querySelector(sel);
        if (el) { el.click(); return 'clicked'; }
        return 'not_found';
      },
      args: [message.selector],
    }).then(function (results) {
      var result = results && results[0] && results[0].result;
      sendResponse({ result: result });
    }).catch(function (err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  // Click a button in main world with isTrusted shadow via Object.defineProperty,
  // intercepting window.open, <a>.click(), createObjectURL, fetch, AND XMLHttpRequest.
  if (message.type === 'MAIN_WORLD_TRUSTED_CLICK') {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function (sel, eventType) {
        return new Promise(function (resolve) {
          var captured = [];
          var pendingBlobs = 0;
          var b64Chunks = []; // base64 data from batchexecute responses

          function readBlob(blob, entry) {
            pendingBlobs++;
            var r = new FileReader();
            r.onload = function () { entry.dataUrl = r.result; pendingBlobs--; };
            r.onerror = function () { pendingBlobs--; };
            r.readAsDataURL(blob);
          }

          // 1. Patch window.open
          var origOpen = window.open;
          window.open = function (url) {
            if (url) captured.push({ source: 'window.open', url: String(url) });
            return { closed: false, close: function () {}, focus: function () {},
              document: { write: function () {} }, location: {} };
          };

          // 2. Patch fetch
          var origFetch = window.fetch;
          window.fetch = function (url, opts) {
            var urlStr = (typeof url === 'string') ? url : (url && url.url) || '';
            if (urlStr && urlStr.indexOf('http') === 0) {
              captured.push({ source: 'fetch', url: urlStr });
            }
            return origFetch.apply(this, arguments);
          };

          // 3. Patch <a>.click()
          var origAClick = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function () {
            if (this.href) {
              var entry = { source: 'a.click', url: this.href, download: this.download || null };
              captured.push(entry);
              if (this.href.indexOf('blob:') === 0) {
                try { origFetch(this.href).then(function (r) { return r.blob(); })
                  .then(function (b) { readBlob(b, entry); }).catch(function () {}); } catch (e) {}
              }
            }
          };

          // 4. Patch URL.createObjectURL
          var origCreateURL = URL.createObjectURL;
          URL.createObjectURL = function (blob) {
            var blobUrl = origCreateURL.call(URL, blob);
            var entry = { source: 'createObjectURL', url: blobUrl,
              type: blob && blob.type, size: blob && blob.size };
            captured.push(entry);
            if (blob && blob.size > 1000) readBlob(blob, entry);
            return blobUrl;
          };

          // 5. Patch XMLHttpRequest (Angular HttpClient uses XHR by default)
          var origXhrOpen = XMLHttpRequest.prototype.open;
          var origXhrSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function (method, url) {
            this._portilityUrl = String(url);
            this._portilityMethod = method;
            return origXhrOpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.send = function (body) {
            var xhrUrl = this._portilityUrl || '';
            if (xhrUrl) {
              var entry = { source: 'xhr', url: xhrUrl, method: this._portilityMethod };
              captured.push(entry);
              var xhr = this;
              this.addEventListener('load', function () {
                try {
                  // Capture blob/arraybuffer responses (with type!)
                  if (xhr.response instanceof Blob && xhr.response.size > 1000) {
                    entry.type = xhr.response.type; // preserve MIME for image filtering
                    readBlob(xhr.response, entry);
                  } else if (xhr.response instanceof ArrayBuffer && xhr.response.byteLength > 1000) {
                    readBlob(new Blob([xhr.response]), entry);
                  }
                  // Scan text responses for download URLs
                  var respText = '';
                  try { respText = xhr.responseText || ''; } catch (e2) {}
                  if (respText.length > 100) {
                    // Search for any http(s) URL with a meaningful length
                    var urlRe = /https?:\/\/[^\s"'\\,\]\)}{]{20,}/g;
                    var um;
                    while ((um = urlRe.exec(respText)) !== null) {
                      var foundUrl = um[0]
                        .replace(/\\u003d/g, '=').replace(/\\u0026/g, '&')
                        .replace(/\\u0022/g, '').replace(/\\"/g, '').replace(/\\$/g, '');
                      // Skip analytics, tracking, viewer images, static assets
                      if (/play\.google\.com\/log|\/viewer\/img\b|\/viewer\/presspage|\/viewer\/icon|google-analytics|googletagmanager|gstatic\.com|fonts\.googleapis/i.test(foundUrl)) continue;
                      captured.push({ source: 'xhr-response-url', url: foundUrl });
                    }
                    // For batchexecute responses, extract base64-encoded file data
                    if (xhrUrl.indexOf('batchexecute') !== -1 && respText.length > 1000) {
                      var b64Re = /\\"([A-Za-z0-9+\/]{200,}={0,3})\\"/g;
                      var b64m;
                      while ((b64m = b64Re.exec(respText)) !== null) {
                        b64Chunks.push(b64m[1]);
                      }
                    }
                  }
                } catch (e) {}
              });
            }
            return origXhrSend.apply(this, arguments);
          };

          var el = document.querySelector(sel);
          if (!el) { restore(); resolve([]); return; }

          // Dispatch event — either custom event type or click with isTrusted shadow
          var evt;
          if (eventType) {
            evt = new CustomEvent(eventType, { bubbles: true, cancelable: true });
          } else {
            evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            try {
              Object.defineProperty(evt, 'isTrusted', {
                get: function () { return true; },
                configurable: true, enumerable: true
              });
            } catch (e) {}
          }

          el.dispatchEvent(evt);

          function restore() {
            window.open = origOpen;
            window.fetch = origFetch;
            HTMLAnchorElement.prototype.click = origAClick;
            URL.createObjectURL = origCreateURL;
            XMLHttpRequest.prototype.open = origXhrOpen;
            XMLHttpRequest.prototype.send = origXhrSend;
          }

          function tryExtractFileFromB64() {
            if (b64Chunks.length === 0) return;
            // Try: concatenated first, then each individual chunk (with padding)
            var tries = b64Chunks.length > 1 ? [b64Chunks.join('')].concat(b64Chunks) : b64Chunks.slice();
            for (var t = 0; t < tries.length; t++) {
              try {
                var b64str = tries[t];
                // Pad to multiple of 4 for valid base64
                while (b64str.length % 4 !== 0) b64str += '=';
                var bin = atob(b64str);
                var bytes = new Uint8Array(bin.length);
                for (var bi = 0; bi < bin.length; bi++) bytes[bi] = bin.charCodeAt(bi);
                // Search ENTIRE decoded data for file signatures
                for (var off = 0; off < bytes.length - 4; off++) {
                  var b0 = bytes[off], b1 = bytes[off+1], b2 = bytes[off+2], b3 = bytes[off+3];
                  // ZIP/DOCX/XLSX: PK\x03\x04
                  if (b0===0x50 && b1===0x4B && b2===0x03 && b3===0x04) {
                    var fileBlob = new Blob([bytes.slice(off)]);
                    var fileEntry = { source: 'batchexecute-file', type: 'application/octet-stream' };
                    captured.push(fileEntry);
                    readBlob(fileBlob, fileEntry);
                    return;
                  }
                  // PDF: %PDF
                  if (b0===0x25 && b1===0x50 && b2===0x44 && b3===0x46) {
                    var pdfBlob = new Blob([bytes.slice(off)], { type: 'application/pdf' });
                    var pdfEntry = { source: 'batchexecute-file', type: 'application/pdf' };
                    captured.push(pdfEntry);
                    readBlob(pdfBlob, pdfEntry);
                    return;
                  }
                  // OLE/CFB (old DOC/XLS): D0 CF 11 E0
                  if (b0===0xD0 && b1===0xCF && b2===0x11 && b3===0xE0) {
                    var oleBlob = new Blob([bytes.slice(off)]);
                    var oleEntry = { source: 'batchexecute-file', type: 'application/octet-stream' };
                    captured.push(oleEntry);
                    readBlob(oleBlob, oleEntry);
                    return;
                  }
                }
              } catch (e) {}
            }
          }

          function checkDone() {
            if (pendingBlobs > 0) { setTimeout(checkDone, 200); return; }
            // Try to extract file content from batchexecute base64 chunks
            tryExtractFileFromB64();
            // Wait for any new blob reads from file extraction
            if (pendingBlobs > 0) { setTimeout(checkDone, 200); return; }
            restore();
            resolve(captured);
          }
          // Give 5s for XHR responses to arrive
          setTimeout(checkDone, 5000);
        });
      },
      args: [message.selector, message.eventType || null],
    }).then(function (results) {
      var captured = results && results[0] && results[0].result;
      sendResponse({ captured: captured || [] });
    }).catch(function (err) {
      sendResponse({ error: err.message, captured: [] });
    });
    return true;
  }

  // Deeply inspect a file element's Angular state and DOM metadata for download URLs
  if (message.type === 'MAIN_WORLD_INSPECT_FILE') {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function (sel) {
        var el = document.querySelector(sel);
        if (!el) return { error: 'not found' };

        var result = { jslogs: [], strings: [], dsToken: null, downloadUrl: null };

        // 1. Collect jslog attributes from element and ancestors
        var walker = el;
        for (var w = 0; w < 15; w++) {
          var jslog = walker.getAttribute && walker.getAttribute('jslog');
          if (jslog) result.jslogs.push({ level: w, tag: walker.tagName, jslog: jslog.substring(0, 300) });
          // Check for data attributes with URLs or tokens
          if (walker.attributes) {
            for (var a = 0; a < walker.attributes.length; a++) {
              var val = walker.attributes[a].value;
              if (val && val.length > 20 && /^(AAEAbe|http|blob:|data:)/i.test(val)) {
                result.strings.push({ attr: walker.attributes[a].name, val: val.substring(0, 200), level: w });
                if (val.indexOf('AAEAbe') === 0) result.dsToken = val;
                if (val.indexOf('http') === 0 && /download|export|file|drive/i.test(val)) result.downloadUrl = val;
              }
            }
          }
          if (walker.parentElement) walker = walker.parentElement; else break;
        }

        // 2. Search __ngContext__ on element, children, siblings, AND ancestors
        function searchNgContext(node, label) {
          var ctx = node.__ngContext__;
          if (!ctx || !Array.isArray(ctx)) return;
          for (var ci = 0; ci < Math.min(ctx.length, 200); ci++) {
            var item = ctx[ci];
            if (typeof item === 'string' && item.length > 15) {
              if (item.indexOf('AAEAbe') === 0) {
                result.dsToken = item;
                result.strings.push({ src: label + '[' + ci + ']', val: item.substring(0, 200) });
              }
              if (/^https?:\/\/.*(?:download|export|file|drive|viewer)/i.test(item)) {
                result.downloadUrl = item;
                result.strings.push({ src: label + '[' + ci + ']', val: item.substring(0, 200) });
              }
              if (/^[A-Za-z0-9_-]{25,}$/.test(item)) {
                result.strings.push({ src: label + '[' + ci + ']', val: item.substring(0, 200), type: 'id-like' });
              }
              // Also capture any long string > 30 chars (helps discovery)
              if (item.length > 30 && result.strings.length < 50) {
                var isDup = result.strings.some(function(s) { return s.val === item.substring(0, 200); });
                if (!isDup) result.strings.push({ src: label + '[' + ci + ']', val: item.substring(0, 200) });
              }
            }
            // Search one level deeper in objects/arrays
            if (item && typeof item === 'object') {
              try {
                var keys = Array.isArray(item) ? item : Object.values(item);
                for (var ki = 0; ki < Math.min(keys.length, 50); ki++) {
                  var kv = keys[ki];
                  if (typeof kv === 'string' && kv.length > 15) {
                    if (kv.indexOf('AAEAbe') === 0) result.dsToken = kv;
                    if (/^https?:\/\/.*(?:download|export|file|drive|viewer)/i.test(kv)) result.downloadUrl = kv;
                    if ((/^[A-Za-z0-9_-]{25,}$/.test(kv) || kv.indexOf('AAEAbe') === 0 || kv.indexOf('http') === 0) && result.strings.length < 50) {
                      result.strings.push({ src: label + '[' + ci + '][' + ki + ']', val: kv.substring(0, 200) });
                    }
                  }
                }
              } catch (e) {}
            }
          }
        }
        // Search children first (component may be on a child)
        var children = el.querySelectorAll('*');
        for (var ch = 0; ch < Math.min(children.length, 20); ch++) {
          searchNgContext(children[ch], 'child' + ch);
        }
        // Search siblings
        if (el.parentElement) {
          var sibs = el.parentElement.children;
          for (var si = 0; si < sibs.length; si++) {
            if (sibs[si] !== el) searchNgContext(sibs[si], 'sib' + si);
          }
        }
        // Search element and ancestors
        walker = el;
        for (var n = 0; n < 15; n++) {
          searchNgContext(walker, 'anc' + n);
          if (walker.parentElement) walker = walker.parentElement; else break;
        }

        // 3. Search all own properties on element AND closest custom element for Angular bindings
        function searchOwnProps(node, label) {
          try {
            var ownProps = Object.getOwnPropertyNames(node);
            for (var p = 0; p < ownProps.length; p++) {
              if (ownProps[p].indexOf('__') === 0 || ownProps[p].indexOf('_ng') === 0) {
                try {
                  var propVal = node[ownProps[p]];
                  if (typeof propVal === 'string' && propVal.length > 15) {
                    result.strings.push({ src: label + ':' + ownProps[p], val: propVal.substring(0, 200) });
                  }
                } catch (e) {}
              }
            }
          } catch (e) {}
        }
        searchOwnProps(el, 'el');
        // Find closest custom element (Angular component host)
        walker = el;
        for (var ce = 0; ce < 10; ce++) {
          if (walker.tagName && walker.tagName.indexOf('-') !== -1) {
            searchOwnProps(walker, 'custom:' + walker.tagName);
            result.strings.push({ src: 'customTag', val: walker.tagName });
            break;
          }
          if (walker.parentElement) walker = walker.parentElement; else break;
        }

        return result;
      },
      args: [message.selector],
    }).then(function (results) {
      var result = results && results[0] && results[0].result;
      sendResponse(result || {});
    }).catch(function (err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  // Deep search of Angular component state for file references
  if (message.type === 'MAIN_WORLD_DEEP_FILE_SEARCH') {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function () {
        var el = document.querySelector('user-query-file-preview');
        if (!el) return { error: 'user-query-file-preview not found' };

        var results = [];
        var visited = new WeakSet();
        var maxResults = 80;

        function deepSearch(obj, path, depth) {
          if (depth > 6 || results.length >= maxResults) return;
          if (obj === null || obj === undefined) return;
          if (typeof obj === 'string') {
            if (obj.length > 10 && obj.length < 5000) {
              // URLs, tokens, IDs
              if (/^(http|blob:|data:|AAEAbe|tC[A-Z])/i.test(obj) || /^[A-Za-z0-9_\/-]{20,}$/.test(obj)) {
                results.push({ p: path, v: obj.substring(0, 250) });
              }
              // File/download keywords
              if (/file|download|upload|docx|\.doc|attachment|asset|mime|content.type/i.test(obj)) {
                results.push({ p: path, v: obj.substring(0, 250) });
              }
            }
            return;
          }
          if (typeof obj === 'number' || typeof obj === 'boolean') return;
          if (typeof obj !== 'object') return;
          // Skip DOM nodes (performance)
          if (obj instanceof Node || obj instanceof Event || obj instanceof Window) return;
          try { if (visited.has(obj)) return; visited.add(obj); } catch(e) { return; }

          if (Array.isArray(obj)) {
            for (var i = 0; i < Math.min(obj.length, 100); i++) {
              deepSearch(obj[i], path + '[' + i + ']', depth + 1);
            }
          } else {
            try {
              var keys = Object.keys(obj);
              for (var k = 0; k < Math.min(keys.length, 60); k++) {
                var key = keys[k];
                // Always report file-related property names
                if (/file|download|url|token|id|name|type|mime|asset|attachment|source|content/i.test(key)) {
                  try {
                    var val = obj[key];
                    if (typeof val === 'string' && val.length > 3 && val.length < 5000) {
                      results.push({ p: path + '.' + key, v: val.substring(0, 250) });
                    } else if (typeof val === 'number') {
                      results.push({ p: path + '.' + key, v: String(val) });
                    }
                  } catch(e) {}
                }
                try { deepSearch(obj[key], path + '.' + key, depth + 1); } catch(e) {}
              }
            } catch(e) {}
          }
        }

        // 1. Search __ngContext__ on the element
        if (el.__ngContext__) {
          deepSearch(el.__ngContext__, 'ctx', 0);
        }

        // 2. Try ng.getComponent (available in some builds)
        try {
          if (window.ng && window.ng.getComponent) {
            var comp = window.ng.getComponent(el);
            if (comp) {
              deepSearch(comp, 'comp', 0);
            }
          }
        } catch(e) {}

        // 3. Search __ngContext__ on children
        var kids = el.querySelectorAll('*');
        for (var c = 0; c < Math.min(kids.length, 30); c++) {
          if (kids[c].__ngContext__ && kids[c].__ngContext__ !== el.__ngContext__) {
            deepSearch(kids[c].__ngContext__, 'child' + c + ':' + kids[c].tagName, 0);
          }
        }

        // 4. Search parent that may hold conversation data
        var parent = el.parentElement;
        for (var p = 0; p < 5; p++) {
          if (parent && parent.__ngContext__ && parent.__ngContext__ !== el.__ngContext__) {
            deepSearch(parent.__ngContext__, 'parent' + p + ':' + parent.tagName, 0);
            break;
          }
          if (parent) parent = parent.parentElement; else break;
        }

        // 5. Search all own properties on element that look Angular-related
        try {
          Object.getOwnPropertyNames(el).forEach(function(prop) {
            if (prop.indexOf('__') === 0 || prop.indexOf('_ng') === 0) {
              try { deepSearch(el[prop], 'el.' + prop, 0); } catch(e) {}
            }
          });
        } catch(e) {}

        return { count: results.length, results: results };
      },
    }).then(function (results) {
      var data = results && results[0] && results[0].result;
      sendResponse(data || {});
    }).catch(function (err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  // Click a button in main world while intercepting window.open, <a>.click(),
  // and navigation attempts to capture the target URL.
  if (message.type === 'MAIN_WORLD_CLICK_CAPTURE') {
    console.log('[BG] MAIN_WORLD_CLICK_CAPTURE:', message.selector);
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function (sel) {
        return new Promise(function (resolve) {
          var captured = [];
          var pendingBlobs = 0;

          // Helper: read blob as data URL
          function readBlobAsDataUrl(blob, entry) {
            pendingBlobs++;
            var reader = new FileReader();
            reader.onload = function () {
              entry.dataUrl = reader.result;
              pendingBlobs--;
            };
            reader.onerror = function () { pendingBlobs--; };
            reader.readAsDataURL(blob);
          }

          // 1. Patch window.open
          var origOpen = window.open;
          window.open = function (url) {
            if (url) captured.push({ source: 'window.open', url: String(url) });
            return { closed: false, close: function () {}, focus: function () {},
              document: { write: function () {} }, location: {} };
          };

          // 2. Patch HTMLAnchorElement.prototype.click to capture <a download> clicks
          var origAClick = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function () {
            if (this.href) {
              var entry = { source: 'a.click', url: this.href, download: this.download || null };
              captured.push(entry);
              // If it's a blob URL, read the blob content
              if (this.href.indexOf('blob:') === 0) {
                try {
                  fetch(this.href).then(function (r) { return r.blob(); }).then(function (b) {
                    readBlobAsDataUrl(b, entry);
                  }).catch(function () {});
                } catch (e) {}
              }
            }
            return undefined;
          };

          // 3. Patch URL.createObjectURL — save blob reference AND read as data URL
          var origCreateURL = URL.createObjectURL;
          URL.createObjectURL = function (blob) {
            var blobUrl = origCreateURL.call(URL, blob);
            var entry = { source: 'createObjectURL', url: blobUrl,
              type: blob && blob.type, size: blob && blob.size };
            captured.push(entry);
            // Read the blob as data URL right here (we have access to the blob object)
            if (blob) readBlobAsDataUrl(blob, entry);
            return blobUrl;
          };

          // 4. Patch fetch to capture download URLs
          var origFetch = window.fetch;
          window.fetch = function (url, opts) {
            var urlStr = (typeof url === 'string') ? url : (url && url.url) || '';
            if (urlStr && urlStr.indexOf('http') === 0) {
              captured.push({ source: 'fetch', url: urlStr });
            }
            return origFetch.apply(this, arguments);
          };

          // Click the element
          var el = document.querySelector(sel);
          if (el) el.click();

          // Wait for async handlers and blob reads, then restore and return
          function checkDone() {
            if (pendingBlobs > 0) {
              setTimeout(checkDone, 200);
              return;
            }
            window.open = origOpen;
            HTMLAnchorElement.prototype.click = origAClick;
            URL.createObjectURL = origCreateURL;
            window.fetch = origFetch;
            resolve(captured);
          }
          setTimeout(checkDone, 2500);
        });
      },
      args: [message.selector],
    }).then(function (results) {
      var captured = results && results[0] && results[0].result;
      sendResponse({ captured: captured || [] });
    }).catch(function (err) {
      sendResponse({ error: err.message, captured: [] });
    });
    return true;
  }

  if (message.type === 'MAIN_WORLD_EXTRACT_URL') {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function (sel) {
        var el = document.querySelector(sel);
        if (!el) return { error: 'not found' };

        var urls = [];

        // Helper: recursively search object for URL strings (max 3 levels deep)
        function findUrls(obj, path, depth) {
          if (!obj || depth > 3) return;
          if (typeof obj === 'string') {
            if (obj.match(/^https?:\/\//) || obj.match(/^blob:/)) {
              urls.push({ path: path, url: obj.substring(0, 300) });
            }
            return;
          }
          if (Array.isArray(obj)) {
            for (var i = 0; i < Math.min(obj.length, 50); i++) {
              findUrls(obj[i], path + '[' + i + ']', depth + 1);
            }
            return;
          }
          if (typeof obj === 'object') {
            var keys;
            try { keys = Object.keys(obj); } catch (e) { return; }
            for (var k = 0; k < Math.min(keys.length, 100); k++) {
              try { findUrls(obj[keys[k]], path + '.' + keys[k], depth + 1); } catch (e) {}
            }
          }
        }

        // 1. Check Angular component via ng.getComponent (if Angular debug tools available)
        try {
          if (window.ng && window.ng.getComponent) {
            var comp = window.ng.getComponent(el);
            if (comp) {
              findUrls(comp, 'component', 0);
            }
          }
        } catch (e) {}

        // 2. Walk up to find components on parent elements too
        var walker = el;
        for (var w = 0; w < 5; w++) {
          try {
            if (window.ng && window.ng.getComponent && window.ng.getComponent(walker)) {
              var parentComp = window.ng.getComponent(walker);
              findUrls(parentComp, 'parent' + w, 0);
            }
          } catch (e) {}
          if (walker.parentElement) walker = walker.parentElement; else break;
        }

        // 3. Check __ngContext__ on the element
        try {
          var ctx = el.__ngContext__;
          if (ctx) {
            findUrls(ctx, 'ngContext', 0);
          }
        } catch (e) {}

        // 4. Check all own properties on the element for Angular bindings
        try {
          var ownProps = Object.getOwnPropertyNames(el);
          for (var p = 0; p < ownProps.length; p++) {
            var propName = ownProps[p];
            if (propName.startsWith('__') || propName.startsWith('_ng')) {
              try {
                findUrls(el[propName], 'el.' + propName, 0);
              } catch (e) {}
            }
          }
        } catch (e) {}

        // 5. Check for data attributes with URLs
        var attrs = el.attributes;
        for (var a = 0; a < attrs.length; a++) {
          var aVal = attrs[a].value;
          if (aVal.match(/^https?:\/\//) || aVal.match(/^blob:/)) {
            urls.push({ path: 'attr.' + attrs[a].name, url: aVal.substring(0, 300) });
          }
        }

        // 6. Check jslog for metadata
        var jslog = el.getAttribute('jslog') || '';
        var jslogChild = el.querySelector('[jslog]');
        if (jslogChild) jslog = jslogChild.getAttribute('jslog') || jslog;

        return { urls: urls, jslog: jslog.substring(0, 500), tagName: el.tagName };
      },
      args: [message.selector],
    }).then(function (results) {
      var result = results && results[0] && results[0].result;
      sendResponse(result || { error: 'no result' });
    }).catch(function (err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  // Intercept the next browser download — capture its URL, cancel the download,
  // fetch the content as data URL, and return it to the content script.
  if (message.type === 'INTERCEPT_DOWNLOAD') {
    console.log('[BG] INTERCEPT_DOWNLOAD: watching for downloads...');
    var dlWatchTimeout = null;
    var dlListener = function (downloadItem) {
      chrome.downloads.onCreated.removeListener(dlListener);
      clearTimeout(dlWatchTimeout);

      var downloadUrl = downloadItem.url;
      var downloadId = downloadItem.id;
      console.log('[BG] Captured download:', downloadUrl.substring(0, 150),
        'filename:', downloadItem.filename, 'id:', downloadId);

      // Cancel and remove the download so it doesn't save to disk
      chrome.downloads.cancel(downloadId, function () {
        chrome.downloads.erase({ id: downloadId });
      });

      // Fetch the content from the download URL
      (async function () {
        try {
          var resp = await fetch(downloadUrl);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          var blob = await resp.blob();
          console.log('[BG] Downloaded:', Math.round(blob.size / 1024), 'KB', blob.type);
          var reader = new FileReader();
          reader.onload = function () { sendResponse({ dataUrl: reader.result }); };
          reader.onerror = function () { sendResponse({ error: 'Failed to read blob' }); };
          reader.readAsDataURL(blob);
        } catch (err) {
          console.log('[BG] INTERCEPT_DOWNLOAD fetch error:', err.message);
          sendResponse({ error: err.message || String(err) });
        }
      })();
    };

    chrome.downloads.onCreated.addListener(dlListener);

    // Timeout after 15 seconds
    dlWatchTimeout = setTimeout(function () {
      chrome.downloads.onCreated.removeListener(dlListener);
      console.log('[BG] INTERCEPT_DOWNLOAD timeout');
      sendResponse({ error: 'timeout' });
    }, 15000);

    return true; // async sendResponse
  }

  // Intercept a new tab opened by clicking a button — capture its URL,
  // close the tab, fetch the content, return as data URL.
  if (message.type === 'INTERCEPT_NEW_TAB') {
    console.log('[BG] INTERCEPT_NEW_TAB: watching for new tabs...');
    var tabWatchTimeout = null;
    var senderTabId = tabId; // the tab that sent the message
    var tabListener = function (tab) {
      // Accept tabs opened from our sender tab, or any tab with a Google URL
      // (openerTabId may not be set for all window.open scenarios)
      var capturedUrl = tab.pendingUrl || tab.url || '';
      var isFromSender = tab.openerTabId === senderTabId;
      var isGoogleUrl = capturedUrl.indexOf('google.com') !== -1 ||
        capturedUrl.indexOf('googleusercontent.com') !== -1;
      if (!isFromSender && !isGoogleUrl && capturedUrl !== '' && capturedUrl !== 'about:blank') {
        console.log('[BG] Ignoring unrelated tab:', capturedUrl.substring(0, 80));
        return;
      }

      chrome.tabs.onCreated.removeListener(tabListener);
      clearTimeout(tabWatchTimeout);

      var newTabId = tab.id;
      console.log('[BG] Captured new tab:', capturedUrl ? capturedUrl.substring(0, 150) : 'no URL yet',
        'id:', newTabId, 'opener:', tab.openerTabId, 'sender:', senderTabId);

      // If URL is blank/empty, wait for it to update
      if (!capturedUrl || capturedUrl === 'about:blank' || capturedUrl === 'chrome://newtab/') {
        var updateListener = function (updatedTabId, changeInfo) {
          if (updatedTabId !== newTabId) return;
          if (changeInfo.url && changeInfo.url !== 'about:blank') {
            chrome.tabs.onUpdated.removeListener(updateListener);
            capturedUrl = changeInfo.url;
            console.log('[BG] Tab URL resolved:', capturedUrl.substring(0, 150));
            fetchAndCloseTab(newTabId, capturedUrl, sendResponse);
          }
        };
        chrome.tabs.onUpdated.addListener(updateListener);
        // Timeout for URL resolution
        setTimeout(function () {
          chrome.tabs.onUpdated.removeListener(updateListener);
          if (!capturedUrl || capturedUrl === 'about:blank') {
            // Try one more time to get the URL
            chrome.tabs.get(newTabId, function (t) {
              if (t && t.url && t.url !== 'about:blank') {
                fetchAndCloseTab(newTabId, t.url, sendResponse);
              } else {
                try { chrome.tabs.remove(newTabId); } catch (e) {}
                sendResponse({ error: 'Could not resolve tab URL' });
              }
            });
          }
        }, 5000);
      } else {
        fetchAndCloseTab(newTabId, capturedUrl, sendResponse);
      }
    };

    chrome.tabs.onCreated.addListener(tabListener);

    tabWatchTimeout = setTimeout(function () {
      chrome.tabs.onCreated.removeListener(tabListener);
      console.log('[BG] INTERCEPT_NEW_TAB timeout');
      sendResponse({ error: 'timeout' });
    }, 15000);

    return true; // async sendResponse
  }

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
