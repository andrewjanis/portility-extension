/**
 * content-gemini.js
 * Portility — content script for Gemini.
 * Runs on https://gemini.google.com/* pages.
 *
 * Mirrors the structure of content-chatgpt.js but uses Gemini-specific
 * DOM selectors and handles Gemini's particular edge cases:
 *   - User turns: .user-query-text, [data-turn-role="user"], .query-text
 *   - Model turns: .model-response-text, [data-turn-role="model"], .response-text
 *   - Conversation container: .conversation-container or scrollable ancestor
 */

(function () {
  'use strict';

  // ─── Shared utilities (from content-shared.js) ────────────────────────────
  const { isElementVisible, extractElementText, copyToClipboard, formatConversation } =
    window.PortilityShared;

  // ─── Selectors ────────────────────────────────────────────────────────────
  // Gemini's DOM uses multiple possible selectors; try them in order of
  // specificity. These cover known Gemini UI variations.
  const HUMAN_SELECTORS = [
    '.user-query-text',
    '[data-turn-role="user"]',
    '.query-text',
    'user-query',
  ];

  const AI_SELECTORS = [
    '.model-response-text',
    '[data-turn-role="model"]',
    '.response-text',
    'model-response',
  ];

  // ─── Conversation scope ───────────────────────────────────────────────────
  /**
   * Find the scrollable container that holds the active conversation thread.
   * Strategy: look for Gemini's conversation container first, then fall back
   * to the scrollable-ancestor walk-up approach.
   */
  function getConversationScope() {
    // Try Gemini's known conversation container
    const container = document.querySelector('.conversation-container');
    if (container && isElementVisible(container)) return container;

    // Fall back: anchor on first visible user message, walk up to scrollable
    for (const sel of HUMAN_SELECTORS) {
      const anchor = document.querySelector(sel);
      if (anchor && isElementVisible(anchor)) {
        let el = anchor.parentElement;
        while (el && el.tagName !== 'BODY') {
          const overflow = window.getComputedStyle(el).overflowY;
          if (overflow === 'auto' || overflow === 'scroll') {
            return el;
          }
          el = el.parentElement;
        }
        break;
      }
    }
    return document.querySelector('main') || document.body;
  }

  // ─── Turn finders ─────────────────────────────────────────────────────────
  function findHumanTurns(scope) {
    for (const sel of HUMAN_SELECTORS) {
      const els = Array.from(scope.querySelectorAll(sel)).filter(isElementVisible);
      if (els.length > 0) return els;
    }
    return [];
  }

  function findAiTurns(scope) {
    for (const sel of AI_SELECTORS) {
      const els = Array.from(scope.querySelectorAll(sel)).filter(isElementVisible);
      if (els.length > 0) return els;
    }
    return [];
  }

  // ─── Image detection ──────────────────────────────────────────────────────
  /**
   * Check if a user message element contains an uploaded image.
   * @param {Element} el
   * @returns {string}
   */
  function getImagePrefix(el) {
    if (el.querySelector('img')) return '[image attached]\n';

    let node = el;
    for (let level = 0; level < 5; level++) {
      const parent = node.parentElement;
      if (!parent || parent.tagName === 'BODY') break;

      for (const sib of parent.children) {
        if (sib === node) continue;
        // Stop if we hit another turn
        for (const sel of HUMAN_SELECTORS.concat(AI_SELECTORS)) {
          if (sib.querySelector(sel) || sib.matches(sel)) return '';
        }
        if (sib.querySelector('img')) return '[image attached]\n';
      }

      node = parent;
    }

    return '';
  }

  // ─── Conversation detection ───────────────────────────────────────────────
  function hasActiveConversation() {
    if (!/gemini\.google\.com/i.test(location.href)) return false;
    const scope = getConversationScope();
    return findHumanTurns(scope).length >= 1 && findAiTurns(scope).length >= 1;
  }

  // ─── Status reporting ─────────────────────────────────────────────────────
  function reportStatus() {
    const hasConversation = hasActiveConversation();
    try {
      chrome.runtime.sendMessage(
        { type: 'CONVERSATION_STATUS', hasConversation: hasConversation },
        function () { void chrome.runtime.lastError; }
      );
    } catch (e) {
      // Extension context invalidated — ignore.
    }
  }

  // ─── SPA navigation detection ─────────────────────────────────────────────
  let currentUrl = location.href;
  let navDebounceTimer = null;

  function onUrlChange() {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      clearTimeout(navDebounceTimer);
      navDebounceTimer = setTimeout(reportStatus, 500);
    }
  }

  // Patch history methods to fire a custom event on pushState/replaceState
  (function () {
    const wrap = function (original) {
      return function () {
        const result = original.apply(this, arguments);
        window.dispatchEvent(new Event('drewery:urlchange'));
        return result;
      };
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
  })();

  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('drewery:urlchange', onUrlChange);

  // ─── MutationObserver ─────────────────────────────────────────────────────
  let mutationDebounceTimer = null;
  const observer = new MutationObserver(function () {
    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = setTimeout(reportStatus, 300);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial check
  reportStatus();

  // ─── Extraction ───────────────────────────────────────────────────────────
  /**
   * Build an ordered list of { role, text } objects from the visible DOM.
   * @returns {{ role: string, text: string }[]}
   */
  function extractMessages() {
    const scope = getConversationScope();
    const humanTurns = findHumanTurns(scope);
    const aiTurns = findAiTurns(scope);

    if (humanTurns.length === 0 && aiTurns.length === 0) return [];

    // Tag each element with its role and sort by DOM order
    const tagged = [
      ...humanTurns.map(function (el) { return { el: el, role: 'Human' }; }),
      ...aiTurns.map(function (el) { return { el: el, role: 'Assistant' }; }),
    ].sort(function (a, b) {
      const pos = a.el.compareDocumentPosition(b.el);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    return tagged.map(function (item) {
      var text = extractElementText(item.el);

      if (item.role === 'Human') {
        var prefix = getImagePrefix(item.el);
        if (prefix) text = prefix + text;
      }

      return { role: item.role, text: text };
    }).filter(function (item) { return item.text.trim().length > 0; });
  }

  // ─── Message listener ─────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.type === 'PING') {
      sendResponse({ pong: true, hasConversation: hasActiveConversation() });
      return;
    }

    if (message.type !== 'EXTRACT') return;

    (async function () {
      try {
        const messages = extractMessages();

        if (messages.length === 0) {
          throw new Error('No conversation messages found');
        }

        const formatted = formatConversation(messages);

        if (!formatted || formatted.trim().length === 0) {
          throw new Error('Extraction produced empty output');
        }

        if (!message.skipClipboard) {
          await copyToClipboard(formatted);
        }

        if (typeof window.dreweryTrack === 'function') {
          window.dreweryTrack('drewery_extract_success', {
            platform: 'gemini',
            message_count: messages.length,
          });
        }

        sendResponse({ success: true, messageCount: messages.length, text: formatted });
        chrome.runtime.sendMessage(
          { type: 'EXTRACTION_SUCCESS', messageCount: messages.length },
          function () { void chrome.runtime.lastError; }
        );
      } catch (err) {
        const errorMessage = err && err.message ? err.message : String(err);

        if (typeof window.dreweryTrack === 'function') {
          window.dreweryTrack('drewery_extract_failed', {
            platform: 'gemini',
            error: errorMessage,
          });
        }

        sendResponse({ success: false, error: errorMessage });
        chrome.runtime.sendMessage(
          { type: 'EXTRACTION_FAILED', error: errorMessage },
          function () { void chrome.runtime.lastError; }
        );
      }
    })();

    return true;
  });

  // ─── Auto-paste from Portility ────────────────────────────────────────────
  (function setupAutoPaste() {
    var pasting = false;

    function doPaste(text) {
      if (pasting) return;
      pasting = true;
      var attempts = 0;
      var interval = setInterval(function () {
        var input = document.querySelector('.ql-editor[contenteditable="true"]')
          || document.querySelector('rich-textarea div[contenteditable="true"]')
          || document.querySelector('div[contenteditable="true"]')
          || document.querySelector('textarea');
        if (input) {
          clearInterval(interval);
          input.focus();
          if (input.tagName === 'TEXTAREA') {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
          }
          chrome.storage.local.remove('portility_pending_paste');

          // Auto-submit: poll briefly for send button to become enabled
          var submitAttempts = 0;
          var submitInterval = setInterval(function () {
            var sendBtn = document.querySelector('button.send-button')
              || document.querySelector('button[aria-label="Send message"]')
              || document.querySelector('button[aria-label="Send Message"]')
              || document.querySelector('.input-area button[mat-icon-button]');
            if (sendBtn && !sendBtn.disabled) {
              clearInterval(submitInterval);
              sendBtn.click();
              if (typeof window.dreweryTrack === 'function') {
                window.dreweryTrack('portility_auto_submit', { platform: 'gemini', success: true });
              }
            } else if (++submitAttempts > 20) {
              clearInterval(submitInterval);
              if (typeof window.dreweryTrack === 'function') {
                window.dreweryTrack('portility_auto_submit', {
                  platform: 'gemini',
                  success: false,
                  reason: sendBtn ? 'button_disabled' : 'button_not_found',
                });
              }
            }
          }, 100);
        }
        if (++attempts > 40) {
          clearInterval(interval);
          pasting = false;
          if (typeof window.dreweryTrack === 'function') {
            window.dreweryTrack('portility_auto_submit', {
              platform: 'gemini',
              success: false,
              reason: 'input_not_found',
            });
          }
        }
      }, 250);
    }

    // Check on load
    chrome.storage.local.get('portility_pending_paste', function (data) {
      if (data.portility_pending_paste) doPaste(data.portility_pending_paste);
    });

    // Listen for storage changes (catches late writes / race conditions)
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.portility_pending_paste && changes.portility_pending_paste.newValue) {
        doPaste(changes.portility_pending_paste.newValue);
      }
    });
  })();

  // ─── Page load analytics ──────────────────────────────────────────────────
  if (typeof window.dreweryTrack === 'function') {
    window.dreweryTrack('drewery_page_load', { platform: 'gemini' });
  }
})();
