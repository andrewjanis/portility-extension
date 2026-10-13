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

      // Skip elements the platform itself marks as not real content — e.g.
      // Claude's hidden "Claude responded: ..." sr-only accessibility summary
      // and its collapsible "thinking" status labels both carry
      // data-find-omitted, which is the platform's own semantic signal that
      // these are UI chrome, not conversation content.
      if (node.hasAttribute('data-find-omitted')) return '';

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
  function formatConversation(messages, includeHeader) {
    const body = messages
      .map(function(item) { return item.role + ': ' + item.text; })
      .join('\n\n');
    if (includeHeader === false) return body;
    var HEADER = (typeof PORT_MY_CHAT_PROMPTS !== 'undefined' && PORT_MY_CHAT_PROMPTS.header)
      ? PORT_MY_CHAT_PROMPTS.header
      : 'The following is a previous conversation from another AI assistant. Treat it as shared context. In your first response, briefly confirm what you understand the conversation to be about, then propose the most logical next step and ask the user if they\'d like to proceed with that or go in a different direction.\n\n---\n\n';
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

  // ─── Descriptive image filenames ──────────────────────────────────────────
  // Platform image URLs/alt text are rarely useful filenames (e.g. Gemini's
  // own "Gemini_Generated_Image_<random-hash>.jpg"). When the nearby prompt
  // text is available, build something readable instead, e.g.
  // "Gemini_generated_10_11_26_chicken_beer.jpg".
  var FILENAME_STOPWORDS = {
    a: 1, an: 1, the: 1, of: 1, in: 1, on: 1, to: 1, for: 1, with: 1, and: 1,
    or: 1, my: 1, me: 1, i: 1, you: 1, your: 1, please: 1, can: 1, could: 1,
    would: 1, will: 1, make: 1, made: 1, create: 1, draw: 1, drawing: 1,
    generate: 1, generated: 1, generating: 1, image: 1, images: 1, picture: 1,
    photo: 1, show: 1, give: 1, want: 1, like: 1, this: 1, that: 1, these: 1,
    those: 1, is: 1, are: 1, was: 1, were: 1, be: 1, it: 1, its: 1, as: 1,
    at: 1, by: 1, from: 1, into: 1, onto: 1, up: 1, down: 1, out: 1,
    about: 1, if: 1, then: 1, so: 1, just: 1, some: 1, any: 1, using: 1,
    use: 1, new: 1, here: 1, there: 1, now: 1, also: 1, really: 1, very: 1,
    // Platform accessibility-echo prefixes (e.g. Gemini's hidden "You said ..."
    // / "Gemini said ..." label ahead of the real prompt text) — not stripped
    // by extractElementText today, so filtered here to keep them out of slugs.
    said: 1, asked: 1, wrote: 1, typed: 1, gemini: 1, chatgpt: 1, claude: 1,
  };

  /**
   * Pull a handful of significant words out of prompt/caption text, for use
   * as a filename slug. Returns '' if nothing usable is found.
   * @param {string} text
   * @param {number} maxWords
   * @returns {string}
   */
  function slugFromPrompt(text, maxWords) {
    if (!text) return '';
    var words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(function (w) { return w.length >= 3 && !FILENAME_STOPWORDS[w]; });
    var slug = words.slice(0, maxWords || 4).join('_');
    return slug.substring(0, 40);
  }

  /** @returns {string} today's date as MM_DD_YY, matching the user-facing filename style. */
  function dateSlug() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getMonth() + 1) + '_' + pad(d.getDate()) + '_' + String(d.getFullYear()).slice(-2);
  }

  /** @returns {string} 'Claude' | 'ChatGPT' | 'Gemini' | 'Portility', based on the current page. */
  function detectPlatformLabel() {
    if (/claude\.ai/i.test(location.hostname)) return 'Claude';
    if (/chatgpt\.com|chat\.openai\.com/i.test(location.hostname)) return 'ChatGPT';
    if (/gemini\.google\.com/i.test(location.hostname)) return 'Gemini';
    return 'Portility';
  }

  /**
   * Build a descriptive filename like "Gemini_generated_10_11_26_chicken_beer.jpg"
   * from nearby prompt text, or return null if there's no usable text (caller
   * should fall back to the platform's own filename/URL in that case).
   * @param {string} promptText - text of the turn that prompted this image
   * @param {string} role - 'Human' or 'Assistant' (Assistant = AI-generated)
   * @param {string} ext - file extension including the dot, e.g. '.jpg'
   * @returns {string|null}
   */
  function buildDescriptiveFilename(promptText, role, ext) {
    var slug = slugFromPrompt(promptText, 4);
    if (!slug) return null;
    var origin = role === 'Assistant' ? 'generated' : 'image';
    return detectPlatformLabel() + '_' + origin + '_' + dateSlug() + '_' + slug + (ext || '.png');
  }

  /**
   * Find the text of the nearest preceding Human turn in a sorted, tagged
   * turn list — used as the "prompt" for an image that appears later in the
   * same list (e.g. an AI-generated image in the following Assistant turn).
   * @param {{el: Element, role: string}[]} tagged - turns sorted in DOM order
   * @param {number} index - index of the turn whose preceding prompt we want
   * @returns {string}
   */
  function getPrecedingHumanText(tagged, index) {
    if (tagged[index] && tagged[index].role === 'Human') {
      return extractElementText(tagged[index].el);
    }
    for (var j = index - 1; j >= 0; j--) {
      if (tagged[j].role === 'Human') return extractElementText(tagged[j].el);
    }
    return '';
  }

  /**
   * Extract asset metadata (images, file links) from a message element.
   * @param {Element} el - The message element to scan
   * @param {string} role - 'Human' or 'Assistant'
   * @param {number} turnIndex - Position in conversation
   * @param {string} [promptText] - nearby prompt text, for descriptive filenames
   * @returns {{ type: string, url: string|null, alt: string, thumbnailUrl: string|null, filename: string|null, turnIndex: number, role: string }[]}
   */
  function extractAssets(el, role, turnIndex, promptText) {
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

      var fallbackName = extractFilenameFromUrl(src) || ('image_' + turnIndex + '_' + idx + '.png');
      var ext = (fallbackName.match(/\.[a-z0-9]+$/i) || ['.png'])[0];
      var descriptiveBase = null;
      var filename = fallbackName;
      var descriptive = buildDescriptiveFilename(promptText, role, ext);
      if (descriptive) {
        filename = descriptive;
        // Base (sans extension) used later to version R1/R2/... if the same
        // prompt produces more than one image (user regenerates/iterates).
        descriptiveBase = descriptive.slice(0, -ext.length);
      }

      assets.push({
        type: 'image',
        url: src,
        alt: img.alt || '',
        thumbnailUrl: src,
        filename: filename,
        _descriptiveBase: descriptiveBase,
        turnIndex: turnIndex,
        role: role,
      });
    }

    // Images inside the element itself
    var imgs = el.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      addImg(imgs[i], i);
    }

    // File links inside the element itself
    var seenHrefs = {};
    function addFileLink(link) {
      var href = link.href || '';
      if (!href || seenHrefs[href]) return;
      var linkText = (link.textContent || '').trim();
      var hasDownloadAttr = link.hasAttribute('download');
      var textMatchesFile = FILE_EXTENSIONS.test(linkText) || IMAGE_EXTENSIONS.test(linkText);
      var urlMatchesFile = FILE_EXTENSIONS.test(href) || IMAGE_EXTENSIONS.test(href);

      // Skip links to third-party domains that only matched on link text — these are
      // regular web links (e.g. "samsung.com/.../me16a4.html") not file attachments.
      // Real file attachments are served from the platform's domain or have download attr.
      if (textMatchesFile && !urlMatchesFile && !hasDownloadAttr) {
        try {
          if (new URL(href).hostname !== location.hostname) return;
        } catch (e) { /* invalid URL, skip safely */ return; }
      }

      if (urlMatchesFile || hasDownloadAttr || textMatchesFile) {
        seenHrefs[href] = true;
        var isImage = IMAGE_EXTENSIONS.test(href) || IMAGE_EXTENSIONS.test(linkText);
        var fname = extractFilenameFromUrl(href)
          || (textMatchesFile ? linkText : null)
          || (hasDownloadAttr ? (link.getAttribute('download') || null) : null)
          || ('file_' + turnIndex + '_' + assets.length);
        assets.push({
          type: isImage ? 'image' : 'file',
          url: href,
          alt: linkText || '',
          thumbnailUrl: isImage ? href : null,
          filename: fname,
          turnIndex: turnIndex,
          role: role,
        });
      }
    }

    var links = el.querySelectorAll('a[href]');
    for (var j = 0; j < links.length; j++) {
      addFileLink(links[j]);
    }

    // For Human turns, also search sibling/parent containers for uploaded files
    // and images. Platforms (ChatGPT, Claude, Gemini) often render user-uploaded
    // attachments in a sibling container adjacent to the text element.
    if (role === 'Human') {
      var node = el;
      for (var level = 0; level < 5; level++) {
        var parent = node.parentElement;
        if (!parent || parent.tagName === 'BODY') break;
        var siblings = parent.children;
        for (var s = 0; s < siblings.length; s++) {
          if (siblings[s] === node || siblings[s] === el) continue;
          // Skip if sibling contains another conversation turn (avoid cross-turn leaking)
          if (siblings[s].querySelector('[data-message-author-role], [data-testid="user-message"], [data-testid="human-turn"], [class*="human-turn"], [data-testid="assistant-message"], [class*="font-claude-response"], .model-response-text, [data-turn-role]')) continue;
          var sibImgs = siblings[s].querySelectorAll('img');
          for (var si = 0; si < sibImgs.length; si++) {
            addImg(sibImgs[si], assets.length + si);
          }
          var sibLinks = siblings[s].querySelectorAll('a[href]');
          for (var sl = 0; sl < sibLinks.length; sl++) {
            addFileLink(sibLinks[sl]);
          }
        }
        node = parent;
      }
    }

    return assets;
  }

  /**
   * Version descriptively-named images that share the same prompt-derived
   * base filename — e.g. the user regenerates/iterates on the same prompt
   * and ends up with multiple images that would otherwise collide as
   * "Gemini_generated_10_11_26_chicken_beer.jpg". Call once on the full,
   * ordered asset list for a conversation (after collecting every turn's
   * assets), not per-turn, since regenerated images can land in different
   * turns. Mutates and returns the given array.
   * @param {Array<Object>} assets
   * @returns {Array<Object>}
   */
  function applyFilenameVersioning(assets) {
    var groups = {};
    var order = [];
    for (var i = 0; i < assets.length; i++) {
      var base = assets[i]._descriptiveBase;
      if (!base) continue;
      if (!groups[base]) { groups[base] = []; order.push(base); }
      groups[base].push(assets[i]);
    }
    for (var o = 0; o < order.length; o++) {
      var group = groups[order[o]];
      if (group.length < 2) continue;
      for (var g = 0; g < group.length; g++) {
        var asset = group[g];
        var ext = (asset.filename.match(/\.[a-z0-9]+$/i) || [''])[0];
        asset.filename = order[o] + '_R' + (g + 1) + ext;
      }
    }
    for (var j = 0; j < assets.length; j++) delete assets[j]._descriptiveBase;
    return assets;
  }

  // ─── Image capture ──────────────────────────────────────────────────────

  var MAX_CAPTURE_ASSETS = 10;
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
   * Fetch a file as data URL from the content script (has same-origin cookies).
   * Falls back to fetchViaBackground if same-origin fetch fails.
   */
  function fetchWithCookies(src) {
    var isHtmlUrl = /\.html?(\?|#|$)/i.test(src);
    return fetch(src, { credentials: 'include' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        // Reject HTML responses for non-.html URLs (web pages misdetected as files)
        var ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (!isHtmlUrl && ct.indexOf('text/html') >= 0) {
          console.log('[Portility] Skipping HTML page response for:', src.substring(0, 80));
          return null;
        }
        return resp.blob();
      })
      .then(function (blob) {
        if (!blob) return null;
        return new Promise(function (resolve) {
          var reader = new FileReader();
          reader.onload = function () { resolve(reader.result); };
          reader.onerror = function () { resolve(null); };
          reader.readAsDataURL(blob);
        });
      })
      .catch(function () {
        console.log('[Portility] Same-origin fetch failed for', src.substring(0, 80), '— trying background');
        return fetchViaBackground(src).then(function (bgDataUrl) {
          // Always reject HTML from background fetch — if same-origin fetch failed,
          // the URL is cross-origin, so any HTML response is a web page, not a
          // legitimate file attachment (those are served from the platform's domain).
          if (bgDataUrl && /^data:text\/html/i.test(bgDataUrl)) {
            console.log('[Portility] Skipping HTML from cross-origin background fetch:', src.substring(0, 80));
            return null;
          }
          return bgDataUrl;
        });
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
   * Capture base64 data for all image and file assets (in parallel, capped).
   * Mutates each asset by adding a `dataUrl` property.
   * @param {Array} assets
   * @returns {Promise<void>}
   */
  async function captureImageData(assets) {
    // Assets that already have dataUrl (e.g. from platform-specific detection) don't need fetching.
    // Artifacts (Claude documents extracted from the artifact panel) always arrive this way —
    // they have no URL to fetch, just pre-extracted dataUrl content.
    var alreadyCaptured = assets.filter(function (a) { return (a.type === 'image' || a.type === 'file' || a.type === 'artifact') && a.dataUrl; });
    var needsCapture = assets.filter(function (a) { return (a.type === 'image' || a.type === 'file') && a.url && !a.dataUrl; });
    var toCapture = needsCapture.slice(0, MAX_CAPTURE_ASSETS);
    // File/artifact assets with neither a URL nor extracted content: we can't fetch these,
    // but still surface them (dataUrl: null) so they're visible in the picker
    // instead of silently vanishing.
    var unresolvedFiles = assets.filter(function (a) { return (a.type === 'file' || a.type === 'artifact') && !a.url && !a.dataUrl; });

    await Promise.allSettled(
      toCapture.map(function (asset) {
        if (asset.type === 'file') {
          // Files: fetch with cookies first (authenticated URLs), fallback to background
          return fetchWithCookies(asset.url).then(function (dataUrl) {
            if (dataUrl) asset.dataUrl = dataUrl;
          });
        }
        // Images: use canvas-based capture with compression
        return captureImageDataUrl(asset.url).then(function (dataUrl) {
          if (dataUrl) asset.dataUrl = dataUrl;
        });
      })
    );

    var newlyCaptured = toCapture.filter(function (a) { return !!a.dataUrl; });

    // Compress pre-captured images that are too large (e.g. from API downloads)
    var maxDataUrlLen = CAPTURE_MAX_KB * 1024 * 1.37; // base64 overhead
    var largeImages = alreadyCaptured.filter(function (a) {
      return a.type === 'image' && a.dataUrl && a.dataUrl.length > maxDataUrlLen;
    });
    if (largeImages.length > 0) {
      console.log('[Portility] Compressing', largeImages.length, 'oversized pre-captured image(s)');
      await Promise.allSettled(largeImages.map(function (asset) {
        return compressDataUrl(asset.dataUrl).then(function (compressed) {
          if (compressed) {
            console.log('[Portility] Compressed image from', Math.round(asset.dataUrl.length / 1024), 'KB to', Math.round(compressed.length / 1024), 'KB');
            asset.dataUrl = compressed;
          }
        });
      }));
    }

    var totalCaptured = alreadyCaptured.length + newlyCaptured.length;
    console.log('[Portility] Asset capture: ' + newlyCaptured.length + '/' + toCapture.length + ' fetched' +
      (alreadyCaptured.length > 0 ? ', ' + alreadyCaptured.length + ' pre-captured' : '') +
      (unresolvedFiles.length > 0 ? ', ' + unresolvedFiles.length + ' unresolved (no URL/content)' : '') +
      (needsCapture.length > MAX_CAPTURE_ASSETS ? ' (' + (needsCapture.length - MAX_CAPTURE_ASSETS) + ' skipped, cap=' + MAX_CAPTURE_ASSETS + ')' : ''));

    // Store captured assets directly in chrome.storage.local
    // (avoids sendResponse message size limits)
    var allCapturedAssets = alreadyCaptured.concat(newlyCaptured, unresolvedFiles);
    if (allCapturedAssets.length > 0) {
      var assetPayload = allCapturedAssets.map(function (a) {
        return { dataUrl: a.dataUrl, filename: a.filename || 'image.jpg', url: a.url || null, alt: a.alt || null, type: a.type || 'image' };
      });
      await new Promise(function (resolve) {
        chrome.storage.local.set({ portility_captured_images: assetPayload }, function () {
          if (chrome.runtime.lastError) {
            console.warn('[Portility] Failed to store captured assets:', chrome.runtime.lastError.message);
          }
          resolve();
        });
      });
      console.log('[Portility] Stored', assetPayload.length, 'captured assets in chrome.storage.local');
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
      var fname;
      if (mime.startsWith('image/')) {
        // Images: force .jpg extension (canvas compression outputs JPEG)
        fname = (img.filename || ('image_' + (i + 1) + '.jpg')).replace(/\.[^.]+$/, '.jpg');
      } else {
        // Non-image files: preserve original filename and extension
        fname = img.filename || ('file_' + (i + 1) + '.bin');
      }
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
    if (inputs.length > 1) {
      // Multiple file inputs on the page (e.g. Gemini mounts one per
      // "Upload & tools" menu item — Upload files, Add from Drive, etc.)
      // Log their attributes so we can tell which one actually belongs to
      // the conversation composer if the wrong one ever gets picked.
      console.log('[Portility] findFileInput: ' + inputs.length + ' file input(s) found:',
        Array.prototype.map.call(inputs, function (el, idx) {
          return {
            idx: idx,
            id: el.id,
            name: el.name,
            accept: el.getAttribute('accept'),
            multiple: el.hasAttribute('multiple'),
            className: el.className,
            parentClassName: el.parentElement ? el.parentElement.className : null,
          };
        }));
    }
    // Any file input works — prefer unrestricted or broad-accept inputs first
    for (var i = 0; i < inputs.length; i++) {
      var accept = inputs[i].getAttribute('accept') || '';
      if (!accept || accept === '*/*') return inputs[i];
    }
    // Fallback: use the first file input regardless of accept restriction
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
   *
   * If the input doesn't advertise multi-file support (no `multiple` attribute),
   * many sites' change handlers only ever read files[0] — even though we can
   * still programmatically assign a multi-file FileList to it, the rest get
   * silently dropped by the site's own code. In that case, upload one file at
   * a time so each gets its own change event and a chance to attach before
   * the next is set.
   * @param {File[]} files
   * @param {function(boolean):void} callback
   */
  function tryFileInput(files, callback) {
    var fileInput = findFileInput();
    if (!fileInput) {
      console.log('[Portility] tryFileInput: no file input found');
      callback(false);
      return;
    }

    if (files.length <= 1 || fileInput.hasAttribute('multiple')) {
      var dt = new DataTransfer();
      for (var j = 0; j < files.length; j++) dt.items.add(files[j]);
      fileInput.files = dt.files;

      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      console.log('[Portility] Uploaded ' + files.length + ' file(s) via file input (single batch)');
      callback(true);
      return;
    }

    console.log('[Portility] File input lacks "multiple" attribute — uploading', files.length, 'file(s) sequentially');
    var idx = 0;
    function uploadNext() {
      if (idx >= files.length) { callback(true); return; }
      // Re-query in case the site swaps in a fresh input after each attachment
      var input = findFileInput() || fileInput;
      var dtOne = new DataTransfer();
      dtOne.items.add(files[idx]);
      input.files = dtOne.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      idx++;
      setTimeout(uploadNext, 700);
    }
    uploadNext();
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
      // Build list of potential drop targets (editor, form, main area, body)
      var targets = [inputEl];
      var form = inputEl.closest ? inputEl.closest('form') : null;
      if (form) targets.push(form);
      var main = document.querySelector('main');
      if (main) targets.push(main);
      targets.push(document.body);

      for (var t = 0; t < targets.length; t++) {
        var target = targets[t];
        var dt = new DataTransfer();
        for (var j = 0; j < files.length; j++) dt.items.add(files[j]);

        target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        var dropEvt = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
        var dropHandled = !target.dispatchEvent(dropEvt);
        if (dropHandled) {
          console.log('[Portility] Drop handled on', target.tagName || 'unknown');
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
    console.log('[Portility] pasteImages called with', images.length, 'file(s)');
    try {
      var files = dataUrlsToFiles(images);
      console.log('[Portility] Converted to', files.length, 'File objects');
      if (files.length === 0) { console.warn('[Portility] No files created from data'); callback(false); return; }

      // Check if any files are non-image (paste events falsely report success for non-images on some platforms)
      var hasNonImage = false;
      for (var i = 0; i < files.length; i++) {
        if (!files[i].type.startsWith('image/')) { hasNonImage = true; break; }
      }

      // Try file input first (most reliable for all file types)
      tryFileInput(files, function (ok) {
        if (ok) { callback(true); return; }

        // trySyntheticPaste()'s "handled" signal just means the site didn't call
        // preventDefault — it doesn't confirm the file was actually attached.
        // ChatGPT calls preventDefault on paste for ALL file types but only
        // processes images, and Gemini has been observed reporting "handled"
        // for a non-image paste that didn't actually attach (dropped instead
        // into an unrelated composer). Prefer the more verifiable drag-drop
        // signal first for non-image files on every platform; paste remains
        // first for images, which has been reliable.
        if (hasNonImage) {
          console.log('[Portility] Non-image file, trying drag-drop before paste');
          if (tryDragDrop(inputEl, files)) { callback(true); return; }
          if (trySyntheticPaste(inputEl, files)) { callback(true); return; }
        } else {
          if (trySyntheticPaste(inputEl, files)) { callback(true); return; }
          if (tryDragDrop(inputEl, files)) { callback(true); return; }
        }

        console.warn('[Portility] All file upload strategies failed');
        callback(false);
      });
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
    applyFilenameVersioning: applyFilenameVersioning,
    getPrecedingHumanText: getPrecedingHumanText,
    captureImageData: captureImageData,
    pasteImages: pasteImages,
    fetchWithCookies: fetchWithCookies,
  };
})();
