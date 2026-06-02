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
  const { isElementVisible, extractElementText, copyToClipboard, formatConversation } =
    window.PortilityShared;

  // ─── Selectors (overridable via remote config) ───────────────────────────
  let HUMAN_SELECTORS = [
    '[data-testid="user-message"]',
    '[data-testid="human-turn"]',
    '[class*="human-turn"]',
    '[class*="HumanTurn"]',
  ];

  // The class used on Claude's AI response containers.
  // We filter querySelectorAll results to outermost matches only (BUG-005).
  let AI_CLASS_FRAGMENT = 'font-claude-response';

  // Override selectors from remote config cache (non-blocking)
  if (window.PortilityConfig && window.PortilityConfig.getRemoteSelectors) {
    window.PortilityConfig.getRemoteSelectors('claude').then(function (sel) {
      if (!sel) return;
      if (sel.humanSelectors && sel.humanSelectors.length) HUMAN_SELECTORS = sel.humanSelectors;
      if (sel.aiClassFragment) AI_CLASS_FRAGMENT = sel.aiClassFragment;
    });
  }

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

  // ─── File attachment detection ──────────────────────────────────────────

  /**
   * Extract file content by clicking the file card to open Claude's preview,
   * then scraping the content from the resulting DOM overlay.
   * @param {Element} btnEl - The file card button element
   * @param {string} filename - The filename for MIME type detection
   * @returns {Promise<string|null>} data URL or null
   */
  function extractFileViaClick(btnEl, filename) {
    return new Promise(function (resolve) {
      // Snapshot existing overlays/modals so we can detect the new one
      var existingOverlays = new Set(document.querySelectorAll('[role="dialog"], [data-radix-portal], [class*="modal"], [class*="overlay"], [class*="backdrop"]'));

      btnEl.click();
      console.log('[Portility] Clicked file card, waiting for preview...');

      var attempts = 0;
      var checkInterval = setInterval(function () {
        attempts++;

        // Look for new overlay/modal/dialog that appeared after clicking
        var allOverlays = document.querySelectorAll('[role="dialog"], [data-radix-portal], [class*="modal"], [class*="overlay"], [class*="backdrop"]');
        var newOverlay = null;
        for (var o = 0; o < allOverlays.length; o++) {
          if (!existingOverlays.has(allOverlays[o])) {
            newOverlay = allOverlays[o];
            break;
          }
        }

        // Also check for file content viewers (pre, code blocks, iframes)
        var contentEl = null;
        if (newOverlay) {
          // Look for content inside the new overlay
          contentEl = newOverlay.querySelector('pre') || newOverlay.querySelector('code') ||
                      newOverlay.querySelector('[class*="content"]') || newOverlay.querySelector('iframe');
        }

        // Also try any pre/code element that appeared after click
        if (!contentEl && !newOverlay && attempts > 3) {
          // Maybe content appeared inline, not in a modal
          var allPres = document.querySelectorAll('pre, [class*="code-block"]');
          // We'll just check the last/newest one
          if (allPres.length > 0) contentEl = allPres[allPres.length - 1];
        }

        if (contentEl || (newOverlay && attempts >= 3)) {
          clearInterval(checkInterval);
          var textContent = '';

          if (contentEl && contentEl.tagName === 'IFRAME') {
            try { textContent = contentEl.contentDocument.body.textContent || ''; } catch (e) { /* cross-origin */ }
          } else if (contentEl) {
            textContent = contentEl.textContent || contentEl.innerText || '';
          } else if (newOverlay) {
            textContent = newOverlay.textContent || newOverlay.innerText || '';
          }

          // Close the preview
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          setTimeout(function () {
            // Try clicking close button if Escape didn't work
            if (newOverlay && document.body.contains(newOverlay)) {
              var closeBtn = newOverlay.querySelector('button[aria-label="Close"]') ||
                             newOverlay.querySelector('button:first-child');
              if (closeBtn) closeBtn.click();
            }
          }, 100);

          if (textContent.length > 20) {
            var mimeType = 'text/plain';
            if (/\.html?$/i.test(filename)) mimeType = 'text/html';
            else if (/\.css$/i.test(filename)) mimeType = 'text/css';
            else if (/\.(js|ts|jsx|tsx)$/i.test(filename)) mimeType = 'application/javascript';
            else if (/\.json$/i.test(filename)) mimeType = 'application/json';
            else if (/\.md$/i.test(filename)) mimeType = 'text/markdown';
            else if (/\.xml$/i.test(filename)) mimeType = 'application/xml';
            else if (/\.csv$/i.test(filename)) mimeType = 'text/csv';
            else if (/\.py$/i.test(filename)) mimeType = 'text/x-python';
            var dataUrl = 'data:' + mimeType + ';base64,' + btoa(unescape(encodeURIComponent(textContent)));
            console.log('[Portility] Extracted', textContent.length, 'chars from file preview');
            resolve(dataUrl);
          } else {
            console.log('[Portility] Preview content too small:', textContent.length, 'chars');
            resolve(null);
          }
          return;
        }

        if (attempts > 15) { // 3 seconds max
          clearInterval(checkInterval);
          // Close anything that might have opened
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          console.log('[Portility] File preview did not appear after', attempts, 'checks');
          resolve(null);
        }
      }, 200);
    });
  }

  /**
   * Scan the conversation scope for Claude-specific file attachments.
   * Claude renders uploaded files as button cards inside a wrapper with
   * data-testid="file-thumbnail". The button text contains the filename.
   * These are NOT standard <a> links.
   * @param {Element} scope - conversation container
   * @param {Array} existingAssets - already-detected assets (to avoid duplicates)
   * @returns {Promise<Array>} additional file assets with dataUrl populated
   */
  async function detectClaudeFileAttachments(scope, existingAssets) {
    var newAssets = [];

    // Claude uses data-testid="file-thumbnail" as an empty marker div
    // that is a SIBLING of the actual <button> card inside a .relative wrapper.
    var fileThumbnails = scope.querySelectorAll('[data-testid="file-thumbnail"]');
    console.log('[Portility] Claude file scan: found', fileThumbnails.length, 'file-thumbnail element(s)');

    for (var i = 0; i < fileThumbnails.length; i++) {
      var marker = fileThumbnails[i];
      // The button is a sibling inside the same parent (div.relative)
      var card = marker.parentElement;
      if (!card) continue;
      var btn = card.querySelector('button') || card;

      // Extract filename from the button card. The button has child divs:
      // one with the filename, another with a file-type label (e.g. "HTML").
      // Using btn.textContent concatenates them ("file.htmlHTML"), so we
      // look at individual child elements first.
      var filename = '';
      // Try title/aria-label attribute first
      var titleAttr = btn.getAttribute('title') || btn.getAttribute('aria-label') || '';
      if (titleAttr && /\.\w{1,10}$/.test(titleAttr)) {
        filename = titleAttr;
      }
      // Try first child div's text (usually just the filename)
      if (!filename) {
        var innerDivs = btn.querySelectorAll('div');
        for (var cd = 0; cd < innerDivs.length; cd++) {
          var divText = (innerDivs[cd].textContent || '').trim();
          if (/\.\w{1,10}$/.test(divText) && divText.length < 200) {
            filename = divText;
            break;
          }
        }
      }
      // Fallback: parse full textContent carefully
      if (!filename) {
        var cardText = (btn.textContent || '').trim();
        // Match "name.ext" stopping before a repeated extension or whitespace
        var fnameMatch = cardText.match(/([^\s/\\]+\.\w{1,10})(?:\s|$)/);
        filename = fnameMatch ? fnameMatch[1] : cardText.split('\n')[0].trim();
      }
      if (!filename) {
        filename = 'file_' + (i + 1);
      }
      console.log('[Portility] Extracted filename:', filename);

      // Check if already detected by generic extractAssets
      var alreadyFound = existingAssets.some(function (a) {
        return (a.filename && a.filename === filename) ||
               (a.alt && a.alt === filename);
      });
      if (alreadyFound) continue;

      // Skip image-type files (already handled by image detection)
      if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(filename)) continue;

      // Determine which turn this attachment belongs to
      var turnRole = 'Human';
      var closestAi = card.closest('[class*="' + AI_CLASS_FRAGMENT + '"]');
      if (closestAi) turnRole = 'Assistant';

      var downloadUrl = null;
      var dataUrl = null;

      // Strategy 1: Check for <a> links inside or near the card
      var linkEl = card.querySelector('a[href]');
      if (!linkEl && card.parentElement) {
        linkEl = card.parentElement.querySelector('a[href]');
      }
      if (linkEl) downloadUrl = linkEl.href;

      // Strategy 2: Click the file card to open preview and extract content
      if (!dataUrl) {
        dataUrl = await extractFileViaClick(btn, filename);
      }

      newAssets.push({
        type: 'file',
        url: downloadUrl,
        alt: filename,
        thumbnailUrl: null,
        filename: filename,
        turnIndex: -1,
        role: turnRole,
        dataUrl: dataUrl,
      });
      console.log('[Portility] Detected Claude file attachment:', filename, downloadUrl ? '(has URL)' : dataUrl ? '(content extracted)' : '(metadata only)');
    }

    return newAssets;
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

    if (message.type === 'EXTRACT_PRO') {
      (async function () {
        try {
          var messages = extractMessages();
          if (messages.length === 0) {
            throw new Error('No conversation messages found');
          }

          var scope = getConversationScope();
          var humanTurns = findHumanTurns(scope);
          var aiTurns = findAiTurns(scope);

          var tagged = humanTurns.map(function (el) { return { el: el, role: 'Human' }; })
            .concat(aiTurns.map(function (el) { return { el: el, role: 'Assistant' }; }));

          tagged.sort(function (a, b) {
            var pos = a.el.compareDocumentPosition(b.el);
            return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
          });

          var allAssets = [];
          for (var i = 0; i < tagged.length; i++) {
            var turnAssets = window.PortilityShared.extractAssets(
              tagged[i].el, tagged[i].role, i
            );
            allAssets = allAssets.concat(turnAssets);
          }

          // Claude-specific: scan for artifact references in conversation
          var artifactEls = scope.querySelectorAll('[class*="artifact"], [data-testid*="artifact"]');
          for (var j = 0; j < artifactEls.length; j++) {
            var title = artifactEls[j].textContent.trim() || artifactEls[j].getAttribute('aria-label') || '';
            if (title) {
              allAssets.push({
                type: 'artifact',
                url: null,
                alt: title,
                thumbnailUrl: null,
                filename: title.replace(/[^a-zA-Z0-9_.\- ]/g, '_').substring(0, 80),
                turnIndex: -1,
                role: 'Assistant',
              });
            }
          }

          // Claude-specific: detect uploaded file attachments (rendered as cards, not links)
          var claudeFiles = await detectClaudeFileAttachments(scope, allAssets);
          if (claudeFiles.length > 0) {
            console.log('[Portility] Detected', claudeFiles.length, 'Claude file attachment(s)');
            allAssets = allAssets.concat(claudeFiles);
          }

          await window.PortilityShared.captureImageData(allAssets);

          var capturedCount = allAssets.filter(function (a) { return !!a.dataUrl; }).length;
          var responseAssets = allAssets.map(function (a) {
            var copy = { type: a.type, url: a.url, alt: a.alt, filename: a.filename, turnIndex: a.turnIndex, role: a.role };
            if (a.thumbnailUrl && !a.thumbnailUrl.startsWith('data:') && !a.thumbnailUrl.startsWith('blob:')) copy.thumbnailUrl = a.thumbnailUrl;
            return copy;
          });

          var formatted = formatConversation(messages);
          sendResponse({
            success: true,
            messageCount: messages.length,
            text: formatted,
            assets: responseAssets,
            capturedImageCount: capturedCount,
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message || String(err) });
        }
      })();
      return true;
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
      if (typeof window.dreweryTrack === 'function') {
        window.dreweryTrack('auto_paste_started', { platform: 'claude' });
      }
      var attempts = 0;
      var interval = setInterval(function () {
        var input = document.querySelector('div.ProseMirror[contenteditable="true"]')
          || document.querySelector('div[contenteditable="true"]')
          || document.querySelector('textarea');
        if (input) {
          clearInterval(interval);
          if (typeof window.dreweryTrack === 'function') {
            window.dreweryTrack('auto_paste_input_found', { platform: 'claude', attempts: attempts });
          }
          input.focus();
          if (input.tagName === 'TEXTAREA') {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
          }
          chrome.storage.local.remove('portility_pending_paste');

          // Paste pending images, then auto-submit
          chrome.storage.local.get('portility_pending_images', function (imgData) {
            var images = imgData.portility_pending_images;
            var hasImages = images && images.length > 0;
            console.log('[Portility] Claude auto-paste: images in storage =', hasImages ? images.length : 0);

            if (hasImages && window.PortilityShared && window.PortilityShared.pasteImages) {
              // Try clicking attach button to ensure file input is in DOM
              var attachBtn = document.querySelector('button[aria-label="Attach files"]')
                || document.querySelector('button[data-testid="file-upload"]')
                || document.querySelector('[aria-label="Upload content"]');
              if (attachBtn) {
                attachBtn.click();
                // Close any file dialog that opened by pressing Escape
                setTimeout(function () { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }, 100);
              }

              setTimeout(function () {
                window.PortilityShared.pasteImages(input, images, function () {
                  chrome.storage.local.remove('portility_pending_images');
                });
              }, 300);
            }

            // Auto-submit: poll for send button (longer delay when images attached)
            var submitDelay = hasImages ? 2000 : 0;
            setTimeout(function () {
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
            }, submitDelay);
          });
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

    // Check on load — poll briefly in case storage write hasn't landed yet
    var pollCount = 0;
    var pollInterval = setInterval(function () {
      chrome.storage.local.get('portility_pending_paste', function (data) {
        if (data.portility_pending_paste) {
          clearInterval(pollInterval);
          doPaste(data.portility_pending_paste);
        } else if (++pollCount >= 12) {
          clearInterval(pollInterval);
        }
      });
    }, 250);
  })();

  // ─── Page load analytics ──────────────────────────────────────────────────
  if (typeof window.dreweryTrack === 'function') {
    window.dreweryTrack('drewery_page_load', { platform: 'claude' });
  }
})();
