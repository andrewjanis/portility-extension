'use strict';

(function () {
  var POSTHOG_API_KEY = 'phc_Am8QxJfBbaSQVfEbANuaPVWWfeEWoKQEqK7QKo38Y9fD';
  var POSTHOG_HOST = 'https://app.posthog.com';

  function fmtText(str) {
    var s = str || '';
    // Escape HTML
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Code blocks
    s = s.replace(/```([\s\S]*?)```/g, function (_, c) { return '<pre>' + c.trim() + '</pre>'; });
    // Inline code
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Headers
    s = s.replace(/^###?\s+(.+)$/gm, '<h3>$1</h3>');
    // Bullet lists
    s = s.replace(/^(\s*)[-*]\s+(.+)$/gm, '<li>$2</li>');
    s = s.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    // Numbered lists
    s = s.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
    // Blockquotes
    s = s.replace(/^>\s?(.+)$/gm, '<blockquote>$1</blockquote>');
    // Paragraphs
    s = s.replace(/\n{2,}/g, '</p><p>');
    s = s.replace(/\n/g, '<br>');
    s = '<p>' + s + '</p>';
    // Clean up empty paragraphs
    s = s.replace(/<p><\/p>/g, '');
    s = s.replace(/<p>(<h3>)/g, '$1');
    s = s.replace(/(<\/h3>)<\/p>/g, '$1');
    s = s.replace(/<p>(<ul>)/g, '$1');
    s = s.replace(/(<\/ul>)<\/p>/g, '$1');
    s = s.replace(/<p>(<pre>)/g, '$1');
    s = s.replace(/(<\/pre>)<\/p>/g, '$1');
    s = s.replace(/<p>(<blockquote>)/g, '$1');
    s = s.replace(/(<\/blockquote>)<\/p>/g, '$1');
    return s;
  }

  chrome.storage.local.get('portility_rating_data', function (result) {
    var d = result.portility_rating_data;
    if (!d) {
      document.getElementById('loadingState').textContent = 'No comparison data found.';
      return;
    }

    // Clean up storage
    chrome.storage.local.remove('portility_rating_data');

    var cmp = d.comparison || {};
    var score = Math.round(cmp.agreement_score || 0);
    var zone = score < 34 ? 'Conflict' : score < 67 ? 'Mixed' : 'Agrees';
    var zoneColor = score < 34 ? '#A93226' : score < 67 ? '#B7950B' : '#1E8449';

    // Score badge styling
    var badge = document.getElementById('scoreBadge');
    badge.textContent = 'AI Score: ' + score + '% \u2014 ' + zone;
    badge.style.background = score < 34 ? '#fef2f2' : score < 67 ? '#fffbeb' : '#f0fdf4';
    badge.style.color = zoneColor;
    badge.style.border = '1px solid ' + (score < 34 ? '#fecaca' : score < 67 ? '#fde68a' : '#bbf7d0');

    // Render content
    document.getElementById('origText').innerHTML = fmtText(d.originalBrief);
    document.getElementById('soText').innerHTML = fmtText(d.secondOpinion);

    document.getElementById('loadingState').style.display = 'none';
    document.getElementById('ratingContent').style.display = 'block';

    // Rating buttons
    var selected = null;
    var colorMap = { high: 'selected-high', medium: 'selected-medium', low: 'selected-low' };
    var btns = document.querySelectorAll('.rating-btn');

    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        btns.forEach(function (b) { b.className = 'rating-btn'; });
        selected = btn.dataset.rating;
        btn.className = 'rating-btn ' + colorMap[selected];
        document.getElementById('submitBtn').disabled = false;
      });
    });

    // Submit
    document.getElementById('submitBtn').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Saving...';

      var reason = document.getElementById('reasonInput').value.trim();
      var proxyBase = d.proxyUrl || '';

      fetch(proxyBase + '/feedback', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + d.idToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          platform: d.platform,
          comparisonModel: d.source,
          aiScore: score,
          humanRating: selected,
          humanReason: reason,
          originalBrief: d.originalBrief,
          secondOpinion: d.secondOpinion,
          questionType: cmp.question_type || 'analytical',
        }),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          document.getElementById('successMsg').style.display = 'block';
          document.getElementById('errorMsg').style.display = 'none';
          btn.textContent = 'Submitted';
          btns.forEach(function (b) { b.style.pointerEvents = 'none'; });

          // PostHog tracking
          fetch(POSTHOG_HOST + '/capture/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: POSTHOG_API_KEY,
              event: 'second_opinion_feedback_submitted',
              distinct_id: d.firebaseUid,
              properties: {
                aiScore: score,
                humanRating: selected,
                hasReason: reason.length > 0,
                platform: d.platform,
                $lib: 'portility-extension',
              },
              timestamp: new Date().toISOString(),
            }),
            keepalive: true,
          }).catch(function () {});
        })
        .catch(function (e) {
          document.getElementById('errorMsg').textContent = 'Failed to save: ' + e.message;
          document.getElementById('errorMsg').style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Submit Feedback';
        });
    });
  });
})();
