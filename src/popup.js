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

// ─── Breadcrumb trail ─────────────────────────────────────────────────────────
const _breadcrumbs = [];
const MAX_CRUMBS = 30;

function crumb(action, data) {
  if (_breadcrumbs.length >= MAX_CRUMBS) _breadcrumbs.shift();
  _breadcrumbs.push({ action: action, data: data || {}, ts: Date.now() });
}

function flushBreadcrumbs(trigger) {
  if (_breadcrumbs.length === 0) return;
  trackEvent('session_breadcrumbs', {
    trigger: trigger,
    trail: _breadcrumbs.slice(),
    errorCount: _capturedErrors.length,
    errors: _capturedErrors.slice(),
  });
}

window.addEventListener('beforeunload', function () {
  flushBreadcrumbs('session_end');
});

window.addEventListener('error', function () {
  flushBreadcrumbs('js_error');
});

window.addEventListener('unhandledrejection', function () {
  flushBreadcrumbs('unhandled_rejection');
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
  const settingsGearBtn = document.getElementById('settingsGearBtn');

  const destBtns = [claudeDestBtn, geminiDestBtn, chatgptDestBtn, saveDestBtn];

  // ── Port Operating Instructions elements ──────────────────────────────────
  const portInstructionsBtn = document.getElementById('portInstructionsBtn');
  const portStatusEl = document.getElementById('portStatus');

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

  // ── Port My Chat Pro elements ──────────────────────────────────────────
  const proChatBtn = document.getElementById('proChatBtn');
  const freeButtonsDiv = document.getElementById('free-buttons');
  const paidButtonsDiv = document.getElementById('paid-buttons');
  const upgradeBtn = document.getElementById('upgradeBtn');
  const secondOpinionBtn = document.getElementById('secondOpinionBtn');
  const portInstructionsBtnFree = document.getElementById('portInstructionsBtnFree');
  const proReview = document.getElementById('proReview');
  const proBackBtn = document.getElementById('proBackBtn');
  const proLoading = document.getElementById('proLoading');
  const proContent = document.getElementById('proContent');
  const proBriefTitle = document.getElementById('proBriefTitle');
  const proBriefPreview = document.getElementById('proBriefPreview');
  const proAssetTableBody = document.getElementById('proAssetTableBody');
  const proAssetsSection = document.getElementById('proAssetsSection');
  const proNoAssets = document.getElementById('proNoAssets');
  const proConfirmBtn = document.getElementById('proConfirmBtn');
  const proError = document.getElementById('proError');
  const proStatus = document.getElementById('proStatus');

  // ── Popup resize helper ────────────────────────────────────────────────
  function setPopupSize(width, height) {
    document.body.style.width = width + 'px';
    document.body.style.height = height ? height + 'px' : 'auto';
    document.body.style.minHeight = height ? height + 'px' : '';
  }

  function expandPopup() { setPopupSize(400, 550); }
  function resetPopup() { setPopupSize(220, 300); }

  // ── Pro state ──────────────────────────────────────────────────────────
  let _proData = null;

  // ── User tier state ───────────────────────────────────────────────────
  let _userTier = 'free'; // 'free' or 'paid'
  const TIER_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  async function checkUserTier() {
    // Step 1: Check cached tier with timestamp
    var cached = await new Promise(function (resolve) {
      chrome.storage.local.get('userTier', function (result) { resolve(result.userTier); });
    });

    if (cached && cached.tier && cached.timestamp && (Date.now() - cached.timestamp < TIER_CACHE_TTL)) {
      console.log('[Popup] Using cached tier:', cached.tier);
      _userTier = cached.tier;
      applyTierUI();
      return;
    }

    // Step 2: Cache missing or stale — fetch fresh from Firestore
    try {
      var auth = await ensureAuthenticated();
      var tier = await getUserTier(auth.idToken, auth.firebaseUid);
      _userTier = tier;
      chrome.storage.local.set({ userTier: { tier: tier, timestamp: Date.now() } });
      console.log('[Popup] Fresh tier from Firestore:', tier);
      applyTierUI();
    } catch (e) {
      // Auth not available or Firestore unreachable — use cached tier if any
      if (cached && cached.tier) {
        _userTier = cached.tier;
      }
      console.log('[Popup] Tier refresh skipped:', e.message);
      applyTierUI();
    }
  }

  function applyTierUI() {
    var isPaid = _userTier === 'paid';
    console.log('[Popup] User tier:', _userTier);

    if (freeButtonsDiv) freeButtonsDiv.style.display = isPaid ? 'none' : '';
    if (paidButtonsDiv) paidButtonsDiv.style.display = isPaid ? '' : 'none';
  }

  // Check tier on popup load
  checkUserTier();

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
    crumb('quest_start', { editMode: isEditMode });
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

    crumb('quest_page1_done');
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
    crumb('quest_submit', { dest: destination });

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

      crumb('quest_auth');
      var auth = await ensureAuthenticated();
      crumb('quest_authed');
      crumb('quest_save');
      try {
        await saveInstructionsToFirestore(instructions, auth.userId, auth.idToken, auth.firebaseUid, qAnswers);
      } catch (saveErr) {
        if (saveErr.message && (saveErr.message.indexOf('insufficient authentication scopes') !== -1 || saveErr.message.indexOf('401') !== -1 || saveErr.message.indexOf('403') !== -1)) {
          // Stale token — clear and retry once
          crumb('quest_save_retry', { reason: saveErr.message.substring(0, 200) });
          await new Promise(function (resolve) {
            chrome.storage.local.remove(['google_access_token', 'firebase_id_token', 'firebase_uid', 'firebase_token_expiry'], resolve);
          });
          auth = await ensureAuthenticated();
          try {
            await saveInstructionsToFirestore(instructions, auth.userId, auth.idToken, auth.firebaseUid, qAnswers);
          } catch (retryErr) {
            throw new Error('Save failed after re-auth: ' + (retryErr.message || retryErr));
          }
        } else {
          throw saveErr;
        }
      }
      crumb('quest_saved');

      await new Promise(function (resolve) {
        chrome.storage.local.set({
          questionnaire_completed: true,
          questionnaire_answers: qAnswers,
        }, resolve);
      });

      trackEvent('questionnaire_completed', { editMode: isEditMode, destination: destination });

      // Port to selected destination
      crumb('quest_ported', { dest: destination });
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
      crumb('quest_failed', { error: (err.message || '').substring(0, 200) });
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
    crumb('instr_start');
    // If questionnaire not completed yet, launch it first
    var completed = await new Promise(function (resolve) {
      chrome.storage.local.get('questionnaire_completed', function (data) {
        resolve(!!data.questionnaire_completed);
      });
    });
    crumb('instr_quest_check', { completed: completed });

    if (!completed) {
      startQuestionnaire(false);
      return;
    }

    _portMode = 'instructions';

    try {
      setPortStatus('Loading\u2026');
      portInstructionsBtn.disabled = true;
      crumb('instr_fetch');
      _decryptedInstructions = await fetchAndDecryptInstructions();
      crumb('instr_decrypted');
      setPortStatus('');
      portInstructionsBtn.disabled = false;
      screen2Label.textContent = 'Port instructions to\u2026';
      setScreen2Status('');
      setAllDestBtnsDisabled(false);
      instructionsCheckboxLabel.style.display = 'none';
      showScreen('screen2');
    } catch (err) {
      crumb('instr_failed', { error: (err.message || '').substring(0, 200) });
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


  // ═══════════════════════════════════════════════════════════════════════════
  // NORMAL UI SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  function showNormalUI() {
    // Check if settings page requested an edit-instructions launch
    chrome.storage.local.get('edit_instructions_pending', function (data) {
      if (data.edit_instructions_pending) {
        chrome.storage.local.remove('edit_instructions_pending');
        startQuestionnaire(true);
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
    crumb('port_chat_start');
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
    crumb('dest_selected', { mode: _portMode, dest: destination });

    // ── Instructions mode: already decrypted, just copy/save ──
    if (_portMode === 'instructions') {
      crumb('instr_dest', { dest: destination });
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
          crumb('instr_ported', { dest: 'save' });
          trackEvent('operating_instructions_saved', { destination: 'file' });
        } else {
          await writeClipboard(_decryptedInstructions);
          chrome.tabs.create({ url: DESTINATION_URLS[destination] });
          setScreen2Status('Instructions copied \u2014 paste them in the new tab!');
          crumb('instr_ported', { dest: destination });
          trackEvent('operating_instructions_ported', { destination: destination });
        }
      } catch (err) {
        crumb('instr_failed', { error: (err.message || '').substring(0, 200) });
        setScreen2Status(err.message || 'Something went wrong.', true);
        setAllDestBtnsDisabled(false);
      }
      return;
    }

    // ── Chat mode: extract from page ──
    crumb('port_chat_extract');
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
      crumb('port_chat_extracted', { messageCount: response.messageCount });

      trackEvent('portility_extract_initiated', {
        destination: destination,
        message_count: response.messageCount,
      });

      crumb('port_chat_moderate');
      setScreen2Status('Checking content\u2026');
      const moderationResult = await checkModeration(conversationText);
      crumb('port_chat_moderated', { flagged: moderationResult.flagged });
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
      crumb('port_chat_instructions', { found: !!instructions });
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
        crumb('port_chat_saved');
        trackEvent('portility_save_success', { destination: 'file', instructions_included: !!instructions });
      } else {
        await writeClipboard(finalText);
        crumb('port_chat_copied');

        // Store text for auto-paste on Claude and Gemini destination tabs
        if (destination === 'claude' || destination === 'gemini' || destination === 'chatgpt') {
          chrome.storage.local.set({ portility_pending_paste: finalText });
        }

        chrome.tabs.create({ url: DESTINATION_URLS[destination] });
        crumb('port_chat_tab_opened', { dest: destination });
        setScreen2Status('Conversation copied \u2014 paste it in the new tab!');
        trackEvent('portility_port_success', { destination: destination, instructions_included: !!instructions });
      }
    } catch (err) {
      crumb('port_chat_failed', { error: (err.message || '').substring(0, 200) });
      setScreen2Status(err.message || 'Something went wrong.', true);
      setAllDestBtnsDisabled(false);
      trackEvent('portility_port_failed', {
        destination: destination,
        error: err.message,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PORT MY CHAT PRO
  // ═══════════════════════════════════════════════════════════════════════════

  function showProReview() {
    document.body.classList.add('pro-review-active');
    proLoading.style.display = 'block';
    proContent.style.display = 'none';
    proError.textContent = '';
    proStatus.textContent = '';
  }

  function hideProReview() {
    document.body.classList.remove('pro-review-active');
  }

  function mergeAssets(extractedAssets, sonnetAssets) {
    var merged = [];

    for (var i = 0; i < sonnetAssets.length; i++) {
      var sa = sonnetAssets[i];
      var matched = null;
      for (var j = 0; j < extractedAssets.length; j++) {
        var ea = extractedAssets[j];
        if (ea.filename && sa.description &&
            sa.description.toLowerCase().includes(ea.filename.toLowerCase())) {
          matched = ea;
          break;
        }
        if (ea.alt && sa.description &&
            sa.description.toLowerCase().includes(ea.alt.toLowerCase())) {
          matched = ea;
          break;
        }
      }

      merged.push({
        id: sa.id || ('asset_' + i),
        type: sa.type || (matched ? matched.type : 'file'),
        description: sa.description || (matched ? matched.alt : ''),
        important: sa.important !== undefined ? sa.important : true,
        reason: sa.reason || '',
        url: matched ? matched.url : null,
        thumbnailUrl: matched ? matched.thumbnailUrl : null,
        filename: matched ? matched.filename : (sa.description || 'asset_' + i),
        selected: sa.important !== false,
      });
    }

    // Add extracted assets not matched to Sonnet's list
    for (var k = 0; k < extractedAssets.length; k++) {
      var ea2 = extractedAssets[k];
      var alreadyMatched = merged.some(function (m) {
        return m.url === ea2.url && m.url;
      });
      if (!alreadyMatched && ea2.url) {
        merged.push({
          id: 'extra_' + k,
          type: ea2.type,
          description: ea2.alt || ea2.filename || 'Detected asset',
          important: false,
          reason: 'Detected in conversation but not flagged by AI analysis',
          url: ea2.url,
          thumbnailUrl: ea2.thumbnailUrl,
          filename: ea2.filename,
          selected: false,
        });
      }
    }

    return merged;
  }

  function renderProReview(data) {
    proLoading.style.display = 'none';
    proContent.style.display = 'block';

    proBriefTitle.textContent = data.title;
    proBriefPreview.textContent = data.brief;

    // Build asset table
    proAssetTableBody.innerHTML = '';

    if (data.assets.length === 0) {
      proAssetsSection.style.display = 'none';
      proNoAssets.style.display = 'block';
    } else {
      proAssetsSection.style.display = 'block';
      proNoAssets.style.display = 'none';

      for (var i = 0; i < data.assets.length; i++) {
        var asset = data.assets[i];
        var tr = document.createElement('tr');

        // Checkbox
        var tdCheck = document.createElement('td');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = asset.important !== false;
        cb.setAttribute('data-asset-index', i);
        cb.style.cursor = 'pointer';
        tdCheck.appendChild(cb);
        tr.appendChild(tdCheck);

        // Description (with optional thumbnail)
        var tdDesc = document.createElement('td');
        if (asset.thumbnailUrl && asset.type === 'image') {
          var thumb = document.createElement('img');
          thumb.className = 'pro-asset-thumb';
          thumb.src = asset.thumbnailUrl;
          thumb.alt = '';
          thumb.style.marginRight = '6px';
          thumb.style.verticalAlign = 'middle';
          tdDesc.appendChild(thumb);
        }
        var descSpan = document.createElement('span');
        descSpan.textContent = asset.description || asset.filename || asset.alt || 'Unnamed asset';
        descSpan.style.fontSize = '11px';
        tdDesc.appendChild(descSpan);
        tr.appendChild(tdDesc);

        // Type badge
        var tdType = document.createElement('td');
        var typeSpan = document.createElement('span');
        typeSpan.className = 'pro-asset-type ' + (asset.type || 'file');
        typeSpan.textContent = asset.type || 'file';
        tdType.appendChild(typeSpan);
        tr.appendChild(tdType);

        // Reason
        var tdReason = document.createElement('td');
        tdReason.className = 'pro-asset-reason';
        tdReason.textContent = asset.reason || '';
        tr.appendChild(tdReason);

        proAssetTableBody.appendChild(tr);
      }
    }
  }

  function buildDownloadContent(data) {
    var md = '# ' + data.title + '\n\n';
    md += '*Generated by Portility Pro on ' + new Date().toLocaleDateString() + '*\n';
    md += '*Source: ' + data.sourcePlatform + '*\n\n';
    md += '---\n\n';
    md += data.brief + '\n\n';

    var selectedAssets = data.assets.filter(function (a) { return a.selected; });
    if (selectedAssets.length > 0) {
      md += '---\n\n';
      md += '## Asset Manifest\n\n';
      md += '| Asset | Type | Description |\n';
      md += '|-------|------|-------------|\n';
      for (var i = 0; i < selectedAssets.length; i++) {
        var a = selectedAssets[i];
        md += '| ' + (a.filename || a.description || 'Asset ' + (i + 1)) +
              ' | ' + (a.type || '-') +
              ' | ' + (a.description || '-') + ' |\n';
      }
    }

    return md;
  }

  proChatBtn.addEventListener('click', async function () {
    proChatBtn.disabled = true;
    setStatus('Extracting conversation...');

    try {
      // Step 1: Get active tab
      const tabs = await new Promise(function (resolve) {
        chrome.tabs.query({ active: true, currentWindow: true }, resolve);
      });
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) throw new Error('No active tab found.');

      var sourcePlatform = 'unknown';
      if (/claude\.ai/i.test(tab.url)) sourcePlatform = 'claude';
      else if (/chatgpt\.com/i.test(tab.url)) sourcePlatform = 'chatgpt';
      else if (/gemini\.google\.com/i.test(tab.url)) sourcePlatform = 'gemini';
      crumb('pro_start', { platform: sourcePlatform });

      // Step 2: Extract conversation + assets
      crumb('pro_extract');
      setStatus('Extracting conversation and assets...');
      const extractResponse = await new Promise(function (resolve, reject) {
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PRO' }, function (resp) {
          if (chrome.runtime.lastError) {
            reject(new Error('Could not reach the page \u2014 try refreshing.'));
            return;
          }
          if (!resp || !resp.success) {
            reject(new Error(resp && resp.error ? resp.error : 'Extraction failed.'));
            return;
          }
          resolve(resp);
        });
      });

      crumb('pro_extracted', { messageCount: extractResponse.messageCount, assetCount: (extractResponse.assets || []).length });
      console.log('[Pro] Extracted assets:', (extractResponse.assets || []).length, extractResponse.assets);

      // No assets detected → skip Pro review, go straight to destination screen
      if (!extractResponse.assets || extractResponse.assets.length === 0) {
        console.log('[Pro] No assets — skipping to destination screen');
        crumb('pro_no_assets_skip');
        trackEvent('pro_no_assets_skip', { platform: sourcePlatform });
        setStatus('');
        _portMode = 'chat';
        screen2Label.textContent = 'Port conversation to\u2026';
        setScreen2Status('');
        setAllDestBtnsDisabled(false);
        showScreen('screen2');
        proChatBtn.disabled = false;
        return;
      }

      // Step 3: Moderation check
      crumb('pro_moderate');
      setStatus('Checking content...');
      const moderationResult = await checkModeration(extractResponse.text);
      crumb('pro_moderated', { flagged: moderationResult.flagged });
      if (moderationResult.flagged) {
        trackEvent('portility_moderation_flagged', {
          source: 'pro',
          platform: sourcePlatform,
        });
        showModerationModal();
        proChatBtn.disabled = false;
        setStatus('');
        return;
      }

      // Step 4: Switch to Pro review screen
      setStatus('');
      showProReview();

      // Step 4b: Check Drive auth and start concurrent auth if needed (only if backup enabled)
      var driveAuthPromise = null;
      var driveBackupSettings = await new Promise(function (resolve) {
        chrome.storage.local.get('portility_drive_backup_enabled', resolve);
      });
      var driveBackupEnabled = driveBackupSettings.portility_drive_backup_enabled === true;

      if (driveBackupEnabled) {
        try {
          console.log('[Pro] Checking Drive auth...');
          var driveCheck = await new Promise(function (resolve) {
            chrome.runtime.sendMessage({ type: 'CHECK_DRIVE_AUTH' }, function (resp) {
              console.log('[Pro] CHECK_DRIVE_AUTH response:', resp);
              resolve(resp || { authenticated: false });
            });
          });
          if (!driveCheck.authenticated) {
            console.log('[Pro] Drive not authenticated, starting auth flow...');
            crumb('pro_drive_auth_start');
            driveAuthPromise = new Promise(function (resolve) {
              chrome.runtime.sendMessage({ type: 'START_GDRIVE_AUTH' }, function (resp) {
                console.log('[Pro] START_GDRIVE_AUTH response:', resp);
                resolve(resp || { authenticated: false });
              });
            });
          } else {
            console.log('[Pro] Drive already authenticated');
          }
        } catch (e) {
          // Drive check failed — continue without Drive
          console.log('[Pro] Drive check error:', e.message);
          crumb('pro_drive_check_error', { error: (e.message || '').substring(0, 100) });
        }
      } else {
        console.log('[Pro] Drive backup disabled, skipping auth');
      }

      // Step 5: Call worker /summarize-pro (runs concurrently with Drive auth)
      crumb('pro_summarize');
      const proxyBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL !== 'YOUR_WORKER_URL') ? PROXY_URL : '';
      if (!proxyBase) throw new Error('Proxy URL not configured.');

      var summaryPromise = fetch(proxyBase + '/summarize-pro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation: extractResponse.text,
          assets: extractResponse.assets || [],
        }),
      });

      // Wait for summary and Drive auth concurrently
      var results = await Promise.allSettled(
        driveAuthPromise ? [summaryPromise, driveAuthPromise] : [summaryPromise]
      );

      // Handle Drive auth result
      if (driveAuthPromise && results[1]) {
        var driveResult = results[1].status === 'fulfilled' ? results[1].value : null;
        if (driveResult && driveResult.authenticated) {
          crumb('pro_drive_auth_success');
        } else {
          crumb('pro_drive_auth_failed', {
            error: (driveResult && driveResult.error || '').substring(0, 100),
          });
        }
      }

      // Handle summary result
      if (results[0].status === 'rejected') {
        throw results[0].reason || new Error('AI analysis failed');
      }
      const proResponse = results[0].value;

      if (!proResponse.ok) {
        throw new Error('AI analysis failed (HTTP ' + proResponse.status + ')');
      }

      const proResponseData = await proResponse.json();

      // Step 6: Parse Sonnet's response
      crumb('pro_summarized', { hasContent: !!(proResponseData.content && proResponseData.content.length) });
      var contentText = '';
      if (proResponseData.content && proResponseData.content.length > 0) {
        contentText = proResponseData.content[0].text || '';
      }

      var parsed;
      try {
        var jsonStr = contentText;
        var codeBlockMatch = contentText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (codeBlockMatch) jsonStr = codeBlockMatch[1];
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        parsed = {
          title: 'Project Brief',
          brief: contentText,
          assets: [],
        };
      }

      crumb('pro_parsed', { hasTitle: !!parsed.title, assetCount: (parsed.assets || []).length });
      var mergedAssets = mergeAssets(extractResponse.assets || [], parsed.assets || []);

      _proData = {
        title: parsed.title || 'Project Brief',
        brief: parsed.brief || contentText,
        assets: mergedAssets,
        rawConversation: extractResponse.text,
        sourcePlatform: sourcePlatform,
        sourceUrl: tab.url,
      };

      // Step 7: Render review
      renderProReview(_proData);
      crumb('pro_rendered');

      trackEvent('pro_brief_generated', {
        sourcePlatform: sourcePlatform,
        messageCount: extractResponse.messageCount,
        assetCount: mergedAssets.length,
      });

    } catch (err) {
      crumb('pro_failed', { error: (err.message || '').substring(0, 200) });
      hideProReview();
      setStatus(err.message || 'Something went wrong.', true);
    } finally {
      proChatBtn.disabled = false;
    }
  });

  proBackBtn.addEventListener('click', function () {
    if (_proData) {
      trackEvent('pro_brief_cancelled', {
        sourcePlatform: _proData.sourcePlatform,
      });
    }
    hideProReview();
    _proData = null;
  });

  proConfirmBtn.addEventListener('click', async function () {
    if (!_proData) return;
    crumb('pro_confirm');

    proConfirmBtn.disabled = true;
    proStatus.textContent = 'Saving...';
    proError.textContent = '';

    try {
      // Collect user's checkbox selections
      var checkboxes = proAssetTableBody.querySelectorAll('input[type="checkbox"]');
      for (var i = 0; i < checkboxes.length; i++) {
        var idx = parseInt(checkboxes[i].getAttribute('data-asset-index'), 10);
        if (_proData.assets[idx]) {
          _proData.assets[idx].selected = checkboxes[i].checked;
        }
      }

      // Save to IndexedDB
      var briefRecord = {
        title: _proData.title,
        brief: _proData.brief,
        assets: _proData.assets,
        sourcePlatform: _proData.sourcePlatform,
        sourceUrl: _proData.sourceUrl,
        rawConversation: _proData.rawConversation,
      };

      await saveProjectBrief(briefRecord);
      // Persist brief for Second Opinion retrieval
      chrome.storage.local.set({ lastProBrief: { brief: _proData.brief, timestamp: Date.now() } });
      crumb('pro_saved');

      // Download as .md file
      var downloadContent = buildDownloadContent(_proData);
      var blob = new Blob([downloadContent], { type: 'text/markdown' });
      var blobUrl = URL.createObjectURL(blob);

      var safeTitle = _proData.title.replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 50).trim();
      var filename = 'portility-pro-' + (safeTitle || 'brief') + '.md';

      chrome.downloads.download({
        url: blobUrl,
        filename: filename,
        saveAs: true,
      }, function () {
        URL.revokeObjectURL(blobUrl);
      });

      crumb('pro_downloaded');
      proStatus.textContent = 'Brief saved and downloaded!';

      trackEvent('pro_brief_confirmed', {
        sourcePlatform: _proData.sourcePlatform,
        assetsTotal: _proData.assets.length,
        assetsSelected: _proData.assets.filter(function (a) { return a.selected; }).length,
      });

      setTimeout(function () {
        hideProReview();
        _proData = null;
      }, 2000);

    } catch (err) {
      proError.textContent = err.message || 'Failed to save.';
    } finally {
      proConfirmBtn.disabled = false;
    }
  });

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

  // ─── Second Opinion ────────────────────────────────────────────────────────
  async function triggerSecondOpinion() {
    var proxyBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL !== 'YOUR_WORKER_URL') ? PROXY_URL : '';
    if (!proxyBase) {
      setStatus('Worker URL not configured.', true);
      return;
    }

    secondOpinionBtn.disabled = true;
    showDialLoading('Reading conversation\u2026');

    try {
      // Step 1: Get active tab and detect platform
      var tab = await new Promise(function (resolve) {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          resolve(tabs[0]);
        });
      });
      if (!tab || !tab.id) throw new Error('No active tab found.');

      var platform = 'claude';
      if (/chatgpt\.com/i.test(tab.url)) platform = 'chatgpt';
      else if (/gemini\.google\.com/i.test(tab.url)) platform = 'gemini';
      else if (/claude\.ai/i.test(tab.url)) platform = 'claude';

      // Step 2: Extract conversation from the page
      var extractResponse = await new Promise(function (resolve, reject) {
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PRO' }, function (resp) {
          if (chrome.runtime.lastError) {
            reject(new Error('Could not reach the page \u2014 try refreshing.'));
            return;
          }
          if (!resp || !resp.success) {
            reject(new Error(resp && resp.error ? resp.error : 'Extraction failed.'));
            return;
          }
          resolve(resp);
        });
      });

      if (!extractResponse.text) throw new Error('No conversation text found on page.');

      // Step 3: Generate summary via /summarize-pro
      updateDialStatus('Analyzing conversation\u2026');
      var summaryResp = await fetch(proxyBase + '/summarize-pro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation: extractResponse.text,
          assets: extractResponse.assets || [],
        }),
      });

      if (!summaryResp.ok) throw new Error('AI analysis failed (HTTP ' + summaryResp.status + ')');
      var summaryData = await summaryResp.json();

      var contentText = '';
      if (summaryData.content && summaryData.content.length > 0) {
        contentText = summaryData.content[0].text || '';
      }

      var parsed;
      try {
        var jsonStr = contentText;
        var codeBlockMatch = contentText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (codeBlockMatch) jsonStr = codeBlockMatch[1];
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        parsed = { title: 'Project Brief', brief: contentText, assets: [] };
      }

      var artifact = parsed.brief || contentText;

      // Step 4: Compress any embedded base64 images
      var imgRegex = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g;
      var imgMatches = artifact.match(imgRegex);
      if (imgMatches) {
        for (var i = 0; i < imgMatches.length; i++) {
          try {
            var compressed = await compressImage(imgMatches[i]);
            artifact = artifact.replace(imgMatches[i], compressed);
          } catch (e) {
            console.log('[SecondOpinion] Image compression failed, using original');
          }
        }
      }

      // Step 5: POST to /second-opinion
      updateDialStatus('Getting a second opinion\u2026');

      var soResp = await fetch(proxyBase + '/second-opinion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: artifact, platform: platform }),
      });

      var soData = await soResp.json();
      if (!soResp.ok) throw new Error(soData.error || 'Second opinion request failed');

      // Step 6: POST to /compare
      updateDialStatus('Comparing both responses\u2026');

      var compareResp = await fetch(proxyBase + '/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ original: artifact, secondOpinion: soData.text }),
      });

      var compareData = await compareResp.json();
      if (!compareResp.ok) throw new Error(compareData.error || 'Comparison request failed');

      // Step 7: Pass to results UI (Task 14)
      showSecondOpinionResults({
        secondOpinion: soData.text,
        source: soData.source,
        platform: platform,
        comparison: compareData,
      });

    } catch (err) {
      soResultsEl.classList.remove('so-loading');
      soResultsEl.style.display = 'none';
      screen1.style.display = 'block';
      resetPopup();
      setStatus(err.message || 'Something went wrong.', true);
    } finally {
      secondOpinionBtn.disabled = false;
    }
  }

  // ── Second Opinion Results UI (SVG Gauge Dial) ────────────────────────────
  var soResultsEl = document.getElementById('soResults');
  var soBackBtn = document.getElementById('soBackBtn');
  var soModelName = document.getElementById('so-model-name');
  var soViewFullBtn = document.getElementById('soViewFullBtn');
  var _soCurrentScore = 0;
  var _soAnimFrame;
  var _soFullText = '';

  function soZoneId(score) {
    return score < 34 ? 'conflict' : score < 67 ? 'mixed' : 'agrees';
  }

  function soZoneColors(score) {
    if (score < 34) return { text: '#c43030', needle: '#E24B4A' };
    if (score < 67) return { text: '#a07800', needle: '#c9a000' };
    return { text: '#059618', needle: '#09d624' };
  }

  function soTypeColors(questionType) {
    var map = {
      factual:    ['#E6F1FB', '#185FA5', '#B5D4F4'],
      subjective: ['#EEEDFE', '#534AB7', '#CECBF6'],
      analytical: ['#E1F5EE', '#0F6E56', '#9FE1CB'],
    };
    return map[questionType] || map.factual;
  }

  function soScoreLbl(score) {
    return score < 34 ? 'Significant disagreement'
         : score < 67 ? 'Partial overlap'
         : 'Strong agreement';
  }

  function soAnimateScore(from, to, textColor) {
    cancelAnimationFrame(_soAnimFrame);
    var t0 = performance.now();
    var scoreEl = document.getElementById('so-score-number');
    (function tick(t) {
      var p = Math.min((t - t0) / 900, 1);
      var e = 1 - Math.pow(1 - p, 3);
      scoreEl.textContent = Math.round(from + (to - from) * e);
      scoreEl.setAttribute('fill', textColor);
      if (p < 1) _soAnimFrame = requestAnimationFrame(tick);
    })(t0);
  }

  function escHtml(str) {
    var d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function showSecondOpinionResults(data) {
    console.log('[SecondOpinion] Results:', data);
    var cmp = data.comparison;
    var score = Math.round(cmp.agreement_score || 0);
    var c = soZoneColors(score);
    var zone = soZoneId(score);
    var questionType = cmp.question_type || 'analytical';
    var tc = soTypeColors(questionType);

    // Badge
    var badge = document.getElementById('so-badge');
    badge.textContent = questionType.charAt(0).toUpperCase() + questionType.slice(1);
    badge.style.background = tc[0];
    badge.style.color = tc[1];
    badge.style.borderColor = tc[2];

    // Ensure gauge band is visible
    document.getElementById('so-gauge-band').style.opacity = '1';

    // Needle
    var svgRot = -120 + (score / 100) * 240;
    document.getElementById('so-needle').style.transform = 'rotate(' + svgRot + 'deg)';
    document.getElementById('so-needle-main').setAttribute('stroke', c.needle);
    document.getElementById('so-needle-tail').setAttribute('stroke', c.needle);
    document.getElementById('so-hub-dot').setAttribute('fill', c.needle);

    // Animated score counter
    soAnimateScore(_soCurrentScore, score, c.text);
    _soCurrentScore = score;

    // Score label
    document.getElementById('so-score-lbl').textContent = soScoreLbl(score);

    // Interpretation
    document.getElementById('so-interp').textContent = cmp.interpretation || '';

    // Agreements
    document.getElementById('so-agree-list').innerHTML =
      (cmp.agreements || []).map(function (a) {
        return '<div class="so-list-row" style="border-color:#C0DD97">' + escHtml(a) + '</div>';
      }).join('');

    // Divergences
    document.getElementById('so-diff-list').innerHTML =
      (cmp.divergences || []).map(function (d) {
        return '<div class="so-list-row" style="border-color:#F7C1C1">' + escHtml(d) + '</div>';
      }).join('');

    // Model name for footer
    var modelMap = { chatgpt: 'GPT-4o', claude: 'Claude Sonnet 4.6' };
    soModelName.textContent = 'Comparison model: ' + (modelMap[data.source] || data.source);

    // Store full text for "View full comparison"
    _soFullText = data.secondOpinion || '';

    // Transition from loading to results
    soResultsEl.classList.remove('so-loading');
    document.getElementById('so-status-text').textContent = '';
    setStatus('');
    screen1.style.display = 'none';
    soResultsEl.style.display = 'block';
  }

  function showDialLoading(statusText) {
    // Reset dial to gray/neutral state
    document.getElementById('so-score-number').textContent = '\u2026';
    document.getElementById('so-score-number').setAttribute('fill', '#d1d5db');
    document.getElementById('so-score-lbl').textContent = '';
    document.getElementById('so-needle').style.transform = 'rotate(-120deg)';
    document.getElementById('so-needle-main').setAttribute('stroke', '#d1d5db');
    document.getElementById('so-needle-tail').setAttribute('stroke', '#d1d5db');
    document.getElementById('so-hub-dot').setAttribute('fill', '#d1d5db');
    document.getElementById('so-gauge-band').style.opacity = '0.15';
    document.getElementById('so-agree-list').innerHTML = '';
    document.getElementById('so-diff-list').innerHTML = '';
    document.getElementById('so-interp').textContent = '';
    document.getElementById('so-status-text').textContent = statusText || '';
    _soCurrentScore = 0;

    // Add loading class for pulse + hide lists
    soResultsEl.classList.add('so-loading');

    // Show the results screen
    screen1.style.display = 'none';
    soResultsEl.style.display = 'block';
    expandPopup();
  }

  function updateDialStatus(statusText) {
    document.getElementById('so-status-text').textContent = statusText || '';
  }

  // Expose for console testing (remove before release)
  window._testSO = showSecondOpinionResults;

  soViewFullBtn.addEventListener('click', function () {
    if (!_soFullText) return;
    var blob = new Blob([_soFullText], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    chrome.tabs.create({ url: url });
  });

  soBackBtn.addEventListener('click', function () {
    soResultsEl.classList.remove('so-loading');
    soResultsEl.style.display = 'none';
    resetPopup();
    screen1.style.display = 'block';
  });

  secondOpinionBtn.addEventListener('click', function () {
    triggerSecondOpinion();
  });

  // ─── Settings gear ─────────────────────────────────────────────────────────
  settingsGearBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ─── Upgrade button ──────────────────────────────────────────────────────
  upgradeBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.portility.ai/pricing' });
  });

  // ─── Port Me (free) — same handler as Port Me Pro ────────────────────────
  portInstructionsBtnFree.addEventListener('click', function () {
    portInstructionsBtn.click();
  });
});
