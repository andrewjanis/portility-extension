/**
 * content-shared.js
 * Portility — shared utilities for content scripts.
 * Loaded before platform-specific scripts (content.js, content-chatgpt.js).
 *
 * Exposes window.PortilityShared with platform-agnostic helpers:
 *   - isElementVisible
 *   - extractElementText
 *   - stripMarkdown
 *   - copyToClipboard
 *   - formatConversation
 */

(function () {
  'use strict';

  /**
   * Return true if an element is visible in the DOM (not hidden/collapsed).
   * @param {Element} el
   * @returns {boolean}
   */
  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  // ─── Markdown stripping ───────────────────────────────────────────────────
  /**
   * Strip common markdown formatting so output pastes as clean plain text.
   * @param {string} text
   * @returns {string}
   */
  function stripMarkdown(text) {
    return text
      // Fenced code blocks — keep content, remove fences
      .replace(/```[\w]*\n?([\s\S]*?)```/g, '$1')
      // Inline code
      .replace(/`([^`]+)`/g, '$1')
      // Headers
      .replace(/^#{1,6}\s+/gm, '')
      // Bold / italic
      .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, '$2')
      // Strikethrough
      .replace(/~~(.*?)~~/g, '$1')
      // Blockquotes
      .replace(/^>\s+/gm, '')
      // Unordered list markers (only if not already prefixed with "- " by walk())
      .replace(/^[\s]*[-*+]\s+/gm, '- ')
      // Ordered list markers
      .replace(/^(\s*)(\d+)\.\s+/gm, '$1$2. ')
      // Horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, '')
      // Links
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Images in markdown (distinct from uploaded images — handled separately)
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      // Collapse excess blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ─── Text extraction ──────────────────────────────────────────────────────
  /**
   * Extract plain text from an element with explicit list item handling.
   * Using innerText alone can silently drop list content in some rendering
   * scenarios; this walks the DOM to guarantee list items are captured.
   * @param {Element} el
   * @returns {string}
   */
  function extractElementText(el) {
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();

      // Skip non-content elements: UI controls, scripts, decorative elements
      if (['button', 'script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return '';

      // Skip aria-hidden elements (decorative / screen-reader duplicates)
      if (node.getAttribute('aria-hidden') === 'true') return '';

      const style = window.getComputedStyle(node);

      // Skip hidden elements
      if (style.display === 'none' || style.visibility === 'hidden') return '';

      // List items: prefix with "- " and add newline
      if (tag === 'li') {
        const children = Array.from(node.childNodes).map(walk).join('').trim();
        return children ? '- ' + children + '\n' : '';
      }

      // Block-level elements: add newline after
      const isBlock = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                       'blockquote', 'pre', 'ul', 'ol', 'br', 'hr',
                       'section', 'article', 'header', 'footer'].includes(tag);

      const inner = Array.from(node.childNodes).map(walk).join('');

      if (tag === 'br') return '\n';
      if (isBlock) return inner.trimEnd() + '\n';
      return inner;
    }

    const raw = walk(el);
    return stripMarkdown(raw);
  }

  // ─── Conversation formatting ──────────────────────────────────────────────
  /**
   * Format extracted messages into the final clipboard string.
   * @param {{ role: string, text: string }[]} messages
   * @returns {string}
   */
  function formatConversation(messages) {
    var HEADER = (typeof PORT_MY_CHAT_PROMPTS !== 'undefined' && PORT_MY_CHAT_PROMPTS.header)
      ? PORT_MY_CHAT_PROMPTS.header
      : 'The following is a previous conversation from another AI assistant. Treat it as shared context. In your first response, briefly confirm what you understand the conversation to be about, then propose the most logical next step and ask the user if they\'d like to proceed with that or go in a different direction.\n\n---\n\n';
    const body = messages
      .map(function(item) { return item.role + ': ' + item.text; })
      .join('\n\n');
    return HEADER + body;
  }

  // ─── Clipboard helpers ────────────────────────────────────────────────────
  async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (e) {
        // Fall through to execCommand fallback
      }
    }
    // execCommand fallback
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!success) throw new Error('execCommand copy failed');
  }

  // ─── Asset extraction ────────────────────────────────────────────────────
  var FILE_EXTENSIONS = /\.(pdf|doc|docx|xls|xlsx|csv|txt|json|zip|tar|gz|py|js|ts|html|css|md)(\?|$)/i;
  var IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|heic|heif)(\?|$)/i;

  function extractFilenameFromUrl(url) {
    try {
      var pathname = new URL(url).pathname;
      var parts = pathname.split('/');
      var last = parts[parts.length - 1];
      return last && last.includes('.') ? decodeURIComponent(last) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Extract asset metadata (images, file links) from a message element.
   * @param {Element} el - The message element to scan
   * @param {string} role - 'Human' or 'Assistant'
   * @param {number} turnIndex - Position in conversation
   * @returns {{ type: string, url: string|null, alt: string, thumbnailUrl: string|null, filename: string|null, turnIndex: number, role: string }[]}
   */
  function extractAssets(el, role, turnIndex) {
    var assets = [];
    var seenSrcs = {};

    function addImg(img, idx) {
      var src = img.src || img.getAttribute('src') || '';
      // Skip tiny UI icons
      if (img.naturalWidth > 0 && img.naturalWidth < 20) return;
      if (src.startsWith('data:') && src.length < 200) return;
      // Skip SVG icons inside buttons
      if (src.includes('.svg') && img.closest('button')) return;
      // Deduplicate
      if (seenSrcs[src]) return;
      seenSrcs[src] = true;

      assets.push({
        type: 'image',
        url: src,
        alt: img.alt || '',
        thumbnailUrl: src,
        filename: extractFilenameFromUrl(src) || ('image_' + turnIndex + '_' + idx + '.png'),
        turnIndex: turnIndex,
        role: role,
      });
    }

    // Images inside the element itself
    var imgs = el.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      addImg(imgs[i], i);
    }

    // For Human turns, also search sibling/parent containers for uploaded images.
    // Platforms (ChatGPT, Claude) often render user-uploaded images in a sibling
    // container adjacent to the text element rather than inside it.
    if (role === 'Human') {
      var node = el;
      for (var level = 0; level < 5; level++) {
        var parent = node.parentElement;
        if (!parent || parent.tagName === 'BODY') break;
        var siblings = parent.children;
        for (var s = 0; s < siblings.length; s++) {
          if (siblings[s] === node || siblings[s] === el) continue;
          // Stop if sibling contains another conversation turn (avoid cross-turn leaking)
          if (siblings[s].querySelector('[data-message-author-role], [data-testid="user-message"], [data-testid="human-turn"], [class*="human-turn"], [class*="font-claude-response"], .model-response-text, [data-turn-role]')) continue;
          var sibImgs = siblings[s].querySelectorAll('img');
          for (var si = 0; si < sibImgs.length; si++) {
            addImg(sibImgs[si], assets.length + si);
          }
        }
        node = parent;
      }
    }

    // File links
    var links = el.querySelectorAll('a[href]');
    for (var j = 0; j < links.length; j++) {
      var link = links[j];
      var href = link.href || '';
      if (FILE_EXTENSIONS.test(href) || IMAGE_EXTENSIONS.test(href)) {
        assets.push({
          type: IMAGE_EXTENSIONS.test(href) ? 'image' : 'file',
          url: href,
          alt: link.textContent.trim() || '',
          thumbnailUrl: IMAGE_EXTENSIONS.test(href) ? href : null,
          filename: extractFilenameFromUrl(href) || ('file_' + turnIndex + '_' + j),
          turnIndex: turnIndex,
          role: role,
        });
      }
    }

    return assets;
  }

  // ─── Image capture ──────────────────────────────────────────────────────

  var MAX_CAPTURE_IMAGES = 10;
  var CAPTURE_TIMEOUT_MS = 8000;
  var CAPTURE_MAX_DIM = 1024;
  var CAPTURE_MAX_KB = 500;

  /**
   * Compress an image via canvas to JPEG within size/dimension budgets.
   * @param {HTMLImageElement} img - Already-loaded Image element
   * @returns {string} Compressed data URL
   */
  function compressViaCanvas(img) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (w > CAPTURE_MAX_DIM || h > CAPTURE_MAX_DIM) {
      if (w > h) { h = Math.round(h * (CAPTURE_MAX_DIM / w)); w = CAPTURE_MAX_DIM; }
      else { w = Math.round(w * (CAPTURE_MAX_DIM / h)); h = CAPTURE_MAX_DIM; }
    }
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);

    var quality = 0.7;
    var result = canvas.toDataURL('image/jpeg', quality);
    function approxKB(url) { return ((url.split(',')[1] || '').length * 0.75) / 1024; }
    while (approxKB(result) > CAPTURE_MAX_KB && quality > 0.1) {
      quality = Math.round((quality - 0.1) * 10) / 10;
      result = canvas.toDataURL('image/jpeg', quality);
    }
    return result;
  }

  /**
   * Fetch an image via the background service worker (bypasses CORS).
   * @param {string} src
   * @returns {Promise<string|null>} base64 data URL or null
   */
  function fetchViaBackground(src) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_DATA', url: src }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.dataUrl) {
            resolve(null);
          } else {
            resolve(resp.dataUrl);
          }
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /**
   * Load a data URL into an Image and compress via canvas.
   * @param {string} dataUrl
   * @returns {Promise<string|null>}
   */
  function compressDataUrl(dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try { resolve(compressViaCanvas(img)); } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = dataUrl;
    });
  }

  /**
   * Capture a single image URL as a compressed base64 data URL.
   * Tries: (1) CORS canvas, (2) plain canvas, (3) background fetch.
   * @param {string} src
   * @returns {Promise<string|null>}
   */
  function captureImageDataUrl(src) {
    if (!src) return Promise.resolve(null);

    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; resolve(null); }
      }, CAPTURE_TIMEOUT_MS);

      function done(val) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      }

      // For data: URLs, compress directly
      if (src.startsWith('data:')) {
        compressDataUrl(src).then(done);
        return;
      }

      // For http(s) URLs: try with CORS first, then without, then via background
      var corsImg = new Image();
      corsImg.crossOrigin = 'anonymous';
      corsImg.onload = function () {
        try { done(compressViaCanvas(corsImg)); } catch (e) { tryWithoutCors(); }
      };
      corsImg.onerror = function () { tryWithoutCors(); };
      corsImg.src = src;

      function tryWithoutCors() {
        var plainImg = new Image();
        plainImg.onload = function () {
          try { done(compressViaCanvas(plainImg)); } catch (e) { tryBackgroundFetch(); }
        };
        plainImg.onerror = function () { tryBackgroundFetch(); };
        plainImg.src = src;
      }

      function tryBackgroundFetch() {
        console.log('[Portility] Canvas tainted for', src.substring(0, 80), '— trying background fetch');
        fetchViaBackground(src).then(function (bgDataUrl) {
          if (!bgDataUrl) { done(null); return; }
          compressDataUrl(bgDataUrl).then(function (compressed) {
            done(compressed);
          });
        });
      }
    });
  }

  /**
   * Capture base64 data for all image assets (in parallel, capped).
   * Mutates each asset by adding a `dataUrl` property.
   * @param {Array} assets
   * @returns {Promise<void>}
   */
  async function captureImageData(assets) {
    var imageAssets = assets.filter(function (a) { return a.type === 'image' && a.url; });
    var toCapture = imageAssets.slice(0, MAX_CAPTURE_IMAGES);

    await Promise.allSettled(
      toCapture.map(function (asset) {
        return captureImageDataUrl(asset.url).then(function (dataUrl) {
          if (dataUrl) asset.dataUrl = dataUrl;
        });
      })
    );

    var capturedAssets = toCapture.filter(function (a) { return !!a.dataUrl; });
    console.log('[Portility] Image capture: ' + capturedAssets.length + '/' + toCapture.length + ' succeeded' +
      (imageAssets.length > MAX_CAPTURE_IMAGES ? ' (' + (imageAssets.length - MAX_CAPTURE_IMAGES) + ' skipped, cap=' + MAX_CAPTURE_IMAGES + ')' : ''));

    // Store captured images directly in chrome.storage.local
    // (avoids sendResponse message size limits)
    if (capturedAssets.length > 0) {
      var imagePayload = capturedAssets.map(function (a) {
        return { dataUrl: a.dataUrl, filename: a.filename || 'image.jpg', url: a.url || null, alt: a.alt || null };
      });
      await new Promise(function (resolve) {
        chrome.storage.local.set({ portility_captured_images: imagePayload }, function () {
          if (chrome.runtime.lastError) {
            console.warn('[Portility] Failed to store captured images:', chrome.runtime.lastError.message);
          }
          resolve();
        });
      });
      console.log('[Portility] Stored', imagePayload.length, 'captured images in chrome.storage.local');
    } else {
      chrome.storage.local.remove('portility_captured_images');
    }
  }

  // ─── Paste images into AI chat input ──────────────────────────────────────

  /**
   * Convert data URL array to File objects.
   */
  function dataUrlsToFiles(images) {
    var files = [];
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      if (!img.dataUrl) continue;
      var parts = img.dataUrl.split(',');
      var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
      var byteStr = atob(parts[1]);
      var bytes = new Uint8Array(byteStr.length);
      for (var k = 0; k < byteStr.length; k++) bytes[k] = byteStr.charCodeAt(k);
      var fname = (img.filename || ('image_' + (i + 1) + '.jpg')).replace(/\.[^.]+$/, '.jpg');
      files.push(new File([bytes], fname, { type: mime }));
    }
    return files;
  }

  /**
   * Find a <input type="file"> in the page DOM (including inside shadow roots).
   */
  function findFileInput() {
    // Search in regular DOM
    var inputs = document.querySelectorAll('input[type="file"]');
    for (var i = 0; i < inputs.length; i++) {
      var accept = inputs[i].getAttribute('accept') || '';
      if (!accept || accept.indexOf('image') !== -1 || accept === '*/*') return inputs[i];
    }
    if (inputs.length > 0) return inputs[0];

    // Search inside shadow DOMs (one level deep)
    var allEls = document.querySelectorAll('*');
    for (var j = 0; j < allEls.length; j++) {
      if (allEls[j].shadowRoot) {
        var shadowInputs = allEls[j].shadowRoot.querySelectorAll('input[type="file"]');
        if (shadowInputs.length > 0) return shadowInputs[0];
      }
    }
    return null;
  }

  /**
   * Strategy 1: Find <input type="file"> and set files via DataTransfer.
   */
  function tryFileInput(files) {
    var fileInput = findFileInput();
    if (!fileInput) {
      console.log('[Portility] tryFileInput: no file input found');
      return false;
    }

    var dt = new DataTransfer();
    for (var j = 0; j < files.length; j++) dt.items.add(files[j]);
    fileInput.files = dt.files;

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    console.log('[Portility] Uploaded ' + files.length + ' image(s) via file input');
    return true;
  }

  /**
   * Strategy 2: Synthetic paste event on editor and document.
   * Most modern AI apps (Gemini, ChatGPT, Claude) listen for paste events
   * with files in clipboardData.
   */
  function trySyntheticPaste(inputEl, files) {
    var dt = new DataTransfer();
    for (var j = 0; j < files.length; j++) dt.items.add(files[j]);

    // Try on the focused input element first
    inputEl.focus();
    var pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    var handled = !inputEl.dispatchEvent(pasteEvent); // returns false if preventDefault called
    console.log('[Portility] Synthetic paste on input:', handled ? 'handled' : 'not handled');
    if (handled) return true;

    // Try on document (some apps listen at document level)
    var dt2 = new DataTransfer();
    for (var k = 0; k < files.length; k++) dt2.items.add(files[k]);
    var docPaste = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt2,
    });
    var docHandled = !document.dispatchEvent(docPaste);
    console.log('[Portility] Synthetic paste on document:', docHandled ? 'handled' : 'not handled');
    return docHandled;
  }

  /**
   * Strategy 3: Drag-and-drop on editor and common drop zones.
   */
  function tryDragDrop(inputEl, files) {
    try {
      var targets = [inputEl, document.body];
      for (var t = 0; t < targets.length; t++) {
        var target = targets[t];
        var dt = new DataTransfer();
        for (var j = 0; j < files.length; j++) dt.items.add(files[j]);

        target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        var dropEvt = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
        var dropHandled = !target.dispatchEvent(dropEvt);
        if (dropHandled) {
          console.log('[Portility] Drop handled on', target === inputEl ? 'input' : 'body');
          return true;
        }
      }
      console.log('[Portility] tryDragDrop: no target handled the drop');
      return false;
    } catch (err) {
      console.warn('[Portility] drag-drop failed:', err.message);
      return false;
    }
  }

  /**
   * Upload images to the destination AI chat using multiple strategies.
   * Tries: file input → synthetic paste → drag-drop.
   * @param {Element} inputEl - The focused contenteditable / textarea
   * @param {Array<{dataUrl:string, filename:string}>} images
   * @param {function(boolean):void} callback
   */
  function pasteImages(inputEl, images, callback) {
    console.log('[Portility] pasteImages called with', images.length, 'images');
    try {
      var files = dataUrlsToFiles(images);
      console.log('[Portility] Converted to', files.length, 'File objects');
      if (files.length === 0) { console.warn('[Portility] No files created from images'); callback(false); return; }

      // Try strategies in order of reliability
      if (tryFileInput(files)) { callback(true); return; }
      if (trySyntheticPaste(inputEl, files)) { callback(true); return; }
      if (tryDragDrop(inputEl, files)) { callback(true); return; }
      console.warn('[Portility] All image upload strategies failed');
      callback(false);
    } catch (err) {
      console.warn('[Portility] pasteImages failed:', err.message || err);
      callback(false);
    }
  }

  // ─── Export ───────────────────────────────────────────────────────────────
  window.PortilityShared = {
    isElementVisible: isElementVisible,
    extractElementText: extractElementText,
    stripMarkdown: stripMarkdown,
    copyToClipboard: copyToClipboard,
    formatConversation: formatConversation,
    extractAssets: extractAssets,
    captureImageData: captureImageData,
    pasteImages: pasteImages,
  };
})();
