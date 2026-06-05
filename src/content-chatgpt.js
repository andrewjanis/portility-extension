/**
 * content-chatgpt.js
 * Portility — content script for ChatGPT.
 * Runs on https://chatgpt.com/* pages.
 *
 * Mirrors the structure of content.js (Claude) but uses ChatGPT-specific
 * DOM selectors and handles ChatGPT's particular edge cases:
 *   - data-message-author-role attributes for turn detection
 *   - Tool/system messages excluded (web search, DALL-E steps)
 *   - Regenerated responses: only visible version extracted
 *   - Canvas panel excluded via conversation scope
 */

(function () {
  'use strict';

  // ─── Shared utilities (from content-shared.js) ────────────────────────────
  const { isElementVisible, extractElementText, copyToClipboard, formatConversation } =
    window.PortilityShared;

  // ─── Selectors (overridable via remote config) ───────────────────────────
  let HUMAN_SELECTOR = '[data-message-author-role="user"]';
  let AI_SELECTOR = '[data-message-author-role="assistant"]';

  // Override selectors from remote config cache (non-blocking)
  if (window.PortilityConfig && window.PortilityConfig.getRemoteSelectors) {
    window.PortilityConfig.getRemoteSelectors('chatgpt').then(function (sel) {
      if (!sel) return;
      if (sel.humanSelector) HUMAN_SELECTOR = sel.humanSelector;
      if (sel.aiSelector) AI_SELECTOR = sel.aiSelector;
    });
  }

  // ─── Conversation scope ───────────────────────────────────────────────────
  /**
   * Find the scrollable container that holds the active conversation thread.
   * Strategy: anchor on the first visible user message, walk up until we find
   * a scrollable container. Fall back to <main> or <body>.
   */
  function getConversationScope() {
    const anchor = document.querySelector(HUMAN_SELECTOR);
    if (anchor && isElementVisible(anchor)) {
      let el = anchor.parentElement;
      while (el && el.tagName !== 'BODY') {
        const overflow = window.getComputedStyle(el).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') {
          return el;
        }
        el = el.parentElement;
      }
    }
    return document.querySelector('main') || document.body;
  }

  // ─── Turn finders ─────────────────────────────────────────────────────────
  function findHumanTurns(scope) {
    return Array.from(scope.querySelectorAll(HUMAN_SELECTOR))
      .filter(isElementVisible);
  }

  function findAiTurns(scope) {
    return Array.from(scope.querySelectorAll(AI_SELECTOR))
      .filter(isElementVisible);
  }

  // ─── Image detection ──────────────────────────────────────────────────────
  /**
   * Check if a user message element contains an uploaded image.
   * ChatGPT renders user-uploaded images as <img> tags within or near
   * the message container.
   * @param {Element} el
   * @returns {string}
   */
  function getImagePrefix(el) {
    // Check inside the message element itself
    if (el.querySelector('img')) return '[image attached]\n';

    // Check siblings and nearby ancestors (ChatGPT may place images
    // in a sibling container above the text)
    let node = el;
    for (let level = 0; level < 5; level++) {
      const parent = node.parentElement;
      if (!parent || parent.tagName === 'BODY') break;

      for (const sib of parent.children) {
        if (sib === node) continue;
        // Stop if we hit another message turn
        if (sib.querySelector(HUMAN_SELECTOR) || sib.querySelector(AI_SELECTOR)) {
          return '';
        }
        if (sib.querySelector('img')) return '[image attached]\n';
      }

      node = parent;
    }

    return '';
  }

  // ─── Conversation detection ───────────────────────────────────────────────
  function hasActiveConversation() {
    if (!/chatgpt\.com/i.test(location.href)) return false;
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

      // For human turns, prepend image placeholder if an image was attached
      if (item.role === 'Human') {
        var prefix = getImagePrefix(item.el);
        if (prefix) text = prefix + text;
      }

      return { role: item.role, text: text };
    }).filter(function (item) { return item.text.trim().length > 0; });
  }

  // ─── ChatGPT file download interception ───────────────────────────────────
  /**
   * Click a ChatGPT download button and intercept the blob download.
   * ChatGPT downloads files by creating a hidden <a download href="blob:...">
   * and clicking it. We override HTMLAnchorElement.prototype.click to capture
   * the blob before the real download fires.
   * @param {Element} btnEl - The download button element
   * @returns {Promise<{dataUrl: string|null, filename: string|null}>}
   */
  /**
   * Fetch ChatGPT conversation data and download file attachments via API.
   * Works for code interpreter outputs, DALL-E images, and uploaded files.
   * @returns {Promise<Array>} file assets with dataUrl populated
   */
  async function getChatGPTAccessToken() {
    try {
      var resp = await fetch('/api/auth/session', { credentials: 'include' });
      if (!resp.ok) return null;
      var data = await resp.json();
      return data.accessToken || null;
    } catch (e) {
      console.log('[Portility] Failed to get access token:', e.message);
      return null;
    }
  }

  async function detectChatGPTFileAttachments() {
    var convMatch = location.pathname.match(/\/c\/([a-f0-9-]+)/i);
    if (!convMatch) {
      console.log('[Portility] No conversation ID in URL');
      return [];
    }
    var convId = convMatch[1];

    try {
      var token = await getChatGPTAccessToken();
      console.log('[Portility] Access token:', token ? 'obtained' : 'missing');

      var headers = {};
      if (token) headers['Authorization'] = 'Bearer ' + token;

      var resp = await fetch('/backend-api/conversation/' + convId, {
        credentials: 'include',
        headers: headers,
      });
      if (!resp.ok) {
        console.log('[Portility] Conversation API returned', resp.status);
        return [];
      }
      var data = await resp.json();
      var mapping = data.mapping || {};
      var fileEntries = [];

      // Scan all messages for file references
      var seenFileIds = {};
      for (var key in mapping) {
        var node = mapping[key];
        if (!node.message) continue;
        var msg = node.message;
        var meta = msg.metadata || {};
        var role = (msg.author && msg.author.role) || '';
        var authorRole = (msg.author && msg.author.role) || '';

        function addFile(fileId, type, filename, mimeType, messageId) {
          if (!fileId || seenFileIds[fileId]) return;
          seenFileIds[fileId] = true;
          fileEntries.push({ fileId: fileId, type: type, filename: filename, mimeType: mimeType, role: role, messageId: messageId || msg.id });
        }

        // Code interpreter / sandbox outputs in aggregate_result
        if (meta.aggregate_result && meta.aggregate_result.messages) {
          meta.aggregate_result.messages.forEach(function (m) {
            var fid = (m.image_url || m.file_url || m.url || '').replace(/^[a-z-]+:\/\//i, '');
            if (fid) {
              var isImg = m.message_type === 'image';
              addFile(fid, isImg ? 'image' : 'file', null, null);
            }
            // Check for sandbox_path
            if (m.sandbox_path) {
              var fname = m.sandbox_path.split('/').pop();
              addFile('sandbox:' + m.sandbox_path, 'file', fname, null);
            }
            // Check stdout for sandbox file paths (e.g. "Saved ... to: /mnt/data/file.docx")
            if (m.message_type === 'stream' && m.text) {
              var pathMatch = m.text.match(/\/mnt\/data\/[^\s"'\n]+/);
              if (pathMatch) {
                var spath = pathMatch[0];
                var sfname = spath.split('/').pop();
                console.log('[Portility] Found sandbox path in stdout:', spath);
                addFile('sandbox:' + spath, 'file', sfname, null);
                // Store the message_id for this file's download
                fileEntries.forEach(function (fe) {
                  if (fe.fileId === 'sandbox:' + spath) fe.messageId = msg.id;
                });
              }
            }
          });
        }

        // File attachments on messages (user uploads or assistant outputs)
        if (meta.attachments && meta.attachments.length > 0) {
          meta.attachments.forEach(function (att) {
            var isImg = /^image\//i.test(att.mime_type || '');
            addFile(att.id, isImg ? 'image' : 'file', att.name || null, att.mime_type || null);
          });
        }

        // Image/file asset pointers in content parts
        if (msg.content && msg.content.parts) {
          msg.content.parts.forEach(function (part) {
            if (typeof part === 'object' && part.asset_pointer) {
              var fid = part.asset_pointer.replace(/^[a-z-]+:\/\//i, '');
              var isImg = (part.content_type || '').includes('image');
              addFile(fid, isImg ? 'image' : 'file', null, part.content_type || null);
            }
          });
        }

        // Check for sandbox download links in assistant content
        if (authorRole === 'assistant' && msg.content && msg.content.parts) {
          msg.content.parts.forEach(function (part) {
            if (typeof part === 'string') {
              // Look for sandbox file paths
              var sandboxMatches = part.match(/sandbox:\/[^\s"')\]]+/g);
              if (sandboxMatches) {
                sandboxMatches.forEach(function (path) {
                  var cleanPath = path.replace('sandbox:', '');
                  var fname = cleanPath.split('/').pop();
                  console.log('[Portility] Found sandbox path:', path, 'filename:', fname);
                  addFile(path, 'file', fname, null);
                });
              }
            }
          });
        }
      }

      console.log('[Portility] ChatGPT API found', fileEntries.length, 'file entries');

      // Download each file
      var assets = [];
      for (var i = 0; i < fileEntries.length; i++) {
        var entry = fileEntries[i];
        if (!entry.fileId) continue;

        var dataUrl = await downloadChatGPTFile(entry.fileId, token, entry.messageId);
        if (dataUrl) {
          var cleanName = (entry.filename || entry.fileId).replace(/^[a-z-]+:\/\//i, '');
          var fname = cleanName || (entry.type === 'image' ? 'image.png' : 'file.bin');
          // Add extension if missing
          if (fname.indexOf('.') === -1) fname += (entry.type === 'image' ? '.png' : '.bin');
          assets.push({
            type: entry.type || 'file',
            url: null,
            alt: fname,
            thumbnailUrl: null,
            filename: fname,
            turnIndex: 0,
            role: entry.role || 'Assistant',
            dataUrl: dataUrl,
            _fileId: entry.fileId.replace(/^[a-z-]+:\/\//i, ''),
          });
          console.log('[Portility] Downloaded ChatGPT file:', fname, '(' + Math.round(dataUrl.length / 1024) + ' KB)');
        }
      }

      return assets;
    } catch (err) {
      console.log('[Portility] ChatGPT file detection error:', err.message || err);
      return [];
    }
  }

  /**
   * Download a file from ChatGPT's backend API.
   * @param {string} fileId - File ID (e.g. "file-abc123")
   * @returns {Promise<string|null>} data URL or null
   */
  async function downloadChatGPTFile(fileId, token, messageId) {
    // Strip protocol prefixes (sediment://, file-service://, etc.)
    var cleanId = fileId.replace(/^[a-z-]+:\/\//i, '');

    // For sandbox paths, use the conversation download endpoint
    var convMatch = location.pathname.match(/\/c\/([a-f0-9-]+)/i);
    var convId = convMatch ? convMatch[1] : null;

    var urls = [
      '/backend-api/files/' + cleanId + '/download',
    ];
    // If it looks like a sandbox path, try conversation-scoped download with required params
    if (fileId.startsWith('sandbox:') && convId) {
      var sandboxPath = fileId.replace('sandbox:', '');
      var interpreterUrl = '/backend-api/conversation/' + convId + '/interpreter/download'
        + '?message_id=' + encodeURIComponent(messageId || '')
        + '&sandbox_path=' + encodeURIComponent(sandboxPath);
      urls.unshift(interpreterUrl);
    }
    urls.push('/backend-api/sentinel/download/' + cleanId);

    var headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;

    for (var u = 0; u < urls.length; u++) {
      try {
        var resp = await fetch(urls[u], { credentials: 'include', headers: headers });
        console.log('[Portility] Try download', urls[u], '→', resp.status);
        if (!resp.ok) {
          // Log error body for debugging
          try { var errBody = await resp.text(); console.log('[Portility] Error body:', errBody.substring(0, 200)); } catch (e) {}
          continue;
        }

        // Check if response is a redirect URL (JSON with download_url)
        var contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          var json = await resp.json();
          var dlUrl = json.download_url || json.url || null;
          if (dlUrl) {
            console.log('[Portility] Got redirect URL:', dlUrl.substring(0, 80));
            var dlResp = await fetch(dlUrl);
            if (dlResp.ok) {
              var blob = await dlResp.blob();
              return await blobToDataUrl(blob);
            }
          }
          continue;
        }

        // Direct binary response
        var blob = await resp.blob();
        if (blob.size > 0) {
          return await blobToDataUrl(blob);
        }
      } catch (e) {
        console.log('[Portility] Download attempt failed:', urls[u], e.message);
      }
    }
    return null;
  }

  function blobToDataUrl(blob) {
    return new Promise(function (res) {
      var reader = new FileReader();
      reader.onload = function () { res(reader.result); };
      reader.onerror = function () { res(null); };
      reader.readAsDataURL(blob);
    });
  }

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

          // Detect ChatGPT file attachments via conversation API
          var chatgptFiles = await detectChatGPTFileAttachments();
          if (chatgptFiles.length > 0) {
            // Deduplicate: API downloads have full-quality data, so they replace
            // any DOM-extracted asset with the same filename or file ID in URL.
            var apiFileNames = {};
            var apiFileIds = [];
            for (var af = 0; af < chatgptFiles.length; af++) {
              apiFileNames[(chatgptFiles[af].filename || '').toLowerCase()] = true;
              if (chatgptFiles[af]._fileId) apiFileIds.push(chatgptFiles[af]._fileId);
            }
            allAssets = allAssets.filter(function (a) {
              if (apiFileNames[(a.filename || '').toLowerCase()]) return false;
              var aUrl = (a.url || '');
              for (var fi = 0; fi < apiFileIds.length; fi++) {
                if (aUrl.indexOf(apiFileIds[fi]) >= 0) return false;
              }
              return true;
            });
            allAssets = allAssets.concat(chatgptFiles);
          }

          await window.PortilityShared.captureImageData(allAssets);

          // Strip dataUrl from response to avoid message size limits
          // (captured images are stored directly in chrome.storage.local)
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

        // Only copy to clipboard for direct Copy button flow, not Summarize
        if (!message.skipClipboard) {
          await copyToClipboard(formatted);
        }

        if (typeof window.dreweryTrack === 'function') {
          window.dreweryTrack('drewery_extract_success', {
            platform: 'chatgpt',
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
            platform: 'chatgpt',
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

    return true; // Keep message channel open for async sendResponse
  });

  // ─── Auto-paste from Portility ────────────────────────────────────────────
  (function setupAutoPaste() {
    var pasting = false;

    function doPaste(text) {
      if (pasting) return;
      pasting = true;
      if (typeof window.dreweryTrack === 'function') {
        window.dreweryTrack('auto_paste_started', { platform: 'chatgpt' });
      }
      var attempts = 0;
      var interval = setInterval(function () {
        var input = document.querySelector('#prompt-textarea')
          || document.querySelector('div[contenteditable="true"]')
          || document.querySelector('textarea');
        if (input) {
          clearInterval(interval);
          if (typeof window.dreweryTrack === 'function') {
            window.dreweryTrack('auto_paste_input_found', { platform: 'chatgpt', attempts: attempts });
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

          // ChatGPT converts large pastes into file attachments.
          // Wait for that to happen, then click "Show in text field" to
          // move the content back inline before auto-submitting.
          setTimeout(function () {
            var showInTextField = document.querySelector('button[class*="show"], a[class*="show"]');
            if (!showInTextField) {
              // Try finding the link by text content
              var allLinks = document.querySelectorAll('a, button, span');
              for (var li = 0; li < allLinks.length; li++) {
                if (/show in text field/i.test(allLinks[li].textContent)) {
                  showInTextField = allLinks[li];
                  break;
                }
              }
            }
            if (showInTextField) {
              showInTextField.click();
              if (typeof window.dreweryTrack === 'function') {
                window.dreweryTrack('chatgpt_attachment_restored', { platform: 'chatgpt' });
              }
            }

            // Dismiss the "Large pastes are now attachments" tooltip if present
            var dismissBtn = document.querySelector('[aria-label="Close"]');
            if (!dismissBtn) {
              var btns = document.querySelectorAll('button');
              for (var di = 0; di < btns.length; di++) {
                if (btns[di].textContent.trim() === '\u00d7' || btns[di].textContent.trim() === 'X') {
                  dismissBtn = btns[di];
                  break;
                }
              }
            }

            // Paste pending images, then auto-submit after settling
            chrome.storage.local.get('portility_pending_images', function (imgData) {
              var images = imgData.portility_pending_images;
              var hasImages = images && images.length > 0;
              console.log('[Portility] ChatGPT auto-paste: images in storage =', hasImages ? images.length : 0);

              if (hasImages && window.PortilityShared && window.PortilityShared.pasteImages) {
                // Check if any files are non-image (need file input for these)
                var hasNonImage = images.some(function (img) {
                  var mime = (img.dataUrl || '').split(';')[0].split(':')[1] || '';
                  return mime && !mime.startsWith('image/');
                });

                // Try clicking attach button to ensure file input is in DOM
                var attachBtn = document.querySelector('button[aria-label="Attach files"]')
                  || document.querySelector('[data-testid="composer-attach-button"]')
                  || document.querySelector('button[aria-label="Upload file"]');

                if (hasNonImage && attachBtn) {
                  // For non-image files: click attach, poll for file input, use it directly
                  attachBtn.click();
                  var fiPollCount = 0;
                  var fiPoll = setInterval(function () {
                    var fileInput = document.querySelector('input[type="file"]');
                    if (fileInput) {
                      clearInterval(fiPoll);
                      // Dismiss menu
                      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                      setTimeout(function () {
                        window.PortilityShared.pasteImages(input, images, function () {
                          chrome.storage.local.remove('portility_pending_images');
                        });
                      }, 200);
                    } else if (++fiPollCount > 15) {
                      clearInterval(fiPoll);
                      // Dismiss and fall back to pasteImages (will try drag-drop for non-images)
                      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                      setTimeout(function () {
                        window.PortilityShared.pasteImages(input, images, function () {
                          chrome.storage.local.remove('portility_pending_images');
                        });
                      }, 200);
                    }
                  }, 100);
                } else {
                  // Image-only path: original behavior
                  if (attachBtn) {
                    attachBtn.click();
                    setTimeout(function () { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }, 100);
                  }
                  setTimeout(function () {
                    window.PortilityShared.pasteImages(input, images, function () {
                      chrome.storage.local.remove('portility_pending_images');
                    });
                  }, 300);
                }
              }

              // Auto-submit: wait for ChatGPT to settle, then poll for send button
              var submitDelay = hasImages ? 2500 : 1500;
              setTimeout(function () {
                var submitAttempts = 0;
                var submitInterval = setInterval(function () {
                  var sendBtn = document.querySelector('button[data-testid="send-button"]')
                    || document.querySelector('button[aria-label="Send prompt"]')
                    || document.querySelector('button[aria-label="Send"]');
                  if (sendBtn && !sendBtn.disabled) {
                    clearInterval(submitInterval);
                    sendBtn.click();
                    if (typeof window.dreweryTrack === 'function') {
                      window.dreweryTrack('portility_auto_submit', { platform: 'chatgpt', success: true });
                    }
                  } else if (++submitAttempts > 20) {
                    clearInterval(submitInterval);
                    if (typeof window.dreweryTrack === 'function') {
                      window.dreweryTrack('portility_auto_submit', {
                        platform: 'chatgpt',
                        success: false,
                        reason: sendBtn ? 'button_disabled' : 'button_not_found',
                      });
                    }
                  }
                }, 100);
              }, submitDelay);
            });
          }, 800);
        }
        if (++attempts > 40) {
          clearInterval(interval);
          pasting = false;
          if (typeof window.dreweryTrack === 'function') {
            window.dreweryTrack('portility_auto_submit', {
              platform: 'chatgpt',
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
    window.dreweryTrack('drewery_page_load', { platform: 'chatgpt' });
  }
})();
