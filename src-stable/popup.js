/**
 * popup.js
 * Portility — extension popup.
 *
 * Handles:
 *   - Operating Instructions questionnaire (onboarding flow)
 *   - Port Me: decrypt instructions from Firestore, pick destination, copy + open tab
 *   - Port My Chat: extract conversation from page, pick destination, copy + open tab
 *   - Edit Instructions: re-run questionnaire with pre-filled answers
 *   - Save as .txt: downloads content as a text file
 *   - Request a Feature: opens Google Form in new tab
 *   - Bug Report: collects metadata + optional note, sends to PostHog
 *   - Error capture: silently collects JS errors during popup session
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────
const POSTHOG_API_KEY = 'phc_Am8QxJfBbaSQVfEbANuaPVWWfeEWoKQEqK7QKo38Y9fD';
const POSTHOG_HOST = 'https://app.posthog.com';
// PROXY_URL, GOOGLE_SHEET_WEBHOOK are loaded from config.js (via script tag in popup.html)
const FEATURE_REQUEST_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeCMXd1I6-I0G0y3rl5C8a0Cl2qlrVXuwjtpa138eeaEnq_OQ/viewform?usp=dialog';

// ─── Destination URLs ─────────────────────────────────────────────────────────
const DESTINATION_URLS = {
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/',
  chatgpt: 'https://chatgpt.com/',
};

// ─── Clipboard helper with fallback ──────────────────────────────────────────
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Fallback when document loses focus (e.g. after OAuth popup)
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

// ─── Error capture ────────────────────────────────────────────────────────────
const _capturedErrors = [];
const MAX_ERRORS = 10;

window.addEventListener('error', (event) => {
  if (_capturedErrors.length >= MAX_ERRORS) return;
  _capturedErrors.push({
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    timestamp: new Date().toISOString(),
  });
});

window.addEventListener('unhandledrejection', (event) => {
  if (_capturedErrors.length >= MAX_ERRORS) return;
  _capturedErrors.push({
    message: event.reason?.message || String(event.reason),
    type: 'unhandledrejection',
    timestamp: new Date().toISOString(),
  });
});

// ─── Analytics ────────────────────────────────────────────────────────────────
async function getDistinctId() {
  return new Promise((resolve) => {
    chrome.storage.local.get('drewery_distinct_id', (data) => {
      resolve(data.drewery_distinct_id || 'drewery-popup-unknown');
    });
  });
}

async function trackEvent(eventName, properties) {
  if (!POSTHOG_API_KEY || POSTHOG_API_KEY === 'INSERT_POSTHOG_API_KEY_HERE') return;
  try {
    const distinctId = await getDistinctId();
    fetch(POSTHOG_HOST + '/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_API_KEY,
        event: eventName,
        distinct_id: distinctId,
        properties: Object.assign({ $lib: 'portility-extension', $lib_version: '1.2.0' }, properties || {}),
        timestamp: new Date().toISOString(),
      }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {}
}

// ─── Bug report ───────────────────────────────────────────────────────────────
const sessionStart = Date.now();

async function getActiveTabDomain() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]?.url) {
        try {
          resolve(new URL(tabs[0].url).hostname);
        } catch (e) {
          resolve('unknown');
        }
      } else {
        resolve('unknown');
      }
    });
  });
}

async function submitBugReport(userNote) {
  const manifest = chrome.runtime.getManifest();
  const domain = await getActiveTabDomain();

  await trackEvent('bug_report_submitted', {
    extensionVersion: manifest.version,
    extensionName: manifest.name,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    screenResolution: window.screen.width + 'x' + window.screen.height,
    windowSize: window.innerWidth + 'x' + window.innerHeight,
    activeTabDomain: domain,
    timestamp: new Date().toISOString(),
    sessionDuration: Math.round((Date.now() - sessionStart) / 1000) + 's',
    recentErrors: _capturedErrors.slice(),
    errorCount: _capturedErrors.length,
    userNote: (userNote || '').trim().slice(0, 500),
    reportType: 'user_initiated',
  });

  _capturedErrors.length = 0;
}

// ─── Moderation check via proxy ──────────────────────────────────────────────
async function checkModeration(text) {
  var proxyBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL !== 'YOUR_WORKER_URL') ? PROXY_URL : '';
  if (!proxyBase) {
    return { flagged: false, categories: {} };
  }

  try {
    var response = await fetch(proxyBase + '/moderate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
    });

    if (!response.ok) {
      return { flagged: false, categories: {} };
    }

    var data = await response.json();
    var result = data.results && data.results[0];
    if (!result) {
      return { flagged: false, categories: {} };
    }

    return {
      flagged: result.flagged || false,
      categories: result.categories || {},
    };
  } catch (e) {
    return { flagged: false, categories: {} };
  }
}

// ─── DOM ready ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // ── Element references ────────────────────────────────────────────────────
  const screen1 = document.getElementById('screen1');
  const screen2 = document.getElementById('screen2');
  const screen2Label = document.getElementById('screen2Label');

  const copyBtn = document.getElementById('copyBtn');
  const statusEl = document.getElementById('status');

  const backBtn = document.getElementById('backBtn');
  const claudeDestBtn = document.getElementById('claudeDestBtn');
  const geminiDestBtn = document.getElementById('geminiDestBtn');
  const chatgptDestBtn = document.getElementById('chatgptDestBtn');
  const saveDestBtn = document.getElementById('saveDestBtn');
  const screen2StatusEl = document.getElementById('screen2Status');

  const bugBtn = document.getElementById('bugBtn');
  const featureBtn = document.getElementById('featureBtn');
  const bugStatusEl = document.getElementById('bugStatus');

  const destBtns = [claudeDestBtn, geminiDestBtn, chatgptDestBtn, saveDestBtn];

  // ── Port Operating Instructions elements ──────────────────────────────────
  const portInstructionsBtn = document.getElementById('portInstructionsBtn');
  const portStatusEl = document.getElementById('portStatus');
  const editInstructionsBtn = document.getElementById('editInstructionsBtn');

  // ── Instructions checkbox ────────────────────────────────────────────────
  const instructionsCheckbox = document.getElementById('instructionsCheckbox');
  const instructionsCheckboxLabel = document.getElementById('instructionsCheckboxLabel');

  // ── Questionnaire elements ────────────────────────────────────────────────
  const questionnaireEl = document.getElementById('questionnaire');
  const qPage1NextBtn = document.getElementById('qPage1NextBtn');
  const qPortMeBtn = document.getElementById('qPortMeBtn');
  const qPage2Error = document.getElementById('qPage2Error');

  // ── Moderation modal references ────────────────────────────────────────────
  const moderationOverlay = document.getElementById('moderationOverlay');
  const modalOkayBtn = document.getElementById('modalOkayBtn');
  const modalErrorBtn = document.getElementById('modalErrorBtn');
  const modalFeedbackArea = document.getElementById('modalFeedbackArea');
  const modalFeedbackText = document.getElementById('modalFeedbackText');
  const modalSubmitBtn = document.getElementById('modalSubmitBtn');
  const modalThanks = document.getElementById('modalThanks');

  // Variable to hold extracted text so we can clear it on moderation flag
  let _extractedConversationText = null;

  // ── Port mode state ────────────────────────────────────────────────────
  let _portMode = 'chat'; // 'chat' or 'instructions'
  let _decryptedInstructions = null;

  // ── Questionnaire state (built dynamically from config) ─────────────────
  let qAnswers = {};
  function initAnswers() {
    qAnswers = {};
    var pages = QUESTIONNAIRE_CONFIG.pages;
    for (var p = 0; p < pages.length; p++) {
      var sections = pages[p].sections;
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];
        if (sec.type === 'multi-select') {
          qAnswers[sec.key] = [];
          qAnswers[sec.key + '_customText'] = '';
        } else if (sec.type === 'range') {
          qAnswers[sec.key] = sec.default || 3;
        } else if (sec.type === 'textarea') {
          qAnswers[sec.key] = '';
        } else {
          qAnswers[sec.key] = null;
        }
      }
    }
    // Hidden fields
    if (QUESTIONNAIRE_CONFIG.hiddenFields) {
      var hKeys = Object.keys(QUESTIONNAIRE_CONFIG.hiddenFields);
      for (var h = 0; h < hKeys.length; h++) {
        qAnswers[hKeys[h]] = null;
      }
    }
  }
  initAnswers();
  let isEditMode = false;
  let _justBuiltInstructions = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // DYNAMIC QUESTIONNAIRE RENDERER
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Render all questionnaire sections from QUESTIONNAIRE_CONFIG into the
   * container divs (#q-page1-content, #q-page2-content).
   */
  function renderQuestionnaire() {
    var pages = QUESTIONNAIRE_CONFIG.pages;
    for (var p = 0; p < pages.length; p++) {
      var page = pages[p];
      var container = document.getElementById(page.id + '-content');
      if (!container) continue;
      container.innerHTML = '';

      var sections = page.sections;
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];

        // Section title
        var titleEl = document.createElement('div');
        titleEl.className = 'q-section-title';
        titleEl.textContent = sec.title;
        container.appendChild(titleEl);

        if (sec.type === 'multi-select') {
          var wrap = document.createElement('div');
          wrap.setAttribute('data-multiselect', 'true');

          for (var o = 0; o < sec.options.length; o++) {
            var opt = sec.options[o];
            var btn = document.createElement('button');
            btn.className = 'q-option';
            btn.setAttribute('data-question', sec.key);
            btn.setAttribute('data-value', opt.value);
            btn.textContent = opt.label;
            wrap.appendChild(btn);

            // "Other" textarea
            if (opt.customTextPlaceholder) {
              var otherArea = document.createElement('div');
              otherArea.className = 'q-other-area';
              otherArea.id = 'q-other-area-' + sec.key;
              var ta = document.createElement('textarea');
              ta.className = 'q-textarea';
              ta.id = 'q-other-text-' + sec.key;
              ta.placeholder = opt.customTextPlaceholder;
              otherArea.appendChild(ta);
              wrap.appendChild(otherArea);
            }
          }
          container.appendChild(wrap);

        } else if (sec.type === 'single-select-chips') {
          var chipRow = document.createElement('div');
          chipRow.className = 'q-chips-row';
          for (var c = 0; c < sec.options.length; c++) {
            var chipOpt = sec.options[c];
            var chipBtn = document.createElement('button');
            chipBtn.className = 'q-option q-chip';
            chipBtn.setAttribute('data-question', sec.key);
            chipBtn.setAttribute('data-value', chipOpt.value);
            chipBtn.textContent = chipOpt.label;
            chipRow.appendChild(chipBtn);
          }
          container.appendChild(chipRow);

        } else if (sec.type === 'range') {
          if (sec.subtitle) {
            var subEl = document.createElement('div');
            subEl.className = 'q-section-subtitle';
            subEl.textContent = sec.subtitle;
            container.appendChild(subEl);
          }
          var rangeWrap = document.createElement('div');
          rangeWrap.className = 'q-range-wrap';
          var rangeInput = document.createElement('input');
          rangeInput.type = 'range';
          rangeInput.id = 'q-range-' + sec.key;
          rangeInput.min = sec.min;
          rangeInput.max = sec.max;
          rangeInput.value = sec.default;
          rangeInput.step = 1;
          rangeInput.className = 'q-range';
          rangeWrap.appendChild(rangeInput);

          if (sec.labels) {
            var labelsDiv = document.createElement('div');
            labelsDiv.className = 'q-range-labels';
            for (var l = 0; l < sec.labels.length; l++) {
              var span = document.createElement('span');
              span.textContent = sec.labels[l];
              labelsDiv.appendChild(span);
            }
            rangeWrap.appendChild(labelsDiv);
          }
          container.appendChild(rangeWrap);

        } else if (sec.type === 'textarea') {
          var textarea = document.createElement('textarea');
          textarea.className = 'q-textarea';
          textarea.id = 'q-textarea-' + sec.key;
          textarea.placeholder = sec.placeholder || '';
          container.appendChild(textarea);
        }
      }
    }
  }

  // Render once on load
  renderQuestionnaire();

  // ── Wire up destination chip click handlers (static HTML, not from config) ─
  var allDestChips = questionnaireEl.querySelectorAll('.q-dest-chip');
  for (var i = 0; i < allDestChips.length; i++) {
    allDestChips[i].addEventListener('click', function () {
      for (var j = 0; j < allDestChips.length; j++) { allDestChips[j].classList.remove('selected'); }
      this.classList.add('selected');
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERIC EVENT HANDLERS (work with any config)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Attach click handlers to all dynamically rendered q-option buttons.
   */
  function wireUpOptionHandlers() {
    var allQOptions = questionnaireEl.querySelectorAll('.q-option[data-question]');
    for (var i = 0; i < allQOptions.length; i++) {
      allQOptions[i].addEventListener('click', function () {
        var question = this.getAttribute('data-question');
        var value = this.getAttribute('data-value');
        var parentWrap = this.closest('[data-multiselect]');
        var isMultiSelect = !!parentWrap;

        if (isMultiSelect) {
          this.classList.toggle('selected');

          var arr = qAnswers[question];
          if (!Array.isArray(arr)) { arr = []; qAnswers[question] = arr; }
          var idx = arr.indexOf(value);
          if (idx >= 0) { arr.splice(idx, 1); } else { arr.push(value); }

          // Toggle "Other" textarea visibility
          var otherArea = document.getElementById('q-other-area-' + question);
          if (otherArea) {
            if (arr.indexOf('other') >= 0) {
              otherArea.classList.add('visible');
              var otherText = document.getElementById('q-other-text-' + question);
              if (otherText) otherText.focus();
            } else {
              otherArea.classList.remove('visible');
              qAnswers[question + '_customText'] = '';
            }
          }
        } else {
          // Single-select: deselect siblings
          var siblings = this.parentElement.querySelectorAll('.q-option[data-question="' + question + '"]');
          for (var j = 0; j < siblings.length; j++) { siblings[j].classList.remove('selected'); }
          this.classList.add('selected');
          qAnswers[question] = value;
        }
      });
    }
  }

  /**
   * Attach input handlers to all dynamically rendered range sliders.
   */
  function wireUpRangeHandlers() {
    var pages = QUESTIONNAIRE_CONFIG.pages;
    for (var p = 0; p < pages.length; p++) {
      var sections = pages[p].sections;
      for (var s = 0; s < sections.length; s++) {
        if (sections[s].type === 'range') {
          var key = sections[s].key;
          var rangeEl = document.getElementById('q-range-' + key);
          if (rangeEl) {
            (function (k) {
              rangeEl.addEventListener('input', function () {
                qAnswers[k] = parseInt(this.value, 10);
              });
            })(key);
          }
        }
      }
    }
  }

  wireUpOptionHandlers();
  wireUpRangeHandlers();

  // ═══════════════════════════════════════════════════════════════════════════
  // QUESTIONNAIRE NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════════

  function showQScreen(screenId) {
    var screens = questionnaireEl.querySelectorAll('.q-screen');
    for (var i = 0; i < screens.length; i++) {
      screens[i].classList.remove('active');
    }
    var target = document.getElementById(screenId);
    if (target) target.classList.add('active');
  }

  function startQuestionnaire(editMode) {
    isEditMode = !!editMode;
    document.body.classList.add('questionnaire-active');

    if (isEditMode) {
      chrome.storage.local.get('questionnaire_answers', function (data) {
        if (data.questionnaire_answers) {
          qAnswers = Object.assign({}, qAnswers, data.questionnaire_answers);
          prefillAnswers();
        }
        showQScreen('q-page1');
      });
    } else {
      showQScreen('q-page1');
    }

    trackEvent('questionnaire_started', { editMode: isEditMode });
  }

  function endQuestionnaire() {
    document.body.classList.remove('questionnaire-active');
    showNormalUI();
  }

  /**
   * Pre-fill the rendered questionnaire from qAnswers (for edit mode).
   * Works generically with any config.
   */
  function prefillAnswers() {
    // Highlight previously selected option buttons
    var allOptions = questionnaireEl.querySelectorAll('.q-option[data-question]');
    for (var i = 0; i < allOptions.length; i++) {
      var opt = allOptions[i];
      var question = opt.getAttribute('data-question');
      var value = opt.getAttribute('data-value');
      var answer = qAnswers[question];

      if (Array.isArray(answer)) {
        if (answer.indexOf(value) >= 0) {
          opt.classList.add('selected');
        } else {
          opt.classList.remove('selected');
        }
      } else {
        if (answer === value) {
          opt.classList.add('selected');
        } else {
          opt.classList.remove('selected');
        }
      }
    }

    // Pre-fill "Other" text areas and range sliders from config
    var pages = QUESTIONNAIRE_CONFIG.pages;
    for (var p = 0; p < pages.length; p++) {
      var sections = pages[p].sections;
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];
        if (sec.type === 'multi-select') {
          var arr = qAnswers[sec.key];
          if (Array.isArray(arr) && arr.indexOf('other') >= 0 && qAnswers[sec.key + '_customText']) {
            var otherText = document.getElementById('q-other-text-' + sec.key);
            var otherArea = document.getElementById('q-other-area-' + sec.key);
            if (otherText) otherText.value = qAnswers[sec.key + '_customText'];
            if (otherArea) otherArea.classList.add('visible');
          }
        } else if (sec.type === 'range') {
          var rangeEl = document.getElementById('q-range-' + sec.key);
          if (rangeEl && qAnswers[sec.key]) {
            rangeEl.value = qAnswers[sec.key];
          }
        } else if (sec.type === 'textarea') {
          var ta = document.getElementById('q-textarea-' + sec.key);
          if (ta && qAnswers[sec.key]) {
            ta.value = qAnswers[sec.key];
          }
        }
      }
    }

    // Reset destination chips
    var destChips = questionnaireEl.querySelectorAll('.q-dest-chip');
    for (var j = 0; j < destChips.length; j++) {
      destChips[j].classList.remove('selected');
    }
  }

  // ── Page 1 "Next" button ──────────────────────────────────────────────────
  qPage1NextBtn.addEventListener('click', function () {
    // Validate and capture answers for all page-1 sections from config
    var page1 = QUESTIONNAIRE_CONFIG.pages[0];
    if (!page1) return;

    for (var s = 0; s < page1.sections.length; s++) {
      var sec = page1.sections[s];

      if (sec.type === 'multi-select') {
        // First multi-select section must have at least one selection
        if (s === 0 && (!Array.isArray(qAnswers[sec.key]) || qAnswers[sec.key].length === 0)) {
          return;
        }
        // Capture "Other" custom text if selected
        if (Array.isArray(qAnswers[sec.key]) && qAnswers[sec.key].indexOf('other') >= 0) {
          var otherText = document.getElementById('q-other-text-' + sec.key);
          if (otherText) {
            var val = otherText.value.trim();
            if (!val) { otherText.focus(); return; }
            qAnswers[sec.key + '_customText'] = val;
          }
        }
      } else if (sec.type === 'range') {
        var rangeEl = document.getElementById('q-range-' + sec.key);
        if (rangeEl) {
          qAnswers[sec.key] = parseInt(rangeEl.value, 10);
        }
      }
    }

    showQScreen('q-page2');
  });

  // ── Page 2 "Port Me" button — save + port in one click ────────────────────
  qPortMeBtn.addEventListener('click', async function () {
    // Find selected destination
    var selectedDest = questionnaireEl.querySelector('.q-dest-chip.selected');
    if (!selectedDest) {
      qPage2Error.textContent = 'Please select a destination.';
      return;
    }
    var destination = selectedDest.getAttribute('data-dest');

    qPortMeBtn.disabled = true;
    qPortMeBtn.textContent = 'Saving\u2026';
    qPage2Error.textContent = '';

    try {
      // Capture all page-2 textarea answers from config
      var page2 = QUESTIONNAIRE_CONFIG.pages[1];
      if (page2) {
        for (var s2 = 0; s2 < page2.sections.length; s2++) {
          var sec2 = page2.sections[s2];
          if (sec2.type === 'textarea') {
            var ta2 = document.getElementById('q-textarea-' + sec2.key);
            if (ta2) qAnswers[sec2.key] = ta2.value.trim();
          }
        }
      }

      var instructions = buildInstructionPacket(qAnswers);
      _justBuiltInstructions = instructions;

      var auth = await ensureAuthenticated();
      try {
        await saveInstructionsToFirestore(instructions, auth.userId, auth.idToken, auth.firebaseUid, qAnswers);
      } catch (saveErr) {
        if (saveErr.message && (saveErr.message.indexOf('insufficient authentication scopes') !== -1 || saveErr.message.indexOf('401') !== -1 || saveErr.message.indexOf('403') !== -1)) {
          // Stale token — clear and re-auth
          await new Promise(function (resolve) {
            chrome.storage.local.remove(['google_access_token', 'firebase_id_token', 'firebase_uid', 'firebase_token_expiry'], resolve);
          });
          auth = await ensureAuthenticated();
          await saveInstructionsToFirestore(instructions, auth.userId, auth.idToken, auth.firebaseUid, qAnswers);
        } else {
          throw saveErr;
        }
      }

      await new Promise(function (resolve) {
        chrome.storage.local.set({
          questionnaire_completed: true,
          questionnaire_answers: qAnswers,
        }, resolve);
      });

      trackEvent('questionnaire_completed', { editMode: isEditMode, destination: destination });

      // Port to selected destination
      if (destination === 'save') {
        var blob = new Blob([instructions], { type: 'text/plain' });
        var blobUrl = URL.createObjectURL(blob);
        chrome.downloads.download({
          url: blobUrl,
          filename: 'portility-instructions.txt',
          saveAs: true,
        }, function () {
          URL.revokeObjectURL(blobUrl);
        });
        trackEvent('questionnaire_dest_save', {});
      } else {
        await writeClipboard(instructions);
        // Store text for auto-paste + auto-submit on destination tab — must complete before opening tab
        await new Promise(function (resolve) {
          chrome.storage.local.set({ portility_pending_paste: instructions }, resolve);
        });
        chrome.tabs.create({ url: DESTINATION_URLS[destination] });
        trackEvent('questionnaire_dest_port', { destination: destination });
      }

      endQuestionnaire();
    } catch (err) {
      qPage2Error.textContent = err.message || 'Failed to save. Try again.';
    } finally {
      qPortMeBtn.disabled = false;
      qPortMeBtn.textContent = 'Port Me';
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PORT OPERATING INSTRUCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  portInstructionsBtn.addEventListener('click', async function () {
    // If questionnaire not completed yet, launch it first
    var completed = await new Promise(function (resolve) {
      chrome.storage.local.get('questionnaire_completed', function (data) {
        resolve(!!data.questionnaire_completed);
      });
    });

    if (!completed) {
      startQuestionnaire(false);
      return;
    }

    _portMode = 'instructions';

    try {
      setPortStatus('Loading\u2026');
      portInstructionsBtn.disabled = true;
      _decryptedInstructions = await fetchAndDecryptInstructions();
      setPortStatus('');
      portInstructionsBtn.disabled = false;
      screen2Label.textContent = 'Port instructions to\u2026';
      setScreen2Status('');
      setAllDestBtnsDisabled(false);
      instructionsCheckboxLabel.style.display = 'none';
      showScreen('screen2');
    } catch (err) {
      portInstructionsBtn.disabled = false;
      setPortStatus(err.message || 'Something went wrong.', true);
    }
  });

  /**
   * Fetch and decrypt instructions from Firestore.
   * Uses the Google user ID as the encryption key.
   * Handles token expiry with automatic re-auth.
   * @returns {Promise<string>} Decrypted instructions text
   */
  async function fetchAndDecryptInstructions() {
    var auth = await ensureAuthenticated();
    var data = await getInstructionsFromFirestore(auth.idToken, auth.firebaseUid);
    if (!data) {
      throw new Error('No operating instructions saved yet. Run the questionnaire first.');
    }
    return await decryptInstructions(
      { encrypted: data.encrypted, salt: data.salt, iv: data.iv },
      auth.userId
    );
  }

  /**
   * Try to retrieve decrypted operating instructions for the chat port flow.
   * Returns the instructions text if available, or null if skipped/unavailable.
   */
  async function tryGetInstructions() {
    var completed = await new Promise(function (resolve) {
      chrome.storage.local.get('questionnaire_completed', function (data) {
        resolve(!!data.questionnaire_completed);
      });
    });
    if (!completed) return null;
    if (!instructionsCheckbox.checked) return null;
    try {
      return await fetchAndDecryptInstructions();
    } catch (e) {
      // If decryption fails (e.g. old passphrase-encrypted data), skip gracefully
      setScreen2Status('Could not load instructions \u2014 re-save them via Edit Instructions.', true);
      return null;
    }
  }

  function setPortStatus(msg, isError) {
    if (!portStatusEl) return;
    portStatusEl.textContent = msg;
    portStatusEl.style.fontSize = '11px';
    portStatusEl.style.marginTop = msg ? '6px' : '0';
    portStatusEl.style.color = isError ? '#dc2626' : '#6b7280';
    portStatusEl.style.lineHeight = '1.4';
  }

  // ── Edit Instructions button ──────────────────────────────────────────────
  editInstructionsBtn.addEventListener('click', function () {
    startQuestionnaire(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // NORMAL UI SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  function showNormalUI() {
    // Show edit link if questionnaire has been completed previously
    chrome.storage.local.get('questionnaire_completed', function (data) {
      if (data.questionnaire_completed) {
        editInstructionsBtn.style.display = 'inline';
      }
    });
  }

  // ── Moderation modal handlers ─────────────────────────────────────────────
  function showModerationModal() {
    modalFeedbackArea.style.display = 'none';
    modalFeedbackText.value = '';
    modalThanks.style.display = 'none';
    modalOkayBtn.style.display = 'block';
    modalErrorBtn.style.display = 'block';
    modalSubmitBtn.disabled = false;
    moderationOverlay.classList.add('visible');
  }

  function hideModerationModal() {
    moderationOverlay.classList.remove('visible');
  }

  function clearExtractedContext() {
    _extractedConversationText = null;
  }

  modalOkayBtn.addEventListener('click', function () {
    clearExtractedContext();
    hideModerationModal();
    setScreen2Status('');
    setAllDestBtnsDisabled(false);
  });

  modalErrorBtn.addEventListener('click', function () {
    modalOkayBtn.style.display = 'none';
    modalErrorBtn.style.display = 'none';
    modalFeedbackArea.style.display = 'block';
  });

  modalSubmitBtn.addEventListener('click', function () {
    const feedbackText = (modalFeedbackText.value || '').trim();
    if (!feedbackText) return;

    modalSubmitBtn.disabled = true;

    const webhookUrl = (typeof GOOGLE_SHEET_WEBHOOK !== 'undefined') ? GOOGLE_SHEET_WEBHOOK : 'YOUR_GOOGLE_SHEET_WEBHOOK';

    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedback: feedbackText,
        timestamp: new Date().toISOString(),
        source: 'portility-moderation-appeal',
      }),
      mode: 'no-cors',
    }).catch(function (e) {
    }).then(function () {
      modalFeedbackArea.style.display = 'none';
      modalThanks.style.display = 'block';

      setTimeout(function () {
        clearExtractedContext();
        hideModerationModal();
        setScreen2Status('');
        setAllDestBtnsDisabled(false);
      }, 2000);
    });
  });

  // ── Screen switching ──────────────────────────────────────────────────────
  function showScreen(id) {
    screen1.style.display = id === 'screen1' ? 'block' : 'none';
    screen2.style.display = id === 'screen2' ? 'block' : 'none';
  }

  // ── Status helpers ────────────────────────────────────────────────────────
  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = isError ? 'error' : '';
  }

  function setScreen2Status(msg, isError) {
    screen2StatusEl.textContent = msg;
    screen2StatusEl.className = isError ? 'error' : '';
  }

  function setAllDestBtnsDisabled(disabled) {
    destBtns.forEach((btn) => { btn.disabled = disabled; });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIRST-LAUNCH DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  // Always show normal UI on every launch
  showNormalUI();

  // ── Check if active tab has a conversation ────────────────────────────────
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.url) {
      setStatus('Open a conversation on Claude, ChatGPT, or Gemini to get started.');
      return;
    }

    const url = tab.url;
    const isSupported = /claude\.ai/i.test(url) || /chatgpt\.com/i.test(url) || /gemini\.google\.com/i.test(url);

    if (!isSupported) {
      setStatus('Open a conversation on Claude, ChatGPT, or Gemini to get started.');
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        setStatus('');
        return;
      }
      setStatus('');
    });
  });

  // ─── Port Your Conversation button → show Screen 2 ────────────────────────
  copyBtn.addEventListener('click', () => {
    _portMode = 'chat';
    screen2Label.textContent = 'Port conversation to\u2026';
    setScreen2Status('');
    setAllDestBtnsDisabled(false);

    // Show instructions checkbox only if user has completed the questionnaire
    chrome.storage.local.get('questionnaire_completed', function (data) {
      if (data.questionnaire_completed) {
        instructionsCheckboxLabel.style.display = 'flex';
        instructionsCheckbox.checked = true;
      } else {
        instructionsCheckboxLabel.style.display = 'none';
      }
    });

    showScreen('screen2');
  });

  // ─── Back button ──────────────────────────────────────────────────────────
  backBtn.addEventListener('click', () => {
    _portMode = 'chat';
    _decryptedInstructions = null;
    showScreen('screen1');
  });

  // ─── Destination handler ──────────────────────────────────────────────────
  async function handleDestination(destination) {
    setAllDestBtnsDisabled(true);

    // ── Instructions mode: already decrypted, just copy/save ──
    if (_portMode === 'instructions') {
      try {
        if (!_decryptedInstructions) {
          throw new Error('No decrypted instructions available.');
        }

        if (destination === 'save') {
          var blob = new Blob([_decryptedInstructions], { type: 'text/plain' });
          var blobUrl = URL.createObjectURL(blob);
          chrome.downloads.download({
            url: blobUrl,
            filename: 'portility-instructions.txt',
            saveAs: true,
          }, function () {
            URL.revokeObjectURL(blobUrl);
          });
          setScreen2Status('Instructions saved!');
          trackEvent('operating_instructions_saved', { destination: 'file' });
        } else {
          await writeClipboard(_decryptedInstructions);
          chrome.tabs.create({ url: DESTINATION_URLS[destination] });
          setScreen2Status('Instructions copied \u2014 paste them in the new tab!');
          trackEvent('operating_instructions_ported', { destination: destination });
        }
      } catch (err) {
        setScreen2Status(err.message || 'Something went wrong.', true);
        setAllDestBtnsDisabled(false);
      }
      return;
    }

    // ── Chat mode: extract from page ──
    setScreen2Status('Extracting\u2026');

    try {
      const tabs = await new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, resolve);
      });
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) throw new Error('No active tab found.');

      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT', skipClipboard: true }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error('Could not reach the page \u2014 try refreshing.'));
            return;
          }
          if (!resp || !resp.success) {
            reject(new Error(resp?.error || 'Extraction failed.'));
            return;
          }
          resolve(resp);
        });
      });

      const conversationText = response.text;
      _extractedConversationText = conversationText;

      trackEvent('portility_extract_initiated', {
        destination: destination,
        message_count: response.messageCount,
      });

      setScreen2Status('Checking content\u2026');
      const moderationResult = await checkModeration(conversationText);
      if (moderationResult.flagged) {
        trackEvent('portility_moderation_flagged', {
          destination: destination,
          categories: moderationResult.categories,
        });
        showModerationModal();
        return;
      }

      // Try to include operating instructions if available
      var instructions = await tryGetInstructions();
      var finalText = conversationText;
      if (instructions) {
        finalText = instructions + '\n\n---\n\n' + conversationText;
      }

      if (destination === 'save') {
        const blob = new Blob([finalText], { type: 'text/plain' });
        const blobUrl = URL.createObjectURL(blob);

        chrome.downloads.download({
          url: blobUrl,
          filename: 'portility-conversation.txt',
          saveAs: true,
        }, () => {
          URL.revokeObjectURL(blobUrl);
        });

        setScreen2Status('Conversation saved!');
        trackEvent('portility_save_success', { destination: 'file', instructions_included: !!instructions });
      } else {
        await writeClipboard(finalText);

        // Store text for auto-paste on Claude and Gemini destination tabs
        if (destination === 'claude' || destination === 'gemini' || destination === 'chatgpt') {
          chrome.storage.local.set({ portility_pending_paste: finalText });
        }

        chrome.tabs.create({ url: DESTINATION_URLS[destination] });
        setScreen2Status('Conversation copied \u2014 paste it in the new tab!');
        trackEvent('portility_port_success', { destination: destination, instructions_included: !!instructions });
      }
    } catch (err) {
      setScreen2Status(err.message || 'Something went wrong.', true);
      setAllDestBtnsDisabled(false);
      trackEvent('portility_port_failed', {
        destination: destination,
        error: err.message,
      });
    }
  }

  // ─── Destination button listeners ─────────────────────────────────────────
  claudeDestBtn.addEventListener('click', () => handleDestination('claude'));
  geminiDestBtn.addEventListener('click', () => handleDestination('gemini'));
  chatgptDestBtn.addEventListener('click', () => handleDestination('chatgpt'));
  saveDestBtn.addEventListener('click', () => handleDestination('save'));

  // ─── Bug report ───────────────────────────────────────────────────────────
  bugBtn.addEventListener('click', () => {
    const note = prompt('Describe the issue (optional):');
    if (note === null) return;

    bugBtn.disabled = true;
    bugStatusEl.textContent = 'Sending\u2026';
    bugStatusEl.className = '';

    submitBugReport(note).then(() => {
      bugStatusEl.textContent = 'Bug report sent \u2014 thank you!';
      bugStatusEl.className = 'sent';
      setTimeout(() => {
        bugBtn.disabled = false;
        bugStatusEl.textContent = '';
        bugStatusEl.className = '';
      }, 3000);
    }).catch(() => {
      bugStatusEl.textContent = 'Failed to send \u2014 try again.';
      bugBtn.disabled = false;
    });
  });

  // ─── Feature request ──────────────────────────────────────────────────────
  featureBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: FEATURE_REQUEST_URL });
  });
});
