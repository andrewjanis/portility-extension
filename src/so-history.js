'use strict';

(function () {
  var platformNames = {
    claude: 'Claude',
    chatgpt: 'ChatGPT',
    gemini: 'Gemini',
  };

  var platformIcons = {
    claude: '<svg class="platform-icon" width="14" height="14" viewBox="0 0 1200 1200" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M233.96 800.21L468.64 668.54l3.95-11.44-3.95-6.36h-11.44l-39.22-2.42-134.09-3.62-116.3-4.83-112.67-6.04L26.58 627.79 0 592.75l2.74-17.48 23.84-16.03 34.15 2.98 75.46 5.15 113.23 7.81 82.15 4.83 121.69 12.65h19.33l2.74-7.81-6.6-4.83-5.16-4.83L346.39 495.79 219.54 411.87l-66.44-48.32-35.92-24.48-18.12-22.95-7.81-50.1 32.62-35.92 43.81 2.98 11.19 2.98 44.38 34.15 94.79 73.37 123.79 91.17 18.12 15.06 7.25-5.15.89-3.63-8.14-13.61-67.33-121.69L320.78 181.93l-31.97-51.3-8.46-30.77c-2.98-12.64-5.15-23.27-5.15-36.24L312.32 13.21l20.54-6.6 49.53 6.6 20.86 18.12 30.77 70.39 49.85 110.82 77.32 150.68 22.63 44.7 12.08 41.4 4.51 12.64h7.81v-7.25l6.36-84.89 11.76-104.21 11.44-134.09 3.95-37.77 18.68-45.26 37.13-24.48 28.83 13.85 23.84 34.15-3.3 22.07-14.17 92.13-27.79 144.32-18.12 96.64 10.55 0 12.08-12.08 48.89-64.91 82.15-102.68 36.24-40.75 42.28-45.02 27.14-21.42 51.3 0 37.77 56.13-16.91 58-52.83 67.01-43.81 56.78-62.82 84.56-39.22 67.65 3.62 5.4 9.34-.89 141.91-30.2 76.67-13.85 91.49-15.7 41.4 19.33 4.51 19.65-16.27 40.19-97.85 24.16-114.77 22.95-170.9 40.43-2.09 1.53 2.42 2.98 76.99 7.25 32.94 1.77 80.62 0 150.12 11.19 39.22 25.93 23.52 31.73-3.95 24.16-60.4 30.77-81.5-19.33-190.23-45.26-65.46-16.27-8.47 0v5.4l54.36 53.15 99.62 89.96 124.75 115.97 6.36 28.67-16.03 22.63-16.91-2.42-109.61-82.47-42.28-37.13-95.76-80.62-6.36 0v8.46l22.07 32.3 116.54 175.17 6.04 53.72-8.46 17.48-30.2 10.55-33.18-6.04-68.21-95.76-70.39-107.84-56.78-96.64-6.93 3.95-33.5 360.89-16.27 18.44-36.24 13.85-30.2-22.95-16.03-37.13 16.03-73.37 19.33-95.76 15.7-76.31 14.17-94.55 8.46-31.41-.56-2.09-6.93.89-71.23 97.85-108.4 146.5-85.77 91.81-20.54 8.14-35.6-18.44 3.3-32.94 19.89-29.35 118.71-150.12 71.6-93.58 46.23-47.74-.32-7.81-2.74 0L205.29 929.4l-56.13 7.25-24.16-22.63 2.98-37.13 11.44-12.08 94.79-65.23-.32.32z" fill="#d97757"/></svg>',
    gemini: '<svg class="platform-icon" width="14" height="14" viewBox="0 0 65 65" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.9 38.9 0 002 5.905c2.15 5 5.1 9.376 8.853 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 2c.66.165 1.124.757 1.124 1.437 0 .68-.464 1.273-1.125 1.44a38.9 38.9 0 00-5.905 1.998c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.97 38.97 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.9 38.9 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.97 38.97 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.9 38.9 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.97 38.97 0 002-5.905A1.485 1.485 0 0132.447 0z" fill="url(#gemiGrad)"/><defs><linearGradient id="gemiGrad" x1="18" y1="43" x2="52" y2="15" gradientUnits="userSpaceOnUse"><stop stop-color="#4285f4"/><stop offset="1" stop-color="#a374db"/></linearGradient></defs></svg>',
    chatgpt: '<svg class="platform-icon" width="14" height="14" viewBox="0 0 2406 2406" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 578.4C1 259.5 259.5 1 578.4 1h1249.1c319 0 577.5 258.5 577.5 577.4V2406H578.4C259.5 2406 1 2147.5 1 1828.6V578.4z" fill="#74aa9c"/><path d="M1107.3 299.1c-198 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.5V833.3h.1v-27.9L1372.7 604c33.7-19.5 70.4-32.9 108.5-39.8L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.7 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.1 151.6-338.9 339-339.2z" fill="#fff"/></svg>',
  };

  function escHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  /**
   * Generate a 2-4 word topic title from the original conversation brief.
   */
  function deriveTitle(originalBrief) {
    if (!originalBrief) return 'Comparison';
    // Get first meaningful line (skip empty lines and role labels like "User:" / "Assistant:")
    var lines = originalBrief.split(/\n/).filter(function (l) { return l.trim().length > 0; });
    var line = (lines[0] || '').trim();
    // Strip role prefixes
    line = line.replace(/^(user|assistant|human|ai|you|me)\s*:\s*/i, '');
    // Strip common question starters to get to the topic
    line = line.replace(/^(can you |could you |what is |what are |what's |how much |how many |how do |how does |how to |tell me about |explain |is there |are there |do you know |i need |i want |please )/i, '');
    // Take first 2-4 words as the topic
    var words = line.split(/\s+/).slice(0, 4);
    var title = words.join(' ').replace(/[.,;:!?"'?]+$/, '');
    if (title.length > 30) title = title.substring(0, 27) + '...';
    if (!title) return 'Comparison';
    return title.charAt(0).toUpperCase() + title.slice(1);
  }

  function formatDate(isoString) {
    if (!isoString) return '\u2014';
    var d = new Date(isoString);
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  function getPlatformLabel(key) {
    return platformNames[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Unknown');
  }

  function getPlatformIcon(key) {
    return platformIcons[key] || '';
  }

  var content = document.getElementById('historyContent');

  listSOComparisons().then(function (comparisons) {
    if (!comparisons || comparisons.length === 0) {
      content.innerHTML = '<div class="empty">No comparisons yet.</div>';
      return;
    }

    content.innerHTML = comparisons.map(function (item) {
      var cmp = item.comparison || {};
      var score = Math.round(cmp.agreement_score || 0);
      var questionType = cmp.question_type || 'analytical';
      var interpretation = cmp.interpretation || '';
      var platform = item.platform || 'claude';
      var source = item.source || 'chatgpt';

      var scoreClass = score < 34 ? 'score-conflict' : score < 67 ? 'score-mixed' : 'score-agrees';
      var scoreLabel = score < 34 ? 'Conflict' : score < 67 ? 'Mixed' : 'Agrees';

      // "Claude evaluated by ChatGPT"
      var aiLabel = getPlatformIcon(platform) + ' ' + escHtml(getPlatformLabel(platform)) +
        ' evaluated by ' +
        getPlatformIcon(source) + ' ' + escHtml(getPlatformLabel(source));

      // One-sentence summary from interpretation, or fallback
      var summary = interpretation || 'No summary available.';
      // Truncate if too long
      if (summary.length > 200) {
        summary = summary.substring(0, 197) + '...';
      }

      var title = deriveTitle(item.originalBrief);

      return '<div class="history-item">' +
        '<div class="history-top">' +
          '<span class="history-title">' + escHtml(title) + '</span>' +
          '<span class="history-date">' + escHtml(formatDate(item.createdAt)) + '</span>' +
        '</div>' +
        '<div class="history-ais">' + aiLabel + '</div>' +
        '<div class="history-summary">' + escHtml(summary) + '</div>' +
        '<div class="history-meta">' +
          '<span class="score-pill ' + scoreClass + '">' + score + '% ' + scoreLabel + '</span>' +
          '<span class="type-pill">' + escHtml(questionType) + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }).catch(function (err) {
    console.error('[SOHistory] Failed to load:', err);
    content.innerHTML = '<div class="empty">Could not load history.</div>';
  });
})();
