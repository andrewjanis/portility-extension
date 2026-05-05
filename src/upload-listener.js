// upload-listener.js
// Real-time file upload detection via MutationObserver.
// Content script — runs on Claude (expandable to other platforms).
// Self-contained IIFE, no dependencies on platform-specific scripts.

(function () {
  'use strict';

  var detectedUploads = {};
  var fileCache = {}; // filename -> File object (stored at upload time)
  var uploadObserver = null;
  var debounceTimer = null;

  function getPlatform() {
    var host = window.location.hostname;
    if (host.includes('claude.ai')) return 'claude';
    if (host.includes('chatgpt.com')) return 'chatgpt';
    if (host.includes('gemini.google.com')) return 'gemini';
    return null;
  }

  /**
   * Register a detected upload — send metadata to background.js
   */
  function registerUpload(metadata) {
    if (detectedUploads[metadata.name]) return;
    detectedUploads[metadata.name] = metadata;

    console.log('[Portility] Upload detected: ' + metadata.name);

    chrome.runtime.sendMessage({
      type: 'ARTIFACT_DETECTED',
      payload: {
        name: metadata.name,
        fileType: metadata.type || 'unknown',
        size: metadata.size || null,
        platform: metadata.platform,
        timestamp: Date.now(),
        conversationUrl: window.location.href
      }
    });
  }

  /**
   * Handle DOM mutations — look for upload indicators
   */
  function handleMutations(mutations) {
    var platform = getPlatform();
    if (!platform) return;

    for (var m = 0; m < mutations.length; m++) {
      var mutation = mutations[m];
      for (var n = 0; n < mutation.addedNodes.length; n++) {
        var node = mutation.addedNodes[n];
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // Check for image thumbnails (user uploaded an image)
        var imgs = node.querySelectorAll
          ? node.querySelectorAll("img[src*='blob:'], img[src*='data:']")
          : [];
        for (var i = 0; i < imgs.length; i++) {
          var img = imgs[i];
          // Skip tiny UI icons
          if (img.naturalWidth > 0 && img.naturalWidth < 20) continue;
          var filename = img.alt || img.title || ('upload-' + Date.now() + '.png');
          registerUpload({ name: filename, type: 'image', platform: platform });
        }

        // Check for file attachment chips
        var fileChips = node.querySelectorAll
          ? node.querySelectorAll("[data-testid*='file'], [class*='attachment'], [class*='file-chip']")
          : [];
        for (var j = 0; j < fileChips.length; j++) {
          var chip = fileChips[j];
          var chipName = (chip.textContent || '').trim();
          if (chipName && chipName.length < 200) {
            registerUpload({ name: chipName, type: 'file', platform: platform });
          }
        }
      }
    }
  }

  /**
   * Debounced mutation handler
   */
  function debouncedHandler(mutations) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      handleMutations(mutations);
    }, 300);
  }

  /**
   * Initialize upload listener
   */
  function init() {
    var platform = getPlatform();
    if (!platform) return;

    // MutationObserver for DOM changes (file chips, image thumbnails)
    uploadObserver = new MutationObserver(debouncedHandler);
    uploadObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Direct file input change handler — captures File objects
    document.addEventListener('change', function (e) {
      if (e.target && e.target.type === 'file' && e.target.files) {
        for (var i = 0; i < e.target.files.length; i++) {
          var file = e.target.files[i];
          fileCache[file.name] = file;
          registerUpload({
            name: file.name,
            type: file.type || 'unknown',
            size: file.size,
            platform: platform
          });
        }
      }
    }, true);

    console.log('[Portility] Upload listener active on ' + platform);
  }

  // Respond to GET_FILE_BLOB requests from background.js
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === 'GET_FILE_BLOB') {
      var file = fileCache[message.filename];
      if (file) {
        var reader = new FileReader();
        reader.onload = function () {
          sendResponse({ blob: reader.result, type: file.type });
        };
        reader.readAsDataURL(file);
        return true; // Keep channel open for async response
      } else {
        sendResponse({ blob: null });
      }
    }
  });

  init();
})();
