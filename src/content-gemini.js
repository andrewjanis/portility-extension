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

  // ─── Selectors (overridable via remote config) ───────────────────────────
  // Gemini's DOM uses multiple possible selectors; try them in order of
  // specificity. These cover known Gemini UI variations.
  let HUMAN_SELECTORS = [
    '.user-query-text',
    '[data-turn-role="user"]',
    '.query-text',
    'user-query',
  ];

  let AI_SELECTORS = [
    '.model-response-text',
    '[data-turn-role="model"]',
    '.response-text',
    'model-response',
  ];

  // Override selectors from remote config cache (non-blocking)
  if (window.PortilityConfig && window.PortilityConfig.getRemoteSelectors) {
    window.PortilityConfig.getRemoteSelectors('gemini').then(function (sel) {
      if (!sel) return;
      if (sel.humanSelectors && sel.humanSelectors.length) HUMAN_SELECTORS = sel.humanSelectors;
      if (sel.aiSelectors && sel.aiSelectors.length) AI_SELECTORS = sel.aiSelectors;
    });
  }

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

  // ─── Gemini file attachment detection ─────────────────────────────────────
  var FILE_EXT_PATTERN = /[\w\s._-]+\.(docx?|pdf|xlsx?|csv|txt|pptx?|html|json|xml|zip|tar|gz|py|js|ts|md|rtf|odt|mp3|mp4|wav)\b/i;

  /**
   * Click a button and intercept any browser download it triggers.
   * Sets up INTERCEPT_DOWNLOAD before clicking, then clicks via main world.
   * Returns a data URL string if a download was intercepted, or null.
   */
  function clickAndInterceptDownload(el, label) {
    return new Promise(function (resolve) {
      // Set up download interception first
      chrome.runtime.sendMessage({ type: 'INTERCEPT_DOWNLOAD' }, function (dlResult) {
        if (dlResult && dlResult.dataUrl) {
          console.log('[Portility] Download intercepted:', Math.round(dlResult.dataUrl.length / 1024), 'KB');
          resolve(dlResult.dataUrl);
        } else {
          console.log('[Portility] No download intercepted:', dlResult && dlResult.error);
          resolve(null);
        }
      });

      // Click the button after a brief delay (let interception set up)
      setTimeout(function () {
        el.setAttribute('data-portility-click', label);
        chrome.runtime.sendMessage(
          { type: 'MAIN_WORLD_CLICK', selector: '[data-portility-click="' + label + '"]' },
          function () { el.removeAttribute('data-portility-click'); }
        );
      }, 100);
    });
  }

  /**
   * Click a button via main-world injection with API interception.
   * Returns { captured: [{source, url, dataUrl?, ...}] }
   */
  function clickAndCapture(el, label, trusted) {
    return new Promise(function (resolve) {
      el.setAttribute('data-portility-click', label);
      var msgType = trusted ? 'MAIN_WORLD_TRUSTED_CLICK' : 'MAIN_WORLD_CLICK_CAPTURE';
      chrome.runtime.sendMessage(
        { type: msgType, selector: '[data-portility-click="' + label + '"]' },
        function (result) {
          el.removeAttribute('data-portility-click');
          resolve(result || { captured: [] });
        }
      );
    });
  }

  /**
   * Extract file content — tries multiple strategies:
   * 1. Click buttons with API interception to capture URLs
   * 2. Fall back to download interception if URLs are found
   */
  function extractGeminiFileViaClick(chipEl, filename, priority, genFileEl) {
    return new Promise(async function (resolve) {

      // Strategy 1: For generated files, trusted click on "Open" button
      if (priority === 1 && genFileEl) {
        var openBtn = genFileEl.querySelector('[data-test-id="open-button"] button') ||
          genFileEl.querySelector('.open-button button') ||
          genFileEl.querySelector('gem-button button');
        if (openBtn) {
          console.log('[Portility] Trusted click on Open button for:', filename);
          var openResult = await clickAndCapture(openBtn, 'open', true);
          var openData = await resolveCapture(openResult, filename);
          if (openData) { resolve(openData); return; }
        }
      }

      // Strategy 1b: Dispatch viewFileEvent custom event on user-query-file-preview
      // Gemini uses this custom Angular event to handle file viewing (uploaded files only)
      var filePreviewEl = chipEl.closest('user-query-file-preview');
      if (filePreviewEl) {
        console.log('[Portility] Dispatching viewFileEvent on user-query-file-preview for:', filename);
        filePreviewEl.setAttribute('data-portility-click', 'viewfile');
        var viewFileResult = await new Promise(function (r) {
          chrome.runtime.sendMessage({
            type: 'MAIN_WORLD_TRUSTED_CLICK',
            selector: '[data-portility-click="viewfile"]',
            eventType: 'viewFileEvent'
          }, function (res) { r(res || {}); });
        });
        filePreviewEl.removeAttribute('data-portility-click');
        var viewFileData = await resolveCapture(viewFileResult, filename);
        if (viewFileData) {
          // Check if we got a PDF fallback for a non-PDF file
          var vfMime = (viewFileData.match(/^data:([^;,]+)/) || [])[1] || '';
          var vfExt = (filename.match(/\.([^.]+)$/) || [])[1] || '';
          if (vfExt && vfMime === 'application/pdf' && !/^pdf$/i.test(vfExt)) {
            // Strategy 1c: Try to get original file via Drive viewer iframe download button
            console.log('[Portility] Got PDF for', filename, '— trying iframe download');
            var iframeData = await new Promise(function (r) {
              chrome.runtime.sendMessage({ type: 'IFRAME_VIEWER_DOWNLOAD' }, function (res) { r(res); });
            });
            if (iframeData && iframeData.dataUrl && iframeData.dataUrl.length > 500) {
              var ifMime = (iframeData.dataUrl.match(/^data:([^;,]+)/) || [])[1] || '';
              if (ifMime !== 'application/pdf') {
                console.log('[Portility] Got original from iframe:', Math.round(iframeData.dataUrl.length / 1024), 'KB', ifMime);
                closeSidePanel(); resolve(iframeData.dataUrl); return;
              } else {
                console.log('[Portility] Iframe download also returned PDF');
              }
            } else if (iframeData) {
              console.log('[Portility] Iframe scan result:', JSON.stringify(iframeData).substring(0, 500));
            }
          }
          closeSidePanel(); resolve(viewFileData); return;
        }
      }

      // Strategy 2: Trusted click on file chip/preview
      console.log('[Portility] Trusted click on file chip for:', filename);
      var chipResult = await clickAndCapture(chipEl, 'chip', true);
      var chipData = await resolveCapture(chipResult, filename);
      if (chipData) { closeSidePanel(); resolve(chipData); return; }

      // Strategy 2b: Inspect the file element's metadata for a file reference/download URL
      // Search Angular state via main-world script
      chipEl.setAttribute('data-portility-click', 'inspect');
      var inspectResult = await new Promise(function (r) {
        chrome.runtime.sendMessage({
          type: 'MAIN_WORLD_INSPECT_FILE',
          selector: '[data-portility-click="inspect"]'
        }, function (res) { r(res || {}); });
      });
      chipEl.removeAttribute('data-portility-click');
      if (inspectResult.dsToken) {
        console.log('[Portility] Found ds token for file, trying Drive viewer');
        var viewerUrl = 'https://drive.google.com/viewer/upload?ds=' + inspectResult.dsToken;
        // The viewer/upload triggers Drive viewer which gives us a download URL
        var viewerData = await window.PortilityShared.fetchWithCookies(viewerUrl);
        if (viewerData && viewerData.length > 500) {
          console.log('[Portility] Downloaded via ds token:', Math.round(viewerData.length / 1024), 'KB');
          closeSidePanel(); resolve(viewerData); return;
        }
      }
      if (inspectResult.downloadUrl) {
        console.log('[Portility] Found download URL:', inspectResult.downloadUrl.substring(0, 150));
        var dlUrlData = await window.PortilityShared.fetchWithCookies(inspectResult.downloadUrl);
        if (dlUrlData && dlUrlData.length > 500 && dlUrlData.indexOf('data:text/html') !== 0) {
          console.log('[Portility] Downloaded via metadata URL:', Math.round(dlUrlData.length / 1024), 'KB');
          closeSidePanel(); resolve(dlUrlData); return;
        }
      }
      // Strategy 2c: Deep search Angular component state for file references
      var deepResult = await new Promise(function (r) {
        chrome.runtime.sendMessage({ type: 'MAIN_WORLD_DEEP_FILE_SEARCH' }, function (res) { r(res || {}); });
      });
      if (deepResult.results && deepResult.results.length > 0) {
        // Check if we found a ds token or download URL from deep search
        for (var di = 0; di < deepResult.results.length; di++) {
          var dv = deepResult.results[di].v;
          if (dv.indexOf('AAEAbe') === 0 && !inspectResult.dsToken) {
            console.log('[Portility] Deep search found ds token!');
            var dsUrl = 'https://drive.google.com/viewer/upload?ds=' + dv;
            var dsData = await window.PortilityShared.fetchWithCookies(dsUrl);
            if (dsData && dsData.length > 500) {
              console.log('[Portility] Downloaded via deep ds token:', Math.round(dsData.length / 1024), 'KB');
              closeSidePanel(); resolve(dsData); return;
            }
          }
          if (/^https?:\/\/.*(?:download|export|file|drive|viewer|blob)/i.test(dv) && !inspectResult.downloadUrl) {
            console.log('[Portility] Deep search found URL:', dv.substring(0, 150));
            var deepUrlData = await window.PortilityShared.fetchWithCookies(dv);
            if (deepUrlData && deepUrlData.length > 500 && deepUrlData.indexOf('data:text/html') !== 0) {
              console.log('[Portility] Downloaded via deep URL:', Math.round(deepUrlData.length / 1024), 'KB');
              closeSidePanel(); resolve(deepUrlData); return;
            }
          }
        }
      }

      // Strategy 3: Trusted click on citation button (uploaded files)
      if (priority === 2) {
        var citBtn = document.querySelector('button[aria-label*="source"][aria-label*="side panel"]');
        if (citBtn) {
          console.log('[Portility] Trusted click on citation button for:', filename);
          var citResult = await clickAndCapture(citBtn, 'cit', true);
          var citData = await resolveCapture(citResult, filename);
          if (citData) { closeSidePanel(); resolve(citData); return; }
        }
      }

      // Strategy 4: Search the side panel DOM for download links/buttons
      // After the chip click opened the panel, search for anything downloadable
      await new Promise(function (r) { setTimeout(r, 1500); });
      var panelEls = document.querySelectorAll(
        '[aria-label*="ownload"], [aria-label*="ave"], a[download], ' +
        'a[href*="download"], a[href*="export"], a[href*="drive.google.com"]');
      for (var pe = 0; pe < panelEls.length; pe++) {
        var href = panelEls[pe].href || panelEls[pe].getAttribute('href') || '';
        if (href && href.indexOf('http') === 0 && href.indexOf('play.google.com') === -1) {
          console.log('[Portility] Found download element in panel:', panelEls[pe].tagName,
            'aria:', (panelEls[pe].getAttribute('aria-label') || '').substring(0, 40),
            'href:', href.substring(0, 120));
          var panelData = await window.PortilityShared.fetchWithCookies(href);
          if (panelData && panelData.length > 500 && panelData.indexOf('data:text/html') !== 0) {
            console.log('[Portility] Downloaded via panel link:', Math.round(panelData.length / 1024), 'KB');
            closeSidePanel(); resolve(panelData); return;
          }
        }
      }

      // Strategy 5: Trusted click on download button (if Drive viewer is open)
      var dlBtn = document.querySelector(
        '[aria-label="Download"], [aria-label*="ownload"][role="button"]');
      if (dlBtn && dlBtn.offsetHeight > 0) {
        console.log('[Portility] Trusted click on download button');
        var dlResult = await clickAndCapture(dlBtn, 'dl', true);
        var dlData = await resolveCapture(dlResult, filename);
        if (dlData) { closeSidePanel(); resolve(dlData); return; }
      }

      closeSidePanel();
      resolve(null);
    });
  }

  /**
   * Process captured URLs/blobs from clickAndCapture.
   * Returns a data URL string if successful, or null.
   */
  async function resolveCapture(result, filename) {
    var captured = result && result.captured;
    if (!captured || captured.length === 0) return null;

    // First: check for items where the blob was already read as data URL
    // Skip image thumbnails (small webp/png/jpg) — we want actual file content
    for (var d = 0; d < captured.length; d++) {
      if (captured[d].dataUrl) {
        var blobType = captured[d].type || '';
        var isImage = blobType.indexOf('image/') === 0;
        if (isImage) continue;
        return captured[d].dataUrl;
      }
    }

    // Second: collect fetchable URLs — prioritize Drive viewer and response-extracted URLs
    var fetchUrls = [];
    var seenUrls = {};
    for (var u = 0; u < captured.length; u++) {
      var url = captured[u].url;
      if (!url || url.indexOf('blob:') === 0) continue;
      // Make relative URLs absolute
      if (url.indexOf('/') === 0) url = location.origin + url;
      // Skip unfetchable URLs
      if (url.indexOf('http') !== 0) continue;
      // Skip analytics, logging, icons, images
      if (/play\.google\.com\/log|\/type\/|\/icon|\.svg|favicon/i.test(url)) continue;
      // Skip POST-only endpoints (can't GET them)
      if (/batchexecute/i.test(url) && captured[u].source === 'xhr') continue;
      // Skip viewer rendering endpoints (upload, gpaper, meta return internal formats, not original files)
      if (/viewer\/(upload|gpaper|meta|presspage|img)/i.test(url)) continue;
      // Dedup
      var urlKey = url.substring(0, 200);
      if (seenUrls[urlKey]) continue;
      seenUrls[urlKey] = true;
      // Prioritize URLs found inside XHR responses and Drive viewer upload URLs
      var priority = 0;
      if (captured[u].source === 'xhr-response-url') priority = 3;
      if (/viewer\/upload/i.test(url)) priority = 2;
      if (/viewer\/download/i.test(url)) priority = 4;
      if (/googleapis\.com.*download|export/i.test(url)) priority = 3;
      fetchUrls.push({ url: url, priority: priority, source: captured[u].source });
    }

    // For Drive viewer URLs with an id param, also try the download endpoint
    for (var v = 0; v < captured.length; v++) {
      var vUrl = captured[v].url || '';
      if (vUrl.indexOf('drive.google.com/viewer/') !== -1) {
        var idMatch = vUrl.match(/[?&]id=([^&]+)/);
        if (idMatch && !seenUrls['dl:' + idMatch[1]]) {
          seenUrls['dl:' + idMatch[1]] = true;
          var dlUrl = 'https://drive.google.com/viewer/download?id=' + idMatch[1];
          fetchUrls.push({ url: dlUrl, priority: 5, source: 'derived-download' });
        }
      }
    }

    // Sort by priority descending, try highest priority first
    fetchUrls.sort(function (a, b) { return b.priority - a.priority; });
    var pdfFallback = null;

    for (var f = 0; f < fetchUrls.length; f++) {
      console.log('[Portility] Fetching [p' + fetchUrls[f].priority + '] (' + fetchUrls[f].source + '):', fetchUrls[f].url.substring(0, 150));
      var dataUrl = await window.PortilityShared.fetchWithCookies(fetchUrls[f].url);
      if (dataUrl) {
        // Verify we got actual file content, not an HTML page or error
        var isHtml = dataUrl.indexOf('data:text/html') === 0;
        var isSmall = dataUrl.length < 500;
        if (isHtml) {
          console.log('[Portility] Skipping HTML response for', filename);
          continue;
        }
        if (isSmall) {
          console.log('[Portility] Skipping tiny response for', filename, '(' + dataUrl.length + ' bytes)');
          continue;
        }
        // Check if MIME matches expected file type (skip PDF-converted responses for non-PDF files)
        var respMime = (dataUrl.match(/^data:([^;,]+)/) || [])[1] || '';
        var fileExt = (filename.match(/\.([^.]+)$/) || [])[1] || '';
        if (fileExt && respMime === 'application/pdf' && !/^pdf$/i.test(fileExt)) {
          console.log('[Portility] Skipping PDF-converted response for', filename, '(' + fetchUrls[f].source + ')');
          if (!pdfFallback) pdfFallback = dataUrl; // keep as fallback
          continue;
        }
        console.log('[Portility] Downloaded', filename + ':', Math.round(dataUrl.length / 1024), 'KB');
        return dataUrl;
      }
    }

    // If we skipped PDF-converted responses, return the PDF as fallback
    if (pdfFallback) {
      console.log('[Portility] No original format found for', filename, '— using PDF fallback');
      return pdfFallback;
    }
    return null;
  }

  function closeSidePanel() {
    // Press Escape to close overlay/viewer
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    // Hide Drive viewer if present (Google Closure buttons don't respond to programmatic clicks)
    var driveViewer = document.querySelector('.drive-viewer');
    if (driveViewer) {
      // Find the container that wraps the entire viewer overlay
      var container = driveViewer.closest('[class*="cdk-overlay"]') ||
        driveViewer.closest('[class*="viewer-container"]') ||
        driveViewer.parentElement;
      if (container) {
        container.style.display = 'none';
      } else {
        driveViewer.style.display = 'none';
      }
    }
    setTimeout(function () {
      var closeBtn = document.querySelector(
        '[aria-label="Close"], [aria-label="Close panel"], [aria-label="Close side panel"], ' +
        'button[class*="close"], [class*="close-button"]'
      );
      if (closeBtn && closeBtn.offsetHeight > 0) closeBtn.click();
    }, 300);
  }

  /**
   * Detect uploaded file attachments in Gemini conversations.
   * Gemini renders uploaded files as chips/cards near user turns,
   * not as standard <a href> links.
   * @param {Element} scope - Conversation scope element
   * @param {Array} existingAssets - Already-detected assets (to deduplicate)
   * @returns {Promise<Array>} New file assets detected
   */
  async function detectGeminiFileAttachments(scope, existingAssets) {
    var candidates = [];
    var seenFiles = {};

    // Build set of existing filenames for dedup
    var existingNames = {};
    for (var e = 0; e < existingAssets.length; e++) {
      if (existingAssets[e].filename) existingNames[existingAssets[e].filename.toLowerCase()] = true;
      if (existingAssets[e].alt) existingNames[existingAssets[e].alt.toLowerCase()] = true;
    }

    // Scan BOTH human and AI turns — Gemini can create files in its responses
    var humanTurns = findHumanTurns(scope);
    var aiTurns = findAiTurns(scope);
    var allTurns = humanTurns.map(function (el) { return { el: el, role: 'Human' }; })
      .concat(aiTurns.map(function (el) { return { el: el, role: 'Assistant' }; }));
    console.log('[Portility] Gemini file scan: checking', humanTurns.length, 'human +', aiTurns.length, 'AI turn(s)');

    for (var h = 0; h < allTurns.length; h++) {
      var turn = allTurns[h].el;
      var role = allTurns[h].role;

      // Walk up the DOM from the turn element looking for file chips in siblings
      var node = turn;
      for (var level = 0; level < 6; level++) {
        var parent = node.parentElement;
        if (!parent || parent.tagName === 'BODY') break;

        for (var s = 0; s < parent.children.length; s++) {
          var sib = parent.children[s];
          if (sib === node || sib === turn) continue;

          // Skip if sibling contains another conversation turn
          var isTurn = false;
          var allSels = HUMAN_SELECTORS.concat(AI_SELECTORS);
          for (var sel = 0; sel < allSels.length; sel++) {
            try {
              if (sib.matches(allSels[sel]) || sib.querySelector(allSels[sel])) { isTurn = true; break; }
            } catch (ex) { /* ignore invalid selector */ }
          }
          if (isTurn) continue;

          scanForFileChips(sib, h, role, candidates, seenFiles, existingNames);
        }

        node = parent;
      }

      // Also check inside the turn element itself
      scanForFileChips(turn, h, role, candidates, seenFiles, existingNames);
    }

    // Strategy 2: Look for Gemini's file preview elements (uploaded files)
    // These are custom elements like <user-query-file-preview> with class
    // "file-preview-container" / "new-file-preview-container clickable"
    scanForGeminiFilePreviews(scope, candidates, seenFiles, existingNames);

    // Strategy 3: Scan AI turns for file output cards
    scanForFileOutputCards(scope, aiTurns, candidates, seenFiles, existingNames);

    // Strategy 4: Scan entire scope for download buttons/links
    scanForDownloadElements(scope, candidates, seenFiles, existingNames);

    // Strategy 5: Search for GENERATED-FILE custom elements (code execution outputs)
    // These live OUTSIDE the conversation scope in Gemini's DOM, so we search document
    scanForGeneratedFileElements(document, candidates, seenFiles, existingNames);

    // Cross-reference: if we found citation buttons with known types (e.g. "DOCX", "PDF"),
    // use them to fix extensions on file previews that lack an extension
    var citationTypes = [];
    for (var ct = 0; ct < candidates.length; ct++) {
      var citName = candidates[ct].filename || '';
      var citMatch = citName.match(/^document\.(docx?|pdf|xlsx?|csv|txt|pptx?|html|json|xml|zip|py|js|ts|md|rtf)$/i);
      if (citMatch) citationTypes.push(citMatch[1].toLowerCase());
    }
    if (citationTypes.length > 0) {
      for (var fx = 0; fx < candidates.length; fx++) {
        var fn = candidates[fx].filename;
        // If this candidate has no extension and there's a citation type, add it
        if (fn && fn.indexOf('.') === -1 && citationTypes.length > 0) {
          candidates[fx].filename = fn + '.' + citationTypes[0];
          console.log('[Portility] Added extension from citation:', candidates[fx].filename);
        }
      }
    }

    // Remove citation-button "document.xxx" entries when we have the actual file preview
    // (the citation just references the same file with a generic name)
    var hasRealFiles = candidates.some(function (c) { return c._priority >= 2; });
    if (hasRealFiles) {
      candidates = candidates.filter(function (c) {
        if (/^document\.\w+$/i.test(c.filename) && !c._priority) {
          console.log('[Portility] Removing generic citation entry:', c.filename, '(have real file previews)');
          return false;
        }
        return true;
      });
    }

    // Sort: file previews (priority 2) > output cards (priority 1) > others
    candidates.sort(function (a, b) { return (b._priority || 0) - (a._priority || 0); });

    console.log('[Portility] Gemini file scan: found', candidates.length, 'file attachment(s)',
      candidates.map(function (c) { return c.filename + ' [p' + (c._priority || 0) + ']'; }).join(', '));

    // Sort by priority: extract generated files (p1) before uploaded files (p2)
    // so the Drive viewer isn't occupied when generated files need it
    candidates.sort(function (a, b) { return (a._priority || 9) - (b._priority || 9); });

    // For files without URLs, try click-based extraction (with delay between each)
    var newAssets = [];
    for (var f = 0; f < candidates.length; f++) {
      var cand = candidates[f];
      if (!cand.url && cand._el) {
        // Wait between extractions to let Drive viewer close
        if (f > 0) {
          await new Promise(function (r) { setTimeout(r, 1000); });
          closeSidePanel();
          await new Promise(function (r) { setTimeout(r, 1500); });
        }
        console.log('[Portility] Attempting click-based extraction for:', cand.filename, '[p' + (cand._priority || 0) + ']');
        var dataUrl = await extractGeminiFileViaClick(cand._el, cand.filename, cand._priority, cand._genFileEl);
        if (dataUrl) cand.dataUrl = dataUrl;
      }
      newAssets.push({
        type: 'file',
        url: cand.url,
        alt: cand.filename,
        thumbnailUrl: null,
        filename: cand.filename,
        turnIndex: cand.turnIndex,
        role: cand.role || 'Assistant',
        dataUrl: cand.dataUrl || null,
      });
    }

    return newAssets;
  }

  // File type labels Gemini uses in citation buttons (without the dot prefix)
  var FILE_TYPE_LABELS = /^(DOCX?|PDF|XLSX?|CSV|TXT|PPTX?|HTML|JSON|XML|ZIP|PY|JS|TS|MD|RTF)(\+\s*\d+)?$/i;

  /**
   * Scan for download buttons, links, and file-related elements that
   * aren't standard <a href> with file extensions. Gemini renders
   * generated files as download cards/buttons or citation buttons
   * with file-type labels like "DOCX", "PDF", "DOCX+ 1".
   */
  /**
   * Scan AI turns for file output cards — Gemini renders generated files
   * as card elements with an icon and filename (e.g. "conversation_summary").
   * These don't have file extensions and aren't citation buttons.
   */
  /**
   * Scan for Gemini's file preview elements — uploaded files that appear
   * as card/thumbnail elements using custom elements like:
   *   <user-query-file-carousel>, <user-query-file-preview>,
   *   div.file-preview-container, div.new-file-preview-container.clickable
   */
  function scanForGeminiFilePreviews(scope, results, seenFiles, existingNames) {
    // Look for Gemini's file preview custom elements and containers
    var previewEls = scope.querySelectorAll(
      'user-query-file-preview, user-query-file-carousel, ' +
      '[class*="file-preview-container"], [class*="query-file-preview"], ' +
      '[class*="query-file-carousel"]'
    );

    for (var p = 0; p < previewEls.length; p++) {
      var preview = previewEls[p];
      var text = (preview.textContent || '').trim();
      if (!text || text.length < 2 || text.length > 200) continue;

      // Extract filename from text (might include line breaks)
      var filename = text.replace(/\s+/g, '_').replace(/_+/g, '_');

      var key = filename.toLowerCase();
      if (seenFiles[key]) continue;

      // Skip image files (handled by image detection)
      if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(filename)) continue;

      seenFiles[key] = true;

      // Add extension if missing based on nearby context
      if (filename.indexOf('.') === -1) {
        // Check for type badge text inside or near the preview
        var nearbyText = '';
        // Walk up a few levels and check sibling text
        var walkEl = preview;
        for (var w = 0; w < 3; w++) {
          if (walkEl.parentElement) {
            nearbyText += ' ' + (walkEl.parentElement.textContent || '').toLowerCase();
            walkEl = walkEl.parentElement;
          }
        }
        if (/\bpdf\b/.test(nearbyText)) filename += '.pdf';
        else if (/\bdocx?\b/.test(nearbyText)) filename += '.docx';
        else if (/\bxlsx?\b/.test(nearbyText)) filename += '.xlsx';
        else if (/\bcsv\b/.test(nearbyText)) filename += '.csv';
        else if (/\bhtml\b/.test(nearbyText)) filename += '.html';
        else if (/\bjson\b/.test(nearbyText)) filename += '.json';
        else if (/\bpy(thon)?\b/.test(nearbyText)) filename += '.py';
        // No extension found — leave as-is, will add .txt as fallback later
      }

      // Find the clickable element inside the preview
      var clickEl = preview.querySelector('[class*="clickable"]') ||
        preview.querySelector('button') ||
        preview.querySelector('[role="button"]') ||
        preview;

      results.push({
        url: null,
        filename: filename,
        turnIndex: 0,
        role: 'Human',
        dataUrl: null,
        _el: clickEl,
        _priority: 2, // Highest priority — actual file previews
      });
      console.log('[Portility] Detected Gemini file preview:', filename,
        'click target:', clickEl.tagName + '.' + (clickEl.className || '').toString().substring(0, 60));
    }
  }

  // scanForFileOutputCards is now handled by scanForGeneratedFileElements (Strategy 5)
  function scanForFileOutputCards(scope, aiTurns, results, seenFiles, existingNames) {
    // No-op: generated file detection moved to scanForGeneratedFileElements
    // which searches document-wide for <generated-file> custom elements
  }

  /**
   * Strategy 5: Detect Gemini-generated files (code execution outputs).
   * Gemini renders these as <GENERATED-FILE> custom elements inside
   * <RESPONSE-ELEMENT> / <DIV class="attachment-container">.
   * These live OUTSIDE the conversation scope in the DOM, so we search
   * the provided root (typically document).
   *
   * DOM structure:
   *   RESPONSE-ELEMENT > GENERATED-FILE.ng-star-inserted
   *     > DIV.chip.clickable
   *       > DIV.file-name  (filename text)
   *       > (type label, e.g. "PDF")
   *       > (Open button)
   */
  function scanForGeneratedFileElements(root, results, seenFiles, existingNames) {
    // Primary: find <generated-file> custom elements
    var genFiles = root.querySelectorAll('generated-file');
    // Fallback: also check attachment containers and response elements
    if (genFiles.length === 0) {
      genFiles = root.querySelectorAll(
        '[class*="attachment-container"], response-element, ' +
        '[class*="generated-file"], [class*="file-output"]'
      );
    }

    console.log('[Portility] Generated file scan: found', genFiles.length, '<generated-file> element(s)');

    for (var gf = 0; gf < genFiles.length; gf++) {
      var gfEl = genFiles[gf];

      // Extract filename from .file-name element or direct text
      var nameEl = gfEl.querySelector('.file-name, [class*="file-name"]');
      var filename = nameEl ? nameEl.textContent.trim() : '';

      if (!filename) {
        // Fallback: extract from full text, removing known button/label words
        var fullText = (gfEl.textContent || '').trim();
        filename = fullText
          .replace(/\b(Open|Download|View|Save)\b/gi, '')
          .replace(/\b(PDF|DOCX?|XLSX?|CSV|TXT|PPTX?|HTML|JSON|XML|ZIP)\b/gi, '')
          .trim()
          .replace(/\s+/g, '_')
          .replace(/_+/g, '_');
      }

      if (!filename || filename.length < 3) continue;

      // Clean up filename
      filename = filename.replace(/\s+/g, '_').replace(/_+/g, '_');

      // Determine file type from sibling text or nearby context
      var cardText = (gfEl.textContent || '').trim();
      var typeMatch = cardText.match(/\b(PDF|DOCX?|XLSX?|CSV|TXT|PPTX?|HTML|JSON|XML|ZIP|PY|JS|TS|MD|RTF)\b/i);
      var fileType = typeMatch ? typeMatch[1].toLowerCase() : null;

      // Add extension if missing
      if (filename.indexOf('.') === -1) {
        filename += '.' + (fileType || 'pdf');
      }

      var key = filename.toLowerCase();
      if (seenFiles[key] || existingNames[key]) continue;
      if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(filename)) continue;

      seenFiles[key] = true;

      // Extract URL from any <a href> inside the card
      var linkEl = gfEl.querySelector('a[href]');
      var url = linkEl ? linkEl.href : null;
      // Also check the parent response-element and attachment-container
      if (!url) {
        var respEl = gfEl.closest('response-element') || gfEl.parentElement;
        if (respEl) {
          var parentLink = respEl.querySelector('a[href]');
          if (parentLink) url = parentLink.href;
        }
      }

      // Click target: the clickable chip/card div, or the element itself
      var clickEl = gfEl.querySelector('[class*="clickable"]') ||
        gfEl.querySelector('.chip') ||
        gfEl.querySelector('button, a[href], [role="button"]') ||
        gfEl;

      results.push({
        url: url,
        filename: filename,
        turnIndex: -1,
        role: 'Assistant',
        dataUrl: null,
        _el: clickEl,
        _genFileEl: gfEl, // keep reference to full generated-file element for Open button
        _priority: 1,
      });
      console.log('[Portility] Detected Gemini generated file:', filename,
        'type:', fileType, 'url:', url ? url.substring(0, 100) : 'none',
        'clickTag:', clickEl.tagName);
    }
  }

  function scanForDownloadElements(scope, results, seenFiles, existingNames) {
    // Strategy A: Standard download elements
    var downloadEls = scope.querySelectorAll(
      'a[download], a[href*="download"], button[aria-label*="ownload"], ' +
      '[class*="download"], [data-action*="download"], ' +
      'a[href*="drive.google"], a[href*="blob:"]'
    );

    for (var d = 0; d < downloadEls.length; d++) {
      addDownloadCandidate(downloadEls[d], results, seenFiles, existingNames);
    }

    // Strategy B: Gemini file citation buttons — buttons with file-type text
    // (e.g. "DOCX", "PDF", "DOCX+ 1") and aria-label containing "source"
    var allButtons = scope.querySelectorAll('button');
    var seenFileTypes = {};
    for (var b = 0; b < allButtons.length; b++) {
      var btn = allButtons[b];
      var btnText = (btn.textContent || '').trim();
      var btnAria = btn.getAttribute('aria-label') || '';

      // Check if button text matches a file type label
      if (!FILE_TYPE_LABELS.test(btnText)) continue;

      // Extract the base file type (e.g. "DOCX" from "DOCX+ 1")
      var typeMatch = btnText.match(/^(DOCX?|PDF|XLSX?|CSV|TXT|PPTX?|HTML|JSON|XML|ZIP|PY|JS|TS|MD|RTF)/i);
      if (!typeMatch) continue;
      var fileType = typeMatch[1].toLowerCase();

      // Only add one entry per file type (avoid duplicating citation variants)
      if (seenFileTypes[fileType]) continue;
      seenFileTypes[fileType] = true;

      var filename = 'document.' + fileType;
      var key = filename.toLowerCase();
      if (seenFiles[key] || existingNames[key]) continue;

      seenFiles[key] = true;
      results.push({
        url: null,
        filename: filename,
        turnIndex: -1,
        role: 'Assistant',
        dataUrl: null,
        _el: btn,
      });
      console.log('[Portility] Detected Gemini file citation button:', filename, 'text:', btnText, 'aria:', btnAria.substring(0, 60));
    }

    // Strategy C: Elements with aria-label containing a filename
    var ariaEls = scope.querySelectorAll('[aria-label]');
    for (var ae = 0; ae < ariaEls.length; ae++) {
      var ariaVal = ariaEls[ae].getAttribute('aria-label') || '';
      var ariaMatch = ariaVal.match(FILE_EXT_PATTERN);
      if (!ariaMatch) continue;
      var ariaFilename = ariaMatch[0].trim();
      var ariaKey = ariaFilename.toLowerCase();
      // Also check without extension for dedup against file previews
      var ariaBase = ariaKey.replace(/\.[^.]+$/, '');
      if (seenFiles[ariaKey] || existingNames[ariaKey] ||
          seenFiles[ariaBase] || existingNames[ariaBase]) continue;
      if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(ariaFilename)) continue;
      seenFiles[ariaKey] = true;
      results.push({
        url: null,
        filename: ariaFilename,
        turnIndex: -1,
        role: 'Assistant',
        dataUrl: null,
        _el: ariaEls[ae],
      });
      console.log('[Portility] Detected file via aria-label:', ariaFilename, 'tag:', ariaEls[ae].tagName);
    }

    // Strategy D: Look for any blob: URLs in <a> tags (generated file downloads)
    var blobLinks = scope.querySelectorAll('a[href^="blob:"]');
    for (var bl = 0; bl < blobLinks.length; bl++) {
      var blobEl = blobLinks[bl];
      var blobKey = blobEl.href;
      if (seenFiles[blobKey]) continue;
      seenFiles[blobKey] = true;
      var blobFilename = blobEl.getAttribute('download') ||
        (blobEl.textContent || '').trim().replace(/\s+/g, '_') || 'download_' + (bl + 1);
      if (blobFilename.indexOf('.') === -1) blobFilename += '.pdf';
      results.push({
        url: blobEl.href,
        filename: blobFilename,
        turnIndex: -1,
        role: 'Assistant',
        dataUrl: null,
        _el: blobEl,
      });
      console.log('[Portility] Detected blob: download link:', blobFilename, 'href:', blobEl.href.substring(0, 60));
    }
  }

  function addDownloadCandidate(el, results, seenFiles, existingNames) {
    var text = (el.textContent || '').trim();
    var href = el.href || el.getAttribute('href') || '';
    var ariaLabel = el.getAttribute('aria-label') || '';
    var download = el.getAttribute('download') || '';

    var filename = download || null;
    if (!filename) {
      var match = text.match(FILE_EXT_PATTERN);
      if (match) filename = match[0].trim();
    }
    if (!filename) {
      var match2 = ariaLabel.match(FILE_EXT_PATTERN);
      if (match2) filename = match2[0].trim();
    }
    if (!filename && href) {
      try {
        var urlPath = new URL(href, location.origin).pathname;
        var urlFile = urlPath.split('/').pop();
        if (urlFile && /\.\w{1,10}$/.test(urlFile)) filename = decodeURIComponent(urlFile);
      } catch (e) { /* ignore */ }
    }
    if (!filename && /download|save/i.test(text + ' ' + ariaLabel)) {
      filename = 'download_' + (results.length + 1) + '.pdf';
    }
    if (!filename) return;

    var key = filename.toLowerCase();
    if (seenFiles[key] || existingNames[key]) return;
    if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(filename)) return;

    seenFiles[key] = true;
    var url = href && href.startsWith('http') ? href : null;
    if (!url && href && href.startsWith('blob:')) url = href;

    results.push({
      url: url,
      filename: filename,
      turnIndex: -1,
      role: 'Assistant',
      dataUrl: null,
      _el: el,
    });
    console.log('[Portility] Detected Gemini download element:', filename, url ? '(URL: ' + url.substring(0, 80) + ')' : '(no URL)', 'tag:', el.tagName, 'text:', text.substring(0, 50));
  }

  function scanForFileChips(container, turnIndex, role, results, seenFiles, existingNames) {
    // Look for elements whose text matches file extension patterns.
    // File chips are typically small, focused elements (not paragraphs).
    var allEls = container.querySelectorAll('*');
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      var text = (el.textContent || '').trim();

      // Skip very long text (paragraphs/containers) or very short text
      if (text.length > 150 || text.length < 3) continue;

      // Check if text contains a filename with a known extension
      var match = text.match(FILE_EXT_PATTERN);
      if (!match) continue;

      var filename = match[0].trim();

      // The filename should be the dominant content of this element
      // (not a sentence that happens to mention a file extension)
      if (filename.length < text.length * 0.3) continue;

      // Skip if it's a large container (not a chip)
      if (el.children.length > 10) continue;

      // Skip if already seen or already detected
      var key = filename.toLowerCase();
      if (seenFiles[key] || existingNames[key]) continue;

      // Skip image files (handled by image detection)
      if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(filename)) continue;

      // Prefer the most specific (deepest) element for this filename
      var hasChildMatch = false;
      for (var c = 0; c < el.children.length; c++) {
        var childText = (el.children[c].textContent || '').trim();
        if (FILE_EXT_PATTERN.test(childText) && childText.length < text.length) {
          hasChildMatch = true;
          break;
        }
      }
      if (hasChildMatch) continue;

      // Skip if this element is inside a code block or pre (conversation content, not a chip)
      if (el.closest('pre') || el.closest('code') || el.closest('[class*="code-block"]')) continue;

      seenFiles[key] = true;

      // Try to find any URL associated with this file
      var url = null;
      var linkEl = el.closest('a[href]') || el.querySelector('a[href]');
      if (linkEl) url = linkEl.href;
      if (!url) {
        var attrs = ['data-url', 'data-href', 'data-src', 'href'];
        for (var a = 0; a < attrs.length; a++) {
          var val = el.getAttribute(attrs[a]);
          if (val && val.startsWith('http')) { url = val; break; }
        }
      }
      if (!url && el.parentElement) {
        var parentLink = el.parentElement.closest('a[href]');
        if (parentLink) url = parentLink.href;
      }

      results.push({
        url: url,
        filename: filename,
        turnIndex: turnIndex,
        role: role,
        dataUrl: null,
        _el: el,
      });
      console.log('[Portility] Detected Gemini file chip:', filename, url ? '(has URL)' : '(no URL)', 'role:', role, 'tag:', el.tagName, 'classes:', (el.className || '').toString().substring(0, 100));
    }
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

          // Detect Gemini-specific file attachments (uploaded files as chips)
          var geminiFiles = await detectGeminiFileAttachments(scope, allAssets);
          if (geminiFiles.length > 0) {
            allAssets = allAssets.concat(geminiFiles);
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
      if (typeof window.dreweryTrack === 'function') {
        window.dreweryTrack('auto_paste_started', { platform: 'gemini' });
      }
      var attempts = 0;
      var interval = setInterval(function () {
        var input = document.querySelector('.ql-editor[contenteditable="true"]')
          || document.querySelector('rich-textarea div[contenteditable="true"]')
          || document.querySelector('div[contenteditable="true"]')
          || document.querySelector('textarea');
        if (input) {
          clearInterval(interval);
          if (typeof window.dreweryTrack === 'function') {
            window.dreweryTrack('auto_paste_input_found', { platform: 'gemini', attempts: attempts });
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

          // Paste pending files, then auto-submit
          chrome.storage.local.get('portility_pending_images', function (imgData) {
            var images = imgData.portility_pending_images;
            var hasImages = images && images.length > 0;
            console.log('[Portility] File check:', hasImages ? images.length + ' file(s) pending' : 'no files in storage');

            function doAutoSubmit(delay) {
              setTimeout(function () {
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
                  } else if (++submitAttempts > 30) {
                    clearInterval(submitInterval);
                    if (typeof window.dreweryTrack === 'function') {
                      window.dreweryTrack('portility_auto_submit', {
                        platform: 'gemini',
                        success: false,
                        reason: sendBtn ? 'button_disabled' : 'button_not_found',
                      });
                    }
                  }
                }, 200);
              }, delay || 500);
            }

            if (hasImages && window.PortilityShared && window.PortilityShared.pasteImages) {
              // Split images and non-image files for separate paste calls
              var imageFiles = images.filter(function (f) { return !f.type || f.type === 'image'; });
              var otherFiles = images.filter(function (f) { return f.type && f.type !== 'image'; });

              var attachBtn = document.querySelector('button[aria-label="Upload file"]')
                || document.querySelector('uploader-button button')
                || document.querySelector('[aria-label="Add image"]');
              if (attachBtn) {
                attachBtn.click();
                setTimeout(function () { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }, 100);
              }

              // Paste images first, then non-image files, then submit
              setTimeout(function () {
                var filesToPaste = imageFiles.length > 0 ? imageFiles : otherFiles;
                var remainingFiles = imageFiles.length > 0 ? otherFiles : [];

                window.PortilityShared.pasteImages(input, filesToPaste, function () {
                  if (remainingFiles.length > 0) {
                    // Paste remaining files after a short delay
                    setTimeout(function () {
                      window.PortilityShared.pasteImages(input, remainingFiles, function () {
                        chrome.storage.local.remove('portility_pending_images');
                        doAutoSubmit(2000);
                      });
                    }, 1000);
                  } else {
                    chrome.storage.local.remove('portility_pending_images');
                    doAutoSubmit(2000);
                  }
                });
              }, 300);
            } else {
              doAutoSubmit(0);
            }
          });
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
    window.dreweryTrack('drewery_page_load', { platform: 'gemini' });
  }
})();
