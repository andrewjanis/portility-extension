/**
 * content.js
 * Portility — content script.
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
  // Claude's markup has changed over time (BUG-009): the class fragment below
  // is kept as a fallback/remote-overridable signal, but data-testid is the
  // primary, more stable match — always included regardless of its value.
  let AI_CLASS_FRAGMENT = 'font-claude-response';
  const AI_TESTID_SELECTOR = '[data-testid="assistant-message"]';

  // Combined selector used everywhere we need to match an AI turn container.
  // Built as a function (not a cached const) so it stays current if remote
  // config updates AI_CLASS_FRAGMENT after this module has already loaded.
  function aiTurnSelector() {
    return AI_TESTID_SELECTOR + ', [class*="' + AI_CLASS_FRAGMENT + '"]';
  }

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
        sib.querySelector(aiTurnSelector())
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
   * Map a filename's extension to a MIME type, for building data: URLs out of
   * extracted text content. Shared by file-preview extraction and artifact
   * content extraction.
   * @param {string} filename
   * @returns {string}
   */
  function getMimeTypeForFilename(filename) {
    if (/\.html?$/i.test(filename)) return 'text/html';
    if (/\.css$/i.test(filename)) return 'text/css';
    if (/\.(js|ts|jsx|tsx)$/i.test(filename)) return 'application/javascript';
    if (/\.json$/i.test(filename)) return 'application/json';
    if (/\.md$/i.test(filename)) return 'text/markdown';
    if (/\.xml$/i.test(filename)) return 'application/xml';
    if (/\.csv$/i.test(filename)) return 'text/csv';
    if (/\.py$/i.test(filename)) return 'text/x-python';
    return 'text/plain';
  }

  /**
   * Extract file content by clicking the file card to open Claude's preview,
   * then scraping the content from the resulting DOM overlay. If Claude can't
   * render a text preview (e.g. Office docs, PDFs), fall back to looking for a
   * download link inside the overlay (e.g. a "Download to view" affordance).
   * @param {Element} btnEl - The file card button element
   * @param {string} filename - The filename for MIME type detection
   * @returns {Promise<{dataUrl: string|null, downloadUrl: string|null}>}
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
          // Only a genuine content element (pre/code/iframe/[class*="content"])
          // is trustworthy as real extracted document content. A whole-overlay
          // textContent scrape (used when no such element exists) often just
          // grabs short UI chrome/messaging (e.g. "Can't preview this file,
          // download to view it") for file types Claude can't render inline
          // (Office docs, PDFs) — that must NOT be treated as real content.
          var hasGenuineContent = false;

          if (contentEl && contentEl.tagName === 'IFRAME') {
            try { textContent = contentEl.contentDocument.body.textContent || ''; hasGenuineContent = true; } catch (e) { /* cross-origin */ }
          } else if (contentEl) {
            textContent = contentEl.textContent || contentEl.innerText || '';
            hasGenuineContent = true;
          } else if (newOverlay) {
            textContent = newOverlay.textContent || newOverlay.innerText || '';
          }

          // Look for a download link inside the overlay (e.g. Office docs/PDFs
          // that Claude can't render a text preview for typically show a
          // "Download to view" affordance with a real href).
          var downloadUrl = null;
          if (newOverlay) {
            var anchorEl = newOverlay.querySelector('a[href], a[download]');
            if (anchorEl && anchorEl.href) downloadUrl = anchorEl.href;
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

          if (hasGenuineContent && textContent.length > 20) {
            var mimeType = getMimeTypeForFilename(filename);
            var dataUrl = 'data:' + mimeType + ';base64,' + btoa(unescape(encodeURIComponent(textContent)));
            console.log('[Portility] Extracted', textContent.length, 'chars from file preview');
            resolve({ dataUrl: dataUrl, downloadUrl: downloadUrl });
          } else if (downloadUrl) {
            // No genuine content element (or its text was too short) — prefer
            // the real download link over any generic whole-overlay text scrape,
            // since that scrape may just be UI chrome, not real file content.
            console.log('[Portility] No genuine text preview, but found download link in overlay');
            resolve({ dataUrl: null, downloadUrl: downloadUrl });
          } else {
            console.log('[Portility] Preview content too small:', textContent.length, 'chars, no download link found');
            if (newOverlay) {
              console.log('[Portility] Overlay HTML (truncated):', (newOverlay.outerHTML || '').slice(0, 500));
            }
            resolve({ dataUrl: null, downloadUrl: null });
          }
          return;
        }

        if (attempts > 15) { // 3 seconds max
          clearInterval(checkInterval);
          // Close anything that might have opened
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          console.log('[Portility] File preview did not appear after', attempts, 'checks');
          resolve({ dataUrl: null, downloadUrl: null });
        }
      }, 200);
    });
  }

  /**
   * Extract the text content of a Claude artifact.
   *
   * The artifact chip/reference found inside the conversation scope only
   * carries a title — the actual rendered content lives in the artifact
   * preview panel, which is a SIBLING of the conversation scope (excluded
   * from `scope` per BUG-001) and typically only renders the currently-open
   * artifact. Strategy: look for that panel outside `scope`; if it's not
   * currently rendered, click the chip to open it and retry briefly.
   * @param {Element} artEl - the artifact chip/reference element found in scope
   * @param {Element} scope - conversation scope (used to exclude from panel search)
   * @param {string} title
   * @returns {Promise<string|null>}
   */
  function extractArtifactContent(artEl, scope, title) {
    // Code/canvas artifacts render inside a container with "artifact" in its
    // class or data-testid, but document-type artifacts (e.g. a Markdown
    // resume opened from a "Document · MD" chip) instead render inside
    // #wiggle-file-content (Claude's internal panel id for file/doc previews) —
    // match both so extraction works for either artifact flavor.
    var ARTIFACT_SELECTOR = '[class*="artifact"], [data-testid*="artifact"], [id*="wiggle-file"]';

    function findPanelText() {
      var candidates = Array.from(document.querySelectorAll(ARTIFACT_SELECTOR))
        .filter(function (el) { return !scope.contains(el) && isElementVisible(el); });
      // Outermost only
      candidates = candidates.filter(function (el) {
        return !el.parentElement || !el.parentElement.closest(ARTIFACT_SELECTOR);
      });
      if (candidates.length === 0) return null;

      // Prefer a panel whose own title/aria-label matches this artifact's title;
      // fall back to the most recently rendered candidate.
      var panel = candidates.find(function (el) {
        var t = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        return t && title && t.indexOf(title) >= 0;
      }) || candidates[candidates.length - 1];

      var contentEl = panel.querySelector('pre') || panel.querySelector('code') ||
                       panel.querySelector('[class*="content"]') || panel.querySelector('iframe');

      var text = '';
      if (contentEl && contentEl.tagName === 'IFRAME') {
        try { text = contentEl.contentDocument.body.textContent || ''; } catch (e) { /* cross-origin */ }
      } else if (contentEl) {
        text = contentEl.textContent || contentEl.innerText || '';
      } else {
        text = panel.textContent || panel.innerText || '';
      }
      return text && text.trim().length > 20 ? text : null;
    }

    return new Promise(function (resolve) {
      var existing = findPanelText();
      if (existing) {
        console.log('[Portility] Artifact panel already open, extracted', existing.length, 'chars');
        resolve(existing);
        return;
      }

      // Panel isn't currently rendered — click the chip to open it, then retry.
      var clickTarget = artEl.querySelector('button') || artEl;
      clickTarget.click();
      console.log('[Portility] Clicked artifact chip, waiting for panel...');

      var attempts = 0;
      var iv = setInterval(function () {
        attempts++;
        var text = findPanelText();
        if (text || attempts > 15) { // 3 seconds max
          clearInterval(iv);
          if (!text) console.log('[Portility] Artifact panel did not render content after', attempts, 'checks');
          resolve(text);
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

      // Skip file thumbnails inside artifact containers — Claude renders artifact
      // previews (e.g. HTML files) with the same file-thumbnail markers as real
      // uploaded files, but they are not real attachments.
      if (card.closest('[class*="artifact"], [data-testid*="artifact"]')) {
        console.log('[Portility] Skipping file-thumbnail inside artifact container');
        continue;
      }

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
      var closestAi = card.closest(aiTurnSelector());
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
      // (or, failing that, a download link from the preview overlay)
      if (!dataUrl) {
        var clickResult = await extractFileViaClick(btn, filename);
        dataUrl = clickResult.dataUrl;
        if (!downloadUrl) downloadUrl = clickResult.downloadUrl;
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
   * BUG-005: filters to outermost AI-turn elements only (see aiTurnSelector()).
   * BUG-007: when the grandparent card container has mixed children (e.g. a
   *          heading + bullet list siblings), returns the grandparent so that
   *          bullets outside the AI-turn element are captured too.
   * BUG-008: button elements are excluded in walk(), removing the duplicate
   *          collapse-toggle label that precedes each thinking-step's full text.
   *
   * @param {Element} scope
   * @returns {Element[]}
   */
  function findAiTurns(scope) {
    const selector = aiTurnSelector();
    const all = Array.from(scope.querySelectorAll(selector))
      .filter(isElementVisible);

    // Outermost only (BUG-005)
    const outermost = all.filter(function(el) {
      return !el.parentElement || !el.parentElement.closest(selector);
    });

    // For each outermost element, decide whether to use it directly or bubble up
    // to its grandparent.  Bubble up when the grandparent contains sibling
    // children with text that are not themselves AI-turn elements
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
          if (child.matches(selector)) return false; // skip other response els
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
        window.dispatchEvent(new Event('portility:urlchange'));
        return result;
      };
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
  })();

  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('portility:urlchange', onUrlChange);

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
            var promptText = window.PortilityShared.getPrecedingHumanText(tagged, i);
            var turnAssets = window.PortilityShared.extractAssets(
              tagged[i].el, tagged[i].role, i, promptText
            );
            allAssets = allAssets.concat(turnAssets);
          }
          window.PortilityShared.applyFilenameVersioning(allAssets);

          // Fallback: scan entire conversation scope for images not found in turns.
          // Claude sometimes renders user-uploaded images in containers outside the
          // turn elements (e.g. image grid above the text, expanded previews).
          var seenSrcs = {};
          for (var si = 0; si < allAssets.length; si++) {
            if (allAssets[si].url) seenSrcs[allAssets[si].url] = true;
          }
          var scopeImgs = scope.querySelectorAll('img');
          for (var qi = 0; qi < scopeImgs.length; qi++) {
            var scopeImg = scopeImgs[qi];
            var imgSrc = scopeImg.src || scopeImg.getAttribute('src') || '';
            if (!imgSrc || seenSrcs[imgSrc]) continue;
            if (scopeImg.naturalWidth > 0 && scopeImg.naturalWidth < 20) continue;
            if (imgSrc.startsWith('data:') && imgSrc.length < 200) continue;
            if (imgSrc.includes('.svg') && scopeImg.closest('button')) continue;
            seenSrcs[imgSrc] = true;
            var scopeFname = 'image_scope_' + qi + '.png';
            try {
              var pathParts = new URL(imgSrc).pathname.split('/');
              var lastPart = pathParts[pathParts.length - 1];
              if (lastPart && /\.\w{2,5}$/.test(lastPart)) scopeFname = decodeURIComponent(lastPart);
            } catch (e) {}
            allAssets.push({
              type: 'image',
              url: imgSrc,
              alt: scopeImg.alt || '',
              thumbnailUrl: imgSrc,
              filename: scopeFname,
              turnIndex: -1,
              role: 'Unknown',
            });
          }

          // Claude-specific: scan for artifact references in conversation.
          // Only match top-level artifact containers to avoid duplicates from
          // nested elements. Filter out elements whose parent also matches
          // (i.e. keep outermost only).
          var artifactCandidates = scope.querySelectorAll('[class*="artifact"], [data-testid*="artifact"]');
          var seenArtifactTitles = {};
          for (var j = 0; j < artifactCandidates.length; j++) {
            var artEl = artifactCandidates[j];
            // Skip nested elements — only keep the outermost artifact container
            if (artEl.parentElement && artEl.parentElement.closest('[class*="artifact"], [data-testid*="artifact"]')) continue;
            // Prefer aria-label or title attribute (clean name) over raw textContent
            var artTitle = artEl.getAttribute('aria-label') || artEl.getAttribute('title') || '';
            if (!artTitle) {
              // Fallback: first line of text content, capped to avoid capturing entire rendered content
              artTitle = (artEl.textContent || '').trim().split('\n')[0].substring(0, 120);
            }
            if (!artTitle || seenArtifactTitles[artTitle]) continue;
            seenArtifactTitles[artTitle] = true;

            // The chip usually shows a format label near the title (e.g. "Document · MD").
            // If the title itself has no extension, pull one from that label so the
            // extracted content gets a correct MIME type and destination filename.
            var artFilenameBase = artTitle.replace(/[^a-zA-Z0-9_.\- ]/g, '_').substring(0, 80);
            if (!/\.\w{1,5}$/.test(artFilenameBase)) {
              var badgeText = (artEl.textContent || '').replace(artTitle, '');
              var extMatch = badgeText.match(/\b(MD|HTML?|CSS|JSX?|TSX?|JSON|XML|CSV|PY|SVG|TXT|YAML|YML|SQL)\b/i);
              if (extMatch) artFilenameBase += '.' + extMatch[1].toLowerCase();
            }

            var artContent = await extractArtifactContent(artEl, scope, artTitle);
            var artDataUrl = null;
            if (artContent) {
              var artMime = getMimeTypeForFilename(artFilenameBase);
              artDataUrl = 'data:' + artMime + ';base64,' + btoa(unescape(encodeURIComponent(artContent)));
              console.log('[Portility] Extracted', artContent.length, 'chars from artifact:', artTitle);
            } else {
              console.log('[Portility] Could not extract content for artifact:', artTitle);
            }

            allAssets.push({
              type: 'artifact',
              url: null,
              alt: artTitle,
              thumbnailUrl: null,
              filename: artFilenameBase,
              turnIndex: -1,
              role: 'Assistant',
              dataUrl: artDataUrl,
            });
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

          var formatted = formatConversation(messages, !message.skipHeader);
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

        if (typeof window.portilityTrack === 'function') {
          window.portilityTrack('portility_extract_success', { message_count: messages.length });
        }

        // Notify popup directly (sendResponse) and background (for icon change)
        sendResponse({ success: true, messageCount: messages.length, text: formatted });
        chrome.runtime.sendMessage(
          { type: 'EXTRACTION_SUCCESS', messageCount: messages.length },
          function () { void chrome.runtime.lastError; }
        );
      } catch (err) {
        const errorMessage = err && err.message ? err.message : String(err);

        if (typeof window.portilityTrack === 'function') {
          window.portilityTrack('portility_extract_failed', { error: errorMessage });
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
      if (typeof window.portilityTrack === 'function') {
        window.portilityTrack('auto_paste_started', { platform: 'claude' });
      }
      var attempts = 0;
      var interval = setInterval(function () {
        var input = document.querySelector('div.ProseMirror[contenteditable="true"]')
          || document.querySelector('div[contenteditable="true"]')
          || document.querySelector('textarea');
        if (input) {
          clearInterval(interval);
          if (typeof window.portilityTrack === 'function') {
            window.portilityTrack('auto_paste_input_found', { platform: 'claude', attempts: attempts });
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
                  if (typeof window.portilityTrack === 'function') {
                    window.portilityTrack('portility_auto_submit', { platform: 'claude', success: true });
                  }
                } else if (++submitAttempts > 20) {
                  clearInterval(submitInterval);
                  if (typeof window.portilityTrack === 'function') {
                    window.portilityTrack('portility_auto_submit', {
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
          if (typeof window.portilityTrack === 'function') {
            window.portilityTrack('portility_auto_submit', {
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
  if (typeof window.portilityTrack === 'function') {
    window.portilityTrack('portility_page_load', { platform: 'claude' });
  }
})();
