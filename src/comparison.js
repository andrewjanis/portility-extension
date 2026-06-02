'use strict';

(function () {
  function escHtml(str) {
    var d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function soSplitTitleBody(text) {
    if (!text) return { title: 'Point', summary: '' };
    // Handle object format {title, text} passed directly
    if (typeof text === 'object' && text.title) {
      return { title: text.title, summary: text.text || '' };
    }
    if (typeof text !== 'string') return { title: 'Point', summary: String(text) };
    var body = text;
    var preambles = [
      /^both\s+(recognize|acknowledge|note|agree|identify|highlight|mention|discuss|address|cover|provide|include|present|focus|emphasize)\s+(that|the|on|how|a)?\s*:?\s*/i,
      /^(response [AB]|they both|each response|the responses?|both AIs?|both models?)\s+(recognize|acknowledge|note|agree|identify|highlight|mention|discuss|address|present|focus|emphasize)s?\s+(that|the|on|how|a)?\s*:?\s*/i,
      /^(response [AB])\s+(presents?|focuses?|covers?|provides?|includes?|discusses?|emphasizes?)\s*:?\s*/i,
    ];
    for (var i = 0; i < preambles.length; i++) {
      body = body.replace(preambles[i], '');
    }
    var breakMatch = body.match(/^(.{8,35?}?)(?:\s*[,\-\u2014]\s|\s+(?:while|and then|but|with|including|between|from|versus|vs)\s)/i);
    var titleText;
    if (breakMatch) {
      titleText = breakMatch[1].trim();
    } else {
      var words = body.split(/\s+/).slice(0, 3);
      titleText = words.join(' ');
    }
    titleText = titleText.replace(/[.,;:!?]+$/, '');
    titleText = titleText.charAt(0).toUpperCase() + titleText.slice(1);
    return { title: titleText, summary: text };
  }

  function soFindRelevantQuote(text, topic) {
    if (!text || !topic) return '';
    var keywords = topic.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 3; });
    if (keywords.length === 0) return '';
    var sentences = text.split(/[.!?\n]+/).filter(function (s) { return s.trim().length > 15; });
    var best = '';
    var bestScore = 0;
    for (var i = 0; i < sentences.length; i++) {
      var lower = sentences[i].toLowerCase();
      var score = 0;
      for (var k = 0; k < keywords.length; k++) {
        if (lower.indexOf(keywords[k]) !== -1) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = sentences[i].trim();
      }
    }
    if (!best) return '';
    best = best.replace(/\*\*/g, '').replace(/^#+\s*/, '').replace(/^[-*]\s+/, '');
    if (best.length > 180) best = best.substring(0, 177) + '...';
    return best;
  }

  chrome.storage.local.get('portility_comparison_data', function (result) {
    var d = result.portility_comparison_data;
    if (!d) {
      document.getElementById('loadingState').textContent = 'No comparison data found.';
      return;
    }

    chrome.storage.local.remove('portility_comparison_data');

    var cmp = d.comparison || {};
    var score = Math.round(cmp.agreement_score || 0);
    var scoreColor = score < 34 ? '#fa000c' : score < 67 ? '#FFD348' : '#41f531';
    var platformNames = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
    var ai1Name = platformNames[d.platform] || d.platform || 'AI 1';
    var ai2Name = platformNames[d.source] || d.source || 'AI 2';

    // Score
    var scoreEl = document.getElementById('scoreNumber');
    var pctEl = document.getElementById('scorePct');
    scoreEl.textContent = score;
    scoreEl.style.color = scoreColor;
    pctEl.style.color = scoreColor;

    // Interpretation
    document.getElementById('interpretation').textContent = cmp.interpretation || '';

    // Table headers
    document.getElementById('ai1Header').textContent = ai1Name;
    document.getElementById('ai2Header').textContent = ai2Name;

    // Build theme rows
    var allPoints = [];
    (cmp.agreements || []).forEach(function (a) {
      // Support both object {title, text} and legacy string format
      if (typeof a === 'object' && a.title) {
        allPoints.push({ text: a.text || '', title: a.title, type: 'agree' });
      } else {
        allPoints.push({ text: a, title: null, type: 'agree' });
      }
    });
    (cmp.divergences || []).forEach(function (dv) {
      if (typeof dv === 'object' && dv.title) {
        allPoints.push({ text: dv.text || '', title: dv.title, type: 'differ' });
      } else {
        allPoints.push({ text: dv, title: null, type: 'differ' });
      }
    });
    var themes = allPoints.slice(0, 5);

    var rowsHtml = themes.map(function (item) {
      var parts = item.title
        ? { title: item.title, summary: item.text }
        : soSplitTitleBody(item.text);
      var q1 = soFindRelevantQuote(d.originalBrief, parts.title);
      var q2 = soFindRelevantQuote(d.secondOpinion, parts.title);
      var tagColor = item.type === 'agree' ? '#16a34a' : '#dc2626';
      var tagBg = item.type === 'agree' ? '#f0fdf4' : '#fef2f2';
      var tagLabel = item.type === 'agree' ? 'Agree' : 'Differ';
      return '<tr>' +
        '<td class="theme-cell"><strong>' + escHtml(parts.title) + '</strong>' +
          '<span class="theme-tag" style="color:' + tagColor + ';background:' + tagBg + '">' + tagLabel + '</span>' +
          '<div class="theme-desc">' + escHtml(parts.summary) + '</div></td>' +
        '<td class="quote-cell"><div class="quote-text">' + escHtml(q1 || 'No specific mention found.') + '</div></td>' +
        '<td class="quote-cell"><div class="quote-text">' + escHtml(q2 || 'No specific mention found.') + '</div></td>' +
      '</tr>';
    }).join('');
    document.getElementById('themeRows').innerHTML = rowsHtml;

    // Show content
    document.getElementById('loadingState').style.display = 'none';
    document.getElementById('comparisonContent').style.display = 'block';

    // Likert rating
    var btns = document.querySelectorAll('.likert-btn');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var rating = btn.dataset.rating;
        btns.forEach(function (b) { b.classList.remove('selected'); b.classList.add('submitted'); });
        btn.classList.add('selected');

        var st = document.getElementById('likertStatus');
        st.textContent = 'Saving\u2026';
        st.style.color = '#6b7280';

        fetch(d.proxyUrl + '/feedback', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + d.idToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            platform: d.platform,
            comparisonModel: d.source,
            aiScore: score,
            humanRating: rating,
            humanReason: '',
            originalBrief: d.originalBrief,
            secondOpinion: d.secondOpinion,
            questionType: cmp.question_type || 'analytical',
          }),
        })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            st.textContent = 'Thanks for your feedback!';
            st.style.color = '#16a34a';
          })
          .catch(function (e) {
            st.textContent = 'Could not save \u2014 ' + e.message;
            st.style.color = '#dc2626';
            btns.forEach(function (b) { b.classList.remove('submitted'); });
          });
      });
    });
  });
})();
