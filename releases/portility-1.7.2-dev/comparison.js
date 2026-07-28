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

  // Generic words that cause false-positive keyword overlap across unrelated
  // theme rows (e.g. "cost", "annual", "strategy" appear in many titles).
  var SO_STOPWORDS = {
    'this': 1, 'that': 1, 'these': 1, 'those': 1, 'with': 1, 'from': 1, 'have': 1,
    'will': 1, 'your': 1, 'their': 1, 'there': 1, 'about': 1, 'which': 1, 'would': 1,
    'could': 1, 'should': 1, 'when': 1, 'while': 1, 'into': 1, 'than': 1, 'then': 1,
    'also': 1, 'were': 1, 'been': 1, 'being': 1, 'does': 1, 'each': 1, 'more': 1,
    'most': 1, 'some': 1, 'such': 1, 'only': 1, 'over': 1, 'under': 1, 'both': 1,
    'like': 1, 'here': 1, 'where': 1, 'what': 1, 'they': 1, 'them': 1, 'annual': 1,
    'general': 1, 'overall': 1, 'range': 1, 'cost': 1, 'costs': 1, 'strategy': 1,
    'recommendation': 1, 'level': 1, 'management': 1, 'elevation': 1,
  };

  function soExtractKeywords(str) {
    if (!str) return [];
    return str.toLowerCase().split(/\W+/).filter(function (w) {
      return w.length > 3 && !SO_STOPWORDS[w];
    });
  }

  // Finds the sentence in `text` most relevant to a theme's title/summary.
  // Title keywords are weighted higher (more specific signal) than summary
  // keywords, the score is normalized by sentence length so long sentences
  // don't win purely by containing more incidental matches, and
  // `usedSentences` (a Set, tracked per-column across all theme rows) is used
  // to avoid picking the same quote for multiple unrelated rows.
  function soFindRelevantQuote(text, title, summary, usedSentences) {
    if (!text || !title) return '';
    var titleWords = soExtractKeywords(title);
    var summaryWords = soExtractKeywords(summary);
    if (titleWords.length === 0 && summaryWords.length === 0) return '';

    var sentences = text.split(/[.!?\n]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 15; })
      // Exclude section-heading lines (e.g. "### On X" or "**On X**"). These
      // are often the literal source of the theme title's wording, so they
      // win the keyword-overlap score every time despite adding no new
      // information beyond restating the title.
      .filter(function (s) {
        if (/^#{1,6}\s/.test(s)) return false;
        if (/^\*\*[^*]+\*\*:?$/.test(s)) return false;
        return true;
      })
      // Exclude short label/heading fragments (e.g. "Develop yourself",
      // "Team Leadership") that lost their markdown/HTML markup during text
      // extraction from a rendered chat UI, leaving no syntactic cue that
      // they were a heading. These still win on the 1/sqrt(length) scoring
      // below purely by being short and keyword-dense, so require a minimum
      // word count to make sure the pick is an actual supporting sentence.
      .filter(function (s) { return s.split(/\s+/).length >= 5; });

    function pickBest(excludeUsed) {
      var best = '';
      var bestScore = 0;
      for (var i = 0; i < sentences.length; i++) {
        var s = sentences[i];
        if (excludeUsed && usedSentences && usedSentences.has(s)) continue;
        var lower = s.toLowerCase();
        var score = 0;
        for (var k = 0; k < titleWords.length; k++) {
          if (lower.indexOf(titleWords[k]) !== -1) score += 2;
        }
        for (var j = 0; j < summaryWords.length; j++) {
          if (lower.indexOf(summaryWords[j]) !== -1) score += 1;
        }
        if (score === 0) continue;
        var normalized = score / Math.sqrt(s.length);
        if (normalized > bestScore) {
          bestScore = normalized;
          best = s;
        }
      }
      return best;
    }

    // Prefer a sentence not already used for another row; if every scoring
    // candidate has been used, fall back to allowing reuse rather than
    // showing "No specific mention found."
    var best = pickBest(true) || pickBest(false);
    if (!best) return '';
    if (usedSentences) usedSentences.add(best);

    best = best.replace(/\*\*/g, '').replace(/^#+\s*/, '').replace(/^[-*]\s+/, '');
    if (best.length > 250) best = best.substring(0, 247) + '...';
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

    // Score dial
    var dialRot = -120 + (score / 100) * 240;
    document.getElementById('scoreDialNeedle').style.transform = 'rotate(' + dialRot + 'deg)';
    document.getElementById('scoreDialNeedleMain').setAttribute('stroke', scoreColor);
    document.getElementById('scoreDialNeedleTail').setAttribute('stroke', scoreColor);
    document.getElementById('scoreDialHub').setAttribute('fill', scoreColor);
    var scoreNumEl = document.getElementById('scoreDialNumber');
    scoreNumEl.textContent = score;
    scoreNumEl.setAttribute('fill', scoreColor);

    // Chat title (absent on comparisons generated before this field existed)
    if (d.chatTitle) {
      var chatTitleEl = document.getElementById('chatTitle');
      chatTitleEl.textContent = d.chatTitle;
      chatTitleEl.style.display = '';
    }

    // Interpretation
    document.getElementById('interpretation').textContent = cmp.interpretation || '';

    // Table headers
    document.getElementById('ai1Header').textContent = ai1Name;
    document.getElementById('ai2Header').textContent = ai2Name;

    // Build theme rows
    var agreementItems = [];
    (cmp.agreements || []).forEach(function (a) {
      // Support both object {title, text} and legacy string format
      if (typeof a === 'object' && a.title) {
        agreementItems.push({ text: a.text || '', title: a.title, type: 'agree', quoteA: a.quote_a, quoteB: a.quote_b });
      } else {
        agreementItems.push({ text: a, title: null, type: 'agree' });
      }
    });
    var divergenceItems = [];
    (cmp.divergences || []).forEach(function (dv) {
      if (typeof dv === 'object' && dv.title) {
        divergenceItems.push({ text: dv.text || '', title: dv.title, type: 'differ', quoteA: dv.quote_a, quoteB: dv.quote_b });
      } else {
        divergenceItems.push({ text: dv, title: null, type: 'differ' });
      }
    });
    // Show every agreement and divergence — previously this list was capped
    // at 5 combined items, so any comparison with more than 5 total points
    // (e.g. 8 agreements+divergences) silently dropped the rest, regardless
    // of ordering. All agreements first, then all divergences (matches the
    // grouped layout used in the popup's own results view).
    var allPoints = agreementItems.concat(divergenceItems);
    var themes = allPoints;

    var usedSentences1 = new Set();
    var usedSentences2 = new Set();
    var rowsData = themes.map(function (item) {
      var parts = item.title
        ? { title: item.title, summary: item.text }
        : soSplitTitleBody(item.text);
      // Prefer the model-provided quote — the model had full comprehension of
      // both response texts when it wrote this theme. Only fall back to the
      // heuristic when the field is entirely absent (comparison data cached
      // before this field existed). A present-but-empty value means the model
      // looked and found no match, which should show "No specific mention
      // found." below, not trigger the heuristic.
      var q1 = (typeof item.quoteA !== 'undefined')
        ? (item.quoteA || '')
        : soFindRelevantQuote(d.originalBrief, parts.title, parts.summary, usedSentences1);
      var q2 = (typeof item.quoteB !== 'undefined')
        ? (item.quoteB || '')
        : soFindRelevantQuote(d.secondOpinion, parts.title, parts.summary, usedSentences2);
      return { title: parts.title, summary: parts.summary, q1: q1, q2: q2, type: item.type };
    });
    var rowsHtml = rowsData.map(function (row) {
      var tagColor = row.type === 'agree' ? '#16a34a' : '#dc2626';
      var tagBg = row.type === 'agree' ? '#f0fdf4' : '#fef2f2';
      var tagLabel = row.type === 'agree' ? 'Agree' : 'Differ';
      return '<tr>' +
        '<td class="theme-cell"><strong>' + escHtml(row.title) + '</strong>' +
          '<span class="theme-tag" style="color:' + tagColor + ';background:' + tagBg + '">' + tagLabel + '</span>' +
          '<div class="theme-desc">' + escHtml(row.summary) + '</div></td>' +
        '<td class="quote-cell"><div class="quote-text">' + escHtml(row.q1 || 'No specific mention found.') + '</div></td>' +
        '<td class="quote-cell"><div class="quote-text">' + escHtml(row.q2 || 'No specific mention found.') + '</div></td>' +
      '</tr>';
    }).join('');
    document.getElementById('themeRows').innerHTML = rowsHtml;

    // Show content
    document.getElementById('loadingState').style.display = 'none';
    document.getElementById('comparisonContent').style.display = 'block';

    // Print / Download
    function doPrint() {
      window.print();
    }
    function doDownload() {
      var mdEsc = function (s) { return (s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); };
      var lines = [];
      if (d.chatTitle) {
        lines.push('# ' + mdEsc(d.chatTitle), '', '## Second Opinion Comparison', '');
      } else {
        lines.push('# Second Opinion Comparison', '');
      }
      lines.push('**Agreement Score:** ' + score + '%', '');
      if (cmp.interpretation) {
        lines.push(cmp.interpretation, '');
      }
      lines.push('| Theme | ' + mdEsc(ai1Name) + ' | ' + mdEsc(ai2Name) + ' |');
      lines.push('|---|---|---|');
      rowsData.forEach(function (row) {
        var tagLabel = row.type === 'agree' ? 'Agree' : 'Differ';
        var themeCell = '**' + mdEsc(row.title) + '** (' + tagLabel + ')<br>' + mdEsc(row.summary);
        lines.push('| ' + themeCell + ' | ' + mdEsc(row.q1 || 'No specific mention found.') + ' | ' + mdEsc(row.q2 || 'No specific mention found.') + ' |');
      });
      var md = lines.join('\n') + '\n';
      var blob = new Blob([md], { type: 'text/markdown' });
      var blobUrl = URL.createObjectURL(blob);
      chrome.downloads.download({
        url: blobUrl,
        filename: 'portility-second-opinion-' + new Date().toISOString().slice(0, 10) + '.md',
        saveAs: true,
      }, function () {
        URL.revokeObjectURL(blobUrl);
      });
    }
    document.getElementById('printBtn').addEventListener('click', doPrint);
    document.getElementById('downloadBtn').addEventListener('click', doDownload);

    // Auto-trigger print/download when opened from the popup's icon shortcuts
    // (?action=print / ?action=download appended to this page's URL).
    var autoAction = new URLSearchParams(location.search).get('action');
    if (autoAction === 'print') {
      setTimeout(doPrint, 300);
    } else if (autoAction === 'download') {
      doDownload();
    }

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
