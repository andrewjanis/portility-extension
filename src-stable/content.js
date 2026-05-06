/**
 * content.js
 * The Drewery — content script.
 * Runs on https://claude.ai/* pages.
 *
 * Bug fixes applied:
 *   BUG-004 — Wrong conversation extracted in Claude Projects: scope all queries
 *             to the current conversation's scroll container, filter by visibility.
 *   BUG-005 — AI responses split into multiple labeled blocks: filter AI turn
 *             elements to only outermost instances of the response class.
 *   BUG-003 — No placeholder for images: detect img elements and upload wrappers
 *             inside user messages, insert "[image attached]".
 *   BUG-001 — Artifact panel text appended: scoping to conversation container
 *             naturally excludes the sibling artifact panel.
 *   BUG-002 — Bullet content missing: explicit <li> traversal in text extraction
 *             ensures list content is always captured.
 *   BUG-006 — Icon sticks on gray after SPA navigation: improved URL change
 *             detection with history method patching and debounce.
 */

(function () {
  'use strict';

  // ─── Shared utilities (from content-shared.js) ────────────────────────────
  const { isElementVisible, extractElementText, stripMarkdown, copyToClipboard, formatConversation } =
    window.PortilityShared;

  // ─── Selectors ────────────────────────────────────────────────────────────
  const HUMAN_SELECTORS = [
    '[data-testid="user-message"]',
    '[data-testid="human-turn"]',
    '[class*="human-turn"]',
    '[class*="HumanTurn"]',
  ];

  // The class used on Claude's AI response containers.
  // We filter querySelectorAll results to outermost matches only (BUG-005).
  const AI_CLASS_FRAGMENT = 'font-claude-response';

  // ─── Conversation scope (BUG-004, BUG-001) ────────────────────────────────
  /**
   * Find the scrollable container that holds the active conversation thread.
   * Scoping queries here prevents picking up:
   *   - Artifact/preview panels (BUG-001) — sibling containers, not nested
   *   - Cached/background conversations in Project context (BUG-004)
   *
   * Strategy: anchor on the first visible user message, walk up the DOM until
   * we hit a scrollable container. Fall back to <main> or <body>.
   */
  function getConversationScope() {
    // Find the first visible human turn to use as an anchor
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

  // (isElementVisible, extractElementText, stripMarkdown provided by content-shared.js)

  // ─── Image detection (BUG-003) ────────────────────────────────────────────
  /**
   * Check if a user-message element contains an uploaded image.
   * Returns "[image attached]\n" if detected, otherwise "".
   * @param {Element} el
   * @returns {string}
   */
  function getImagePrefix(el) {
    // Check inside the user-message element itself first
    if (el.querySelector('img')) return '[image attached]\n';

    // Claude places the image thumbnail container several levels ABOVE the
    // [data-testid="user-message"] element, as a sibling of the text container,
    // not nested inside it. The thumbnail's child element has a data-testid
    // equal to the uploaded filename (e.g. "1776025265211_image.png").
    //
    // Walk up from user-message checking siblings at each level. Stop walking
    // if a sibling contains another turn (another user-message or an AI response),
    // which means we've escaped the current turn's container.
    const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;

    function siblingHasImageTestId(sib) {
      if (IMAGE_EXT.test(sib.getAttribute('data-testid') || '')) return true;
      return Array.from(sib.querySelectorAll('[data-testid]')).some(
        child => IMAGE_EXT.test(child.getAttribute('data-testid') || '')
      );
    }

    function siblingIsAnotherTurn(sib) {
      return !!(
        sib.querySelector('[data-testid="user-message"]') ||
        sib.querySelector('[data-testid="human-turn"]') ||
        sib.querySelector('[class*="font-claude-response"]')
      );
    }

    let node = el;
    for (let level = 0; level < 8; level++) {
      const parent = node.parentElement;
      if (!parent || parent.tagName === 'BODY') break;

      for (const sib of parent.children) {
        if (sib === node) continue;
        if (siblingIsAnotherTurn(sib)) {
          // Crossed into another turn — stop climbing
          return '';
        }
        if (siblingHasImageTestId(sib)) return '[image attached]\n';
      }

      node = parent;
    }

    return '';
  }

  // ─── Turn finders ─────────────────────────────────────────────────────────
  function findHumanTurns(scope) {
    for (const sel of HUMAN_SELECTORS) {
      const els = Array.from(scope.querySelectorAll(sel)).filter(isElementVisible);
      if (els.length > 0) return els;
    }
    return [];
  }

  /**
   * Find AI turn containers.
   *
   * BUG-005: filters to outermost font-claude-response elements only.
   * BUG-007: when the grandparent card container has mixed children (e.g. a
   *          heading + bullet list siblings), returns the grandparent so that
   *          bullets outside the font-claude-response element are captured too.
   * BUG-008: button elements are excluded in walk(), removing the duplicate
   *          collapse-toggle label that precedes each thinking-step's full text.
   *
   * @param {Element} scope
   * @returns {Element[]}
   */
  function findAiTurns(scope) {
    const selector = '[class*="' + AI_CLASS_FRAGMENT + '"]';
    const all = Array.from(scope.querySelectorAll(selector))
      .filter(isElementVisible);

    // Outermost only (BUG-005)
    const outermost = all.filter(function(el) {
      return !el.parentElement || !el.parentElement.closest(selector);
    });

    // For each outermost element, decide whether to use it directly or bubble up
    // to its grandparent.  Bubble up when the grandparent contains sibling
    // children with text that are not themselves font-claude-response elements
    // (e.g. <ul> bullet lists sitting beside a heading) — BUG-007.
    const seen = new Set();
    const result = [];

    for (const el of outermost) {
      const parent = el.parentElement;         // e.g. group relative relative pb-3
      const grandparent = parent?.parentElement; // e.g. border card OR 'contents' wrapper

      let extractFrom = el;

      if (grandparent) {
        // Check if grandparent has children with content outside our selector
        const hasMixedContent = Array.from(grandparent.children).some(child => {
          if (child === parent) return false; // skip the element's own parent
          const cls = child.getAttribute('class') || '';
          if (cls.includes(AI_CLASS_FRAGMENT)) return false; // skip other response els
          return (child.innerText || child.textContent || '').trim().length > 0;
        });

        if (hasMixedContent) extractFrom = grandparent;
      }

      if (!seen.has(extractFrom)) {
        seen.add(extractFrom);
        result.push(extractFrom);
      }
    }

    return result;
  }

  // ─── Conversation detection ───────────────────────────────────────────────
  function hasActiveConversation() {
    // Only consider /chat/ URLs as having a conversation
    if (!/claude\.ai\/chat\//i.test(location.href)) return false;
    const scope = getConversationScope();
    return findHumanTurns(scope).length >= 1 && findAiTurns(scope).length >= 1;
  }

  // ─── Status reporting ─────────────────────────────────────────────────────
  function reportStatus() {
    const hasConversation = hasActiveConversation();
    try {
      chrome.runtime.sendMessage(
        { type: 'CONVERSATION_STATUS', hasConversation },
        function () { void chrome.runtime.lastError; }
      );
    } catch (e) {
      // Extension context invalidated — ignore.
    }
  }

  // ─── SPA navigation detection (BUG-006) ──────────────────────────────────
  let currentUrl = location.href;
  let navDebounceTimer = null;

  function onUrlChange() {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      clearTimeout(navDebounceTimer);
      // Wait for SPA to finish rendering the new conversation
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
      ...humanTurns.map(el => ({ el, role: 'Human' })),
      ...aiTurns.map(el => ({ el, role: 'Assistant' })),
    ].sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    return tagged.map(({ el, role }) => {
      let text = extractElementText(el);

      // For human turns, prepend image placeholder if an image was attached (BUG-003)
      if (role === 'Human') {
        const prefix = getImagePrefix(el);
        if (prefix) text = prefix + text;
      }

      return { role, text };
    }).filter(({ text }) => text.trim().length > 0);
  }

  // (formatConversation, copyToClipboard provided by content-shared.js)

  // ─── Message listener ─────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    // Respond to PING from popup.js so it knows the content script is loaded
    if (message.type === 'PING') {
      sendResponse({ pong: true, hasConversation: hasActiveConversation() });
      return;
    }

    if (message.type !== 'EXTRACT') return;

    (async function () {
      try {
        const messages = extractMessages();

        // Validate non-empty before proceeding (BUG-004 additional fix)
        if (messages.length === 0) {
          throw new Error('No conversation messages found');
        }

        const formatted = formatConversation(messages);

        // Second validation: ensure the formatted output has real content
        if (!formatted || formatted.trim().length === 0) {
          throw new Error('Extraction produced empty output');
        }

        // Only copy to clipboard for direct Copy button flow, not Summarize
        if (!message.skipClipboard) {
          await copyToClipboard(formatted);
        }

        if (typeof window.dreweryTrack === 'function') {
          window.dreweryTrack('drewery_extract_success', { message_count: messages.length });
        }

        // Notify popup directly (sendResponse) and background (for icon change)
        sendResponse({ success: true, messageCount: messages.length, text: formatted });
        chrome.runtime.sendMessage(
          { type: 'EXTRACTION_SUCCESS', messageCount: messages.length },
          function () { void chrome.runtime.lastError; }
        );
      } catch (err) {
        const errorMessage = err && err.message ? err.message : String(err);

        if (typeof window.dreweryTrack === 'function') {
          window.dreweryTrack('drewery_extract_failed', { error: errorMessage });
        }

        sendResponse({ success: false, error: errorMessage });
        chrome.runtime.sendMessage(
          { type: 'EXTRACTION_FAILED', error: errorMessage },
          function () { void chrome.runtime.lastError; }
        );
      }
    })();

    return true; // Keep message channel open for async sendResponse
  });

  // ─── Auto-paste from Portility ────────────────────────────────────────────
  (function setupAutoPaste() {
    var pasting = false;

    function doPaste(text) {
      if (pasting) return;
      pasting = true;
      var attempts = 0;
      var interval = setInterval(function () {
        var input = document.querySelector('div.ProseMirror[contenteditable="true"]')
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
            var sendBtn = document.querySelector('button[aria-label="Send Message"]')
              || document.querySelector('button[aria-label="Send message"]')
              || document.querySelector('fieldset button[type="button"]:last-child')
              || document.querySelector('button[data-testid="send-button"]');
            if (sendBtn && !sendBtn.disabled) {
              clearInterval(submitInterval);
              sendBtn.click();
              if (typeof window.dreweryTrack === 'function') {
                window.dreweryTrack('portility_auto_submit', { platform: 'claude', success: true });
              }
            } else if (++submitAttempts > 20) {
              clearInterval(submitInterval);
              if (typeof window.dreweryTrack === 'function') {
                window.dreweryTrack('portility_auto_submit', {
                  platform: 'claude',
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
              platform: 'claude',
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
    window.dreweryTrack('drewery_page_load', { platform: 'claude' });
  }
})();
