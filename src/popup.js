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
let FEATURE_REQUEST_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeCMXd1I6-I0G0y3rl5C8a0Cl2qlrVXuwjtpa138eeaEnq_OQ/viewform?usp=dialog';

// ─── Destination URLs (overridable via remote config) ─────────────────────────
let DESTINATION_URLS = {
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/',
  chatgpt: 'https://chatgpt.com/',
};

// Override URLs and features from remote config cache (non-blocking)
if (window.PortilityConfig) {
  window.PortilityConfig.getRemoteUrls().then(function (urls) {
    if (!urls) return;
    if (urls.destinations) {
      if (urls.destinations.claude) DESTINATION_URLS.claude = urls.destinations.claude;
      if (urls.destinations.gemini) DESTINATION_URLS.gemini = urls.destinations.gemini;
      if (urls.destinations.chatgpt) DESTINATION_URLS.chatgpt = urls.destinations.chatgpt;
    }
    if (urls.featureRequest) FEATURE_REQUEST_URL = urls.featureRequest;
  });
}

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

// ─── Filename helper ─────────────────────────────────────────────────────────
function safeChatFilename(title, platform) {
  var name = title.replace(/\s*[-|]\s*(Claude|ChatGPT|Gemini|Copilot).*$/i, '').trim();
  name = name.replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 50).trim();
  name = name || 'portility-conversation';
  var aiLabel = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }[platform] || platform || '';
  var date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return name + (aiLabel ? '-' + aiLabel : '') + '-' + date;
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
  } catch (e) { /* tracking errors are non-critical */ }
}

function trackTokenUsage(endpoint, usage) {
  if (!usage) return;
  trackEvent('tokens_used', {
    endpoint: endpoint,
    provider: usage.provider,
    model: usage.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
  });
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
  // ── Refresh remote config if stale ──────────────────────────────────────
  if (window.PortilityConfig) {
    window.PortilityConfig.isConfigStale().then(function (stale) {
      if (stale) {
        var proxyBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL !== 'YOUR_WORKER_URL') ? PROXY_URL : '';
        if (proxyBase) window.PortilityConfig.fetchRemoteConfig(proxyBase);
      }
    });
  }

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
  const includeProfileLabel = document.getElementById('includeProfileLabel');
  const includeProfileCheckbox = document.getElementById('includeProfileCheckbox');
  const profileSelect = document.getElementById('profileSelect');

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

  // ── Usage blocked modal references ────────────────────────────────────────
  const usageBlockedOverlay = document.getElementById('usageBlockedOverlay');
  const usageBlockedMsg = document.getElementById('usageBlockedMsg');
  const usageUpgradeBtn = document.getElementById('usageUpgradeBtn');
  const usageBlockedFreeBtn = document.getElementById('usageBlockedFreeBtn');
  const usageBlockedDismissBtn = document.getElementById('usageBlockedDismissBtn');

  usageBlockedDismissBtn.addEventListener('click', function () {
    usageBlockedOverlay.classList.remove('visible');
  });

  usageBlockedFreeBtn.addEventListener('click', function () {
    usageBlockedOverlay.classList.remove('visible');
    // Revert to free buttons
    if (freeButtonsDiv) freeButtonsDiv.style.display = '';
    if (paidButtonsDiv) paidButtonsDiv.style.display = 'none';
    upgradeBtn.textContent = 'Upgrade to Pro';
    upgradeBtn.dataset.mode = 'upgrade';
    crumb('trial_revert_free');
    trackEvent('trial_revert_free');
  });

  // When a dev tier override is active, substitute the overridden tier's
  // limits into server responses so the popup reflects the selected tier.
  function applyDevTierToResult(result) {
    if (!_devTierOverride) return result;
    var tierConfig = (typeof USAGE_TIERS !== 'undefined') ? USAGE_TIERS[_devTierOverride] : null;
    if (!tierConfig) return result;
    var patched = Object.assign({}, result, {
      tier: _devTierOverride,
      limit: tierConfig.limit,
      upgradeUrl: (typeof UPGRADE_URLS !== 'undefined') ? UPGRADE_URLS[_devTierOverride] : null,
    });
    // Unlimited tier is never blocked and never warned
    if (tierConfig.limit === Infinity) {
      patched.allowed = true;
      patched.warning = null;
    }
    return patched;
  }

  function showUsageBlocked(result, feature) {
    result = applyDevTierToResult(result);
    var msg;
    if (result.reason === 'trial_expired') {
      msg = 'Your free trial has ended. Subscribe to keep using paid tools.';
      // Mark trial expired so next popup open shows free buttons + "Upgrade to Pro"
      chrome.storage.local.set({ trialStatus: { active: false, timestamp: Date.now() } });
    } else if (result.limit === Infinity || result.limit === null) {
      msg = 'You\'ve used ' + (result.used || 0) + ' uses (unlimited).';
    } else {
      msg = 'You\'ve used all ' + result.limit + ' uses';
      if (result.tier === 'free') msg += ' (lifetime).';
      else msg += ' this month.';
    }
    usageBlockedMsg.textContent = msg;

    if (result.upgradeUrl) {
      usageUpgradeBtn.href = result.upgradeUrl;
      usageUpgradeBtn.style.display = 'block';
    } else {
      usageUpgradeBtn.style.display = 'none';
    }
    // Show "Continue with Free" option when trial expired
    usageBlockedFreeBtn.style.display = result.reason === 'trial_expired' ? 'block' : 'none';
    usageBlockedOverlay.classList.add('visible');

    trackEvent('usage_blocked', {
      tier: result.tier,
      limit: result.limit,
      used: result.used,
      feature: feature || 'unknown',
    });
  }

  // Usage warnings/trial banners — kept as no-ops; limits not surfaced to users
  function showUsageWarning() {}
  function showTrialStarted() {}

  // ── Port My Chat Pro elements ──────────────────────────────────────────
  const proChatBtn = document.getElementById('proChatBtn');
  const freeButtonsDiv = document.getElementById('free-buttons');
  const paidButtonsDiv = document.getElementById('paid-buttons');
  const upgradeBtn = document.getElementById('upgradeBtn');
  const secondOpinionBtn = document.getElementById('secondOpinionBtn');
  const portInstructionsBtnFree = document.getElementById('portInstructionsBtnFree');
  const includeImagesLabel = document.getElementById('includeImagesLabel');
  const proBackBtn = document.getElementById('proBackBtn');
  const proAssetTableBody = document.getElementById('proAssetTableBody');
  const proConfirmBtn = document.getElementById('proConfirmBtn');
  const proError = document.getElementById('proError');
  const proStatus = document.getElementById('proStatus');

  // ── Profile screen elements ──────────────────────────────────────────────
  const profilePickerBackBtn = document.getElementById('profilePickerBackBtn');
  const profileList = document.getElementById('profileList');
  const profileNewBtn = document.getElementById('profileNewBtn');
  const profileNewBlocked = document.getElementById('profileNewBlocked');
  const profilePickerStatus = document.getElementById('profilePickerStatus');

  const profileTypeBackBtn = document.getElementById('profileTypeBackBtn');

  const profileQuestionnaire = document.getElementById('profileQuestionnaire');
  const pqPage1BackBtn = document.getElementById('pqPage1BackBtn');
  const pqPage1NextBtn_profile = document.getElementById('pqPage1NextBtn');
  const pqPage2BackBtn = document.getElementById('pqPage2BackBtn');
  const pqPage2NextBtn = document.getElementById('pqPage2NextBtn');

  const profileCustomizeBackBtn = document.getElementById('profileCustomizeBackBtn');
  const profilePreviewBadge = document.getElementById('profilePreviewBadge');
  const profileNameInput = document.getElementById('profileNameInput');
  const profileIconGrid = document.getElementById('profileIconGrid');
  const profileColourRow = document.getElementById('profileColourRow');
  const profileSaveBtn = document.getElementById('profileSaveBtn');
  const profileCustomizeStatus = document.getElementById('profileCustomizeStatus');

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
  let _pmcProExtractPromise = null; // background extraction promise for PMC Pro
  let _pmcProTab = null; // tab info for PMC Pro flow
  let _imageConfirmResolve = null; // pending promise resolve for image selection

  // ── User tier state ───────────────────────────────────────────────────
  let _userTier = 'free'; // 'free', 'paid', 'paid2', or 'paid3'
  let _devTierOverride = null; // set from devTierOverride storage key
  async function checkUserTier() {
    var result = await new Promise(function (resolve) {
      chrome.storage.local.get(['devTierOverride', 'userTier'], function (data) { resolve(data); });
    });

    // devTierOverride (separate key) always wins
    if (result.devTierOverride) {
      _devTierOverride = result.devTierOverride;
      _userTier = result.devTierOverride;
    } else if (result.userTier && result.userTier.tier) {
      _userTier = result.userTier.tier;
    }
    // else _userTier stays 'free' (the default)
    applyTierUI();

    // Background refresh from Firestore so tier updates after upgrade/downgrade.
    // Use cached tokens directly to avoid ensureAuthenticated() triggering an
    // interactive auth popup that would close this popup before the fetch completes.
    if (!result.devTierOverride) {
      try {
        var authCache = await new Promise(function (resolve) {
          chrome.storage.local.get(['firebase_id_token', 'firebase_uid', 'firebase_token_expiry'], function (d) { resolve(d); });
        });
        if (authCache.firebase_id_token && authCache.firebase_uid) {
          console.log('[Popup] Tier refresh: using cached token for uid=' + authCache.firebase_uid);
          var freshTier = await getUserTier(authCache.firebase_id_token, authCache.firebase_uid);
          console.log('[Popup] Firestore tier: cached=' + _userTier + ' fresh=' + freshTier);
          if (freshTier !== _userTier) {
            console.log('[Popup] Tier changed:', _userTier, '→', freshTier);
            _userTier = freshTier;
            chrome.storage.local.set({ userTier: { tier: freshTier, timestamp: Date.now() } });
          }
          applyTierUI();
        } else {
          console.log('[Popup] No cached Firebase token — skipping tier refresh');
        }
      } catch (e) {
        console.log('[Popup] Tier refresh failed (keeping cached tier ' + _userTier + '):', e.message || e);
      }
    } else {
      console.log('[Popup] Skipping Firestore tier check — devTierOverride active:', result.devTierOverride);
    }
  }

  function refreshTierSilently(auth) {
    // Check for dev tier override (separate key) — if set, don't fetch from Firestore
    chrome.storage.local.get('devTierOverride', function (result) {
      if (result.devTierOverride) {
        _userTier = result.devTierOverride;
        applyTierUI();
        return;
      }
      getUserTier(auth.idToken, auth.firebaseUid).then(function (tier) {
        _userTier = tier;
        chrome.storage.local.set({ userTier: { tier: tier, timestamp: Date.now() } });
        applyTierUI();
      }).catch(function () {});
    });
  }

  function applyTierUI() {
    console.log('[Popup] User tier:', _userTier);

    if (_userTier === 'paid' || _userTier === 'paid2' || _userTier === 'paid3') {
      // State 3/4: Pro or Premium — show paid buttons, hide free + upgrade
      if (freeButtonsDiv) freeButtonsDiv.style.display = 'none';
      if (paidButtonsDiv) paidButtonsDiv.style.display = '';
    } else {
      // State 2: Free — show free buttons + Upgrade, hide paid buttons
      if (freeButtonsDiv) freeButtonsDiv.style.display = '';
      if (paidButtonsDiv) paidButtonsDiv.style.display = 'none';
      upgradeBtn.textContent = 'Upgrade';
      upgradeBtn.dataset.mode = 'upgrade';
    }
  }

  // Check tier on popup load
  checkUserTier();

  // ── Port mode state ────────────────────────────────────────────────────
  let _portMode = 'chat'; // 'chat', 'instructions', 'pro_brief', or 'pmc_pro'
  let _decryptedInstructions = null;

  // ── Pending auth for recordUse after successful port ─────────────────
  let _pendingAuth = null;
  let _pendingFeature = null;

  // ── PMC Pro settings persistence ──────────────────────────────────────
  var PMC_SETTINGS_KEY = 'portility_pmc_pro_settings';

  function savePmcSettings() {
    var settings = {
      includeProfile: includeProfileCheckbox.checked,
      selectedProfileId: profileSelect.value || null,
    };
    chrome.storage.local.set({ [PMC_SETTINGS_KEY]: settings });
  }

  function restorePmcSettings() {
    chrome.storage.local.get(PMC_SETTINGS_KEY, function (data) {
      var s = data[PMC_SETTINGS_KEY];
      if (!s) return;
      includeProfileCheckbox.checked = s.includeProfile !== false;
      profileSelect.disabled = !includeProfileCheckbox.checked;
      // selectedProfileId is applied when dropdown is populated
    });
  }

  // Persist on change
  includeProfileCheckbox.addEventListener('change', function () {
    profileSelect.disabled = !includeProfileCheckbox.checked;
    savePmcSettings();
  });
  profileSelect.addEventListener('change', savePmcSettings);

  /**
   * Populate the profile dropdown with user's profiles.
   * Selects the saved profile or falls back to default/first.
   */
  function populateProfileDropdown(profiles) {
    profileSelect.innerHTML = '';
    if (!profiles || profiles.length === 0) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No profiles';
      profileSelect.appendChild(opt);
      profileSelect.disabled = true;
      return;
    }
    for (var i = 0; i < profiles.length; i++) {
      var p = profiles[i];
      opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name || (p.type + ' profile');
      profileSelect.appendChild(opt);
    }
    // Apply saved selection or default
    chrome.storage.local.get(PMC_SETTINGS_KEY, function (data) {
      var s = data[PMC_SETTINGS_KEY];
      var savedId = s && s.selectedProfileId;
      var hasMatch = savedId && profiles.some(function (p) { return p.id === savedId; });
      if (hasMatch) {
        profileSelect.value = savedId;
      } else {
        var defaultProfile = profiles.find(function (p) { return p.isDefault; }) || profiles[0];
        profileSelect.value = defaultProfile.id;
      }
    });
    profileSelect.disabled = !includeProfileCheckbox.checked;
  }

  // Restore settings on popup load
  restorePmcSettings();

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

  // ── Profile state ──────────────────────────────────────────────────────
  let _cachedProfiles = null;
  let _editingProfile = null;
  let _selectedProfileType = null;
  let _profileAnswers = {};
  let _selectedIcon = null;
  let _selectedColourIndex = 0;
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
      chrome.storage.local.get('questionnaire_answers', async function (data) {
        if (data.questionnaire_answers) {
          qAnswers = Object.assign({}, qAnswers, data.questionnaire_answers);
          prefillAnswers();
          showQScreen('q-page1');
        } else {
          // Fallback: try Firestore for answers saved on another device
          try {
            var auth = await ensureAuthenticated();
            var fsData = await getInstructionsFromFirestore(auth.idToken, auth.firebaseUid);
            if (fsData && fsData.answers) {
              qAnswers = Object.assign({}, qAnswers, fsData.answers);
              chrome.storage.local.set({ questionnaire_answers: fsData.answers });
              prefillAnswers();
            }
          } catch (e) {
            console.log('[Questionnaire] Firestore fallback failed:', e);
          }
          showQScreen('q-page1');
        }
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
          if (rangeEl && qAnswers[sec.key] != null) {
            rangeEl.value = qAnswers[sec.key];
            rangeEl.dispatchEvent(new Event('input', { bubbles: true }));
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
      crumb('quest_auth');
      var auth = await ensureAuthenticated();
      refreshTierSilently(auth);
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

    try {
      setPortStatus('Loading\u2026');
      portInstructionsBtn.disabled = true;

      // Authenticate
      var auth = await ensureAuthenticated();
      refreshTierSilently(auth);

      // Usage gating — authorize (no increment yet)
      var usageResult = applyDevTierToResult(await authorizeFeature(auth.idToken, auth.firebaseUid, 'port_me_pro'));
      if (!usageResult.allowed) {
        portInstructionsBtn.disabled = false;
        setPortStatus('');
        showUsageBlocked(usageResult, 'port_me_pro');
        return;
      }
      if (usageResult.warning) showUsageWarning(usageResult.warning);
      if (usageResult.trial && usageResult.trial.just_started) showTrialStarted();
      _pendingAuth = auth;
      _pendingFeature = 'port_me_pro';

      // Migrate legacy profile if needed
      crumb('instr_migrate');
      await migrateLegacyProfile(auth.userId, auth.idToken, auth.firebaseUid);

      // List profiles
      crumb('instr_list');
      var profiles = await listProfilesFromFirestore(auth.userId, auth.idToken, auth.firebaseUid);
      _cachedProfiles = profiles;

      setPortStatus('');
      portInstructionsBtn.disabled = false;

      if (profiles.length === 0) {
        // No profiles — go to type selection to create first one
        crumb('instr_no_profiles');
        showProfileScreen('profileTypeScreen');
      } else if (profiles.length === 1) {
        // Single profile — port directly
        crumb('instr_single_profile');
        trackEvent('portme_pro_profile_selected', { profileId: profiles[0].id, profileType: profiles[0].type });
        await portWithProfile(profiles[0], auth);
      } else {
        // Multiple profiles — show picker
        crumb('instr_picker');
        renderProfilePicker(profiles);
        showProfileScreen('profilePicker');
        trackEvent('portme_pro_picker_shown', { profileCount: profiles.length });
      }
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
    refreshTierSilently(auth);
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
   * Uses the default profile's answers to build instructions on-the-fly.
   * Falls back to legacy Firestore instructions.
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
      var auth = await ensureAuthenticated();
      // Try profiles first
      await migrateLegacyProfile(auth.userId, auth.idToken, auth.firebaseUid);
      var profiles = await listProfilesFromFirestore(auth.userId, auth.idToken, auth.firebaseUid);
      if (profiles.length > 0) {
        // Find default profile, or use first
        var defaultProfile = profiles.find(function (p) { return p.isDefault; }) || profiles[0];
        if (defaultProfile.answers) {
          return buildProfileInstructionPacket(defaultProfile);
        }
      }
      // Fallback to legacy instructions
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
  // PORT ME PRO — PROFILE SCREENS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Show a profile screen by ID and set the corresponding body class.
   */
  function showProfileScreen(id) {
    exitProfileScreens();
    var classMap = {
      profilePicker:        'profile-picker-active',
      profileTypeScreen:    'profile-type-active',
      profileQuestionnaire: 'profile-questionnaire-active',
      profileCustomize:     'profile-customize-active',
    };
    if (classMap[id]) {
      document.body.classList.add(classMap[id]);
    }
  }

  /**
   * Exit all profile screens by removing body classes.
   */
  function exitProfileScreens() {
    document.body.classList.remove(
      'profile-picker-active',
      'profile-type-active',
      'profile-questionnaire-active',
      'profile-customize-active'
    );
  }

  /**
   * Render the profile picker list.
   * @param {Array} profiles
   */
  function renderProfilePicker(profiles) {
    profileList.innerHTML = '';

    // Pre-select: last-used first (they're already sorted by lastUsed desc)
    var preselectedId = profiles.length > 0 ? profiles[0].id : null;

    for (var i = 0; i < profiles.length; i++) {
      var p = profiles[i];
      var item = document.createElement('div');
      item.className = 'profile-list-item' + (p.id === preselectedId ? ' selected' : '');
      item.setAttribute('data-profile-id', p.id);

      var badge = renderProfileBadge(p, 40);
      item.appendChild(badge);

      var info = document.createElement('div');
      info.className = 'profile-list-item-info';
      var nameEl = document.createElement('div');
      nameEl.className = 'profile-list-item-name';
      nameEl.textContent = p.name;
      info.appendChild(nameEl);
      var typeEl = document.createElement('div');
      typeEl.className = 'profile-list-item-type';
      typeEl.textContent = p.type;
      info.appendChild(typeEl);
      item.appendChild(info);

      if (p.isDefault) {
        var pill = document.createElement('span');
        pill.className = 'profile-default-pill';
        pill.textContent = 'Default';
        item.appendChild(pill);
      }

      // Click to port with this profile immediately
      (function (profile) {
        item.addEventListener('click', async function () {
          var items = profileList.querySelectorAll('.profile-list-item');
          for (var j = 0; j < items.length; j++) { items[j].classList.remove('selected'); }
          this.classList.add('selected');

          trackEvent('portme_pro_profile_selected', { profileId: profile.id, profileType: profile.type });
          try {
            var auth = await ensureAuthenticated();
            await portWithProfile(profile, auth);
          } catch (err) {
            profilePickerStatus.textContent = err.message || 'Something went wrong.';
            profilePickerStatus.className = 'profile-picker-status error';
          }
        });
      })(p);

      profileList.appendChild(item);
    }

    // Handle + New Profile button state
    var maxProfiles = getMaxProfiles(_userTier);
    if (profiles.length >= maxProfiles) {
      profileNewBtn.disabled = true;
      profileNewBlocked.style.display = 'block';
      profileNewBlocked.textContent = maxProfiles === Infinity ? 'Maximum profiles reached.' : 'Maximum ' + maxProfiles + ' profiles reached.';
    } else {
      profileNewBtn.disabled = false;
      profileNewBlocked.style.display = 'none';
    }

    profilePickerStatus.textContent = '';
  }

  /**
   * Create a profile badge DOM element.
   * @param {Object} profile - { icon, colourIndex }
   * @param {number} size - 40 or 72
   * @returns {HTMLElement}
   */
  function renderProfileBadge(profile, size) {
    var colour = PROFILE_COLOURS[profile.colourIndex] || PROFILE_COLOURS[0];
    var badge = document.createElement('div');
    badge.className = 'profile-badge' + (size === 72 ? ' large' : '');
    badge.style.background = colour.bg;
    badge.style.border = '1.5px solid ' + colour.swatch;

    if (profile.icon === 'portility') {
      var img = document.createElement('img');
      img.src = 'icons/logo-circle.png';
      img.alt = 'Portility';
      badge.appendChild(img);
    } else {
      var icon = document.createElement('i');
      icon.className = 'ti ' + profile.icon;
      icon.style.color = colour.icon;
      badge.appendChild(icon);
    }

    return badge;
  }

  /**
   * Port with a specific profile: build instructions on-the-fly, then show screen2.
   * @param {Object} profile
   * @param {Object} auth
   */
  async function portWithProfile(profile, auth) {
    _portMode = 'instructions';

    if (!profile.answers) {
      setPortStatus('Profile has no answers — please rebuild it.', true);
      return;
    }

    _decryptedInstructions = buildProfileInstructionPacket(profile);

    // Update lastUsed
    updateProfileLastUsed(profile.id, auth.idToken, auth.firebaseUid).catch(function () {});

    screen2Label.textContent = 'Port instructions to\u2026';
    setScreen2Status('');
    setAllDestBtnsDisabled(false);
    instructionsCheckboxLabel.style.display = 'none';
    includeProfileLabel.style.display = 'none';
    includeImagesLabel.style.display = 'none';
    exitProfileScreens();
    showScreen('screen2');
  }

  /**
   * Build a complete instruction packet from a profile's answers and type.
   * Reuses buildInstructionMap() + deconjugateVerb() from questionnaire.js.
   * @param {Object} profile - { type, answers }
   * @returns {string}
   */
  function buildProfileInstructionPacket(profile) {
    var type = profile.type || 'other';
    var answers = profile.answers || {};

    // Get type-specific header
    var header = (typeof PROFILE_PROMPTS !== 'undefined' && PROFILE_PROMPTS.headers && PROFILE_PROMPTS.headers[type])
      ? PROFILE_PROMPTS.headers[type]
      : (typeof PROFILE_PROMPTS !== 'undefined' && PROFILE_PROMPTS.defaultHeader)
        ? PROFILE_PROMPTS.defaultHeader
        : '# My Profile — Operating Instructions\n\n---\n\n';

    // Generate instructions from profile questionnaire config
    var config = PROFILE_QUESTIONNAIRE_CONFIG[type];
    if (!config) {
      return header + '(No profile instructions configured for type: ' + type + ')';
    }

    var instructions = [];
    var pages = config.pages;

    for (var p = 0; p < pages.length; p++) {
      var sections = pages[p].sections;
      for (var s = 0; s < sections.length; s++) {
        var section = sections[s];
        var key = section.key;
        var answer = answers[key];

        if (section.type === 'multi-select') {
          if (typeof answer === 'string' && answer) { answer = [answer]; }
          if (!Array.isArray(answer) || answer.length === 0) continue;

          var map = buildInstructionMap(section);
          var parts = [];
          for (var i = 0; i < answer.length; i++) {
            if ((answer[i] === 'other' || answer[i] === 'custom_text') && answers[key + '_customText']) {
              var raw = answers[key + '_customText'].trim();
              if (raw) {
                parts.push(deconjugateVerb(raw));
              }
            } else if (map[answer[i]]) {
              parts.push(map[answer[i]]);
            }
          }
          if (parts.length > 0) {
            instructions.push(parts.join(' '));
          }

        } else if (section.type === 'single-select-chips') {
          if (!answer) continue;
          var chipMap = buildInstructionMap(section);
          if (chipMap[answer]) {
            instructions.push(chipMap[answer]);
          }

        } else if (section.type === 'textarea') {
          if (answer && answer.trim()) {
            var prefix = section.instructionPrefix || '';
            instructions.push(prefix + answer.trim());
          }
        }
      }
    }

    // Also include answers from the general questionnaire (QUESTIONNAIRE_CONFIG)
    // if they exist in this profile's answers (e.g. migrated profiles)
    var generalInstructions = generateInstructions(answers);
    if (generalInstructions.trim()) {
      instructions.push(generalInstructions);
    }

    var body = instructions.join('\n\n');

    // Confirmation prompt
    var confirmationPrompt = (typeof PROFILE_PROMPTS !== 'undefined' && PROFILE_PROMPTS.confirmationPrompt)
      ? PROFILE_PROMPTS.confirmationPrompt
      : "When you first respond, confirm you've read these instructions. ";

    return header + body + '\n\n---\n\n' + confirmationPrompt;
  }

  /**
   * Initialize profile answers object from a PROFILE_QUESTIONNAIRE_CONFIG type.
   * @param {string} profileType
   * @returns {Object}
   */
  function initProfileAnswers(profileType) {
    var answers = {};
    var config = PROFILE_QUESTIONNAIRE_CONFIG[profileType];
    if (!config) return answers;

    var pages = config.pages;
    for (var p = 0; p < pages.length; p++) {
      var sections = pages[p].sections;
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];
        if (sec.type === 'multi-select') {
          answers[sec.key] = [];
          answers[sec.key + '_customText'] = '';
        } else if (sec.type === 'textarea') {
          answers[sec.key] = '';
        } else {
          answers[sec.key] = null;
        }
      }
    }
    return answers;
  }

  /**
   * Render profile-type-specific questions into #pq-page1-content / #pq-page2-content.
   * @param {string} profileType
   */
  function renderProfileQuestionnaire(profileType) {
    var config = PROFILE_QUESTIONNAIRE_CONFIG[profileType];
    if (!config) return;

    var pages = config.pages;
    for (var p = 0; p < pages.length; p++) {
      var page = pages[p];
      var container = document.getElementById(page.id + '-content');
      if (!container) continue;
      container.innerHTML = '';

      var sections = page.sections;
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];

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

            if (opt.customTextPlaceholder) {
              var otherArea = document.createElement('div');
              otherArea.className = 'q-other-area';
              otherArea.id = 'pq-other-area-' + sec.key;
              var ta = document.createElement('textarea');
              ta.className = 'q-textarea';
              ta.id = 'pq-other-text-' + sec.key;
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

        } else if (sec.type === 'textarea') {
          var textarea = document.createElement('textarea');
          textarea.className = 'q-textarea';
          textarea.id = 'pq-textarea-' + sec.key;
          textarea.placeholder = sec.placeholder || '';
          container.appendChild(textarea);
        }
      }
    }

    // Wire up handlers
    wireUpProfileOptionHandlers();
  }

  /**
   * Attach click handlers to profile questionnaire option buttons.
   */
  function wireUpProfileOptionHandlers() {
    var allQOptions = profileQuestionnaire.querySelectorAll('.q-option[data-question]');
    for (var i = 0; i < allQOptions.length; i++) {
      allQOptions[i].addEventListener('click', function () {
        var question = this.getAttribute('data-question');
        var value = this.getAttribute('data-value');
        var parentWrap = this.closest('[data-multiselect]');
        var isMultiSelect = !!parentWrap;

        if (isMultiSelect) {
          this.classList.toggle('selected');

          var arr = _profileAnswers[question];
          if (!Array.isArray(arr)) { arr = []; _profileAnswers[question] = arr; }
          var idx = arr.indexOf(value);
          if (idx >= 0) { arr.splice(idx, 1); } else { arr.push(value); }

          var otherArea = document.getElementById('pq-other-area-' + question);
          if (otherArea) {
            if (arr.indexOf('other') >= 0) {
              otherArea.classList.add('visible');
              var otherText = document.getElementById('pq-other-text-' + question);
              if (otherText) otherText.focus();
            } else {
              otherArea.classList.remove('visible');
              _profileAnswers[question + '_customText'] = '';
            }
          }
        } else {
          var siblings = this.parentElement.querySelectorAll('.q-option[data-question="' + question + '"]');
          for (var j = 0; j < siblings.length; j++) { siblings[j].classList.remove('selected'); }
          this.classList.add('selected');
          _profileAnswers[question] = value;
        }
      });
    }
  }

  /**
   * Render the icon grid + colour swatches on the customize screen.
   */
  function renderProfileCustomizeScreen() {
    // Icon grid
    profileIconGrid.innerHTML = '';
    for (var i = 0; i < PROFILE_ICONS.length; i++) {
      var iconId = PROFILE_ICONS[i];
      var cell = document.createElement('div');
      cell.className = 'profile-icon-cell' + (iconId === _selectedIcon ? ' selected' : '');
      cell.setAttribute('data-icon', iconId);

      if (iconId === 'portility') {
        var img = document.createElement('img');
        img.src = 'icons/logo-circle.png';
        img.alt = 'Portility';
        cell.appendChild(img);
      } else {
        var icon = document.createElement('i');
        icon.className = 'ti ' + iconId;
        cell.appendChild(icon);
      }

      (function (id) {
        cell.addEventListener('click', function () {
          var cells = profileIconGrid.querySelectorAll('.profile-icon-cell');
          for (var j = 0; j < cells.length; j++) { cells[j].classList.remove('selected'); }
          this.classList.add('selected');
          _selectedIcon = id;
          updatePreviewBadge();
        });
      })(iconId);

      profileIconGrid.appendChild(cell);
    }

    // Colour swatches
    profileColourRow.innerHTML = '';
    for (var c = 0; c < PROFILE_COLOURS.length; c++) {
      var colour = PROFILE_COLOURS[c];
      var swatch = document.createElement('div');
      swatch.className = 'profile-colour-swatch' + (c === _selectedColourIndex ? ' selected' : '');
      swatch.style.background = colour.swatch;
      swatch.style.color = colour.swatch;
      swatch.setAttribute('data-colour-index', c);

      (function (idx) {
        swatch.addEventListener('click', function () {
          var swatches = profileColourRow.querySelectorAll('.profile-colour-swatch');
          for (var j = 0; j < swatches.length; j++) { swatches[j].classList.remove('selected'); }
          this.classList.add('selected');
          _selectedColourIndex = idx;
          updatePreviewBadge();
        });
      })(c);

      profileColourRow.appendChild(swatch);
    }

    // Set name input
    if (_editingProfile) {
      profileNameInput.value = _editingProfile.name;
    } else {
      var typeName = _selectedProfileType.charAt(0).toUpperCase() + _selectedProfileType.slice(1);
      profileNameInput.value = typeName + ' Profile';
    }

    updatePreviewBadge();
  }

  /**
   * Update the 72px preview badge from current icon + colour selections.
   */
  function updatePreviewBadge() {
    var colour = PROFILE_COLOURS[_selectedColourIndex] || PROFILE_COLOURS[0];
    profilePreviewBadge.innerHTML = '';
    profilePreviewBadge.style.background = colour.bg;
    profilePreviewBadge.style.border = '1.5px solid ' + colour.swatch;

    if (_selectedIcon === 'portility') {
      var img = document.createElement('img');
      img.src = 'icons/logo-circle.png';
      img.alt = 'Portility';
      profilePreviewBadge.appendChild(img);
    } else {
      var icon = document.createElement('i');
      icon.className = 'ti ' + _selectedIcon;
      icon.style.color = colour.icon;
      profilePreviewBadge.appendChild(icon);
    }
  }

  function showPQScreen(screenId) {
    var screens = profileQuestionnaire.querySelectorAll('.pq-screen');
    for (var i = 0; i < screens.length; i++) {
      screens[i].classList.remove('active');
    }
    var target = document.getElementById(screenId);
    if (target) target.classList.add('active');
  }

  // ── Profile event handlers ─────────────────────────────────────────────────

  // Back buttons
  profilePickerBackBtn.addEventListener('click', function () {
    exitProfileScreens();
    showScreen('screen1');
  });

  profileTypeBackBtn.addEventListener('click', function () {
    if (_cachedProfiles && _cachedProfiles.length > 0) {
      renderProfilePicker(_cachedProfiles);
      showProfileScreen('profilePicker');
    } else {
      exitProfileScreens();
      showScreen('screen1');
    }
  });

  pqPage1BackBtn.addEventListener('click', function () {
    showProfileScreen('profileTypeScreen');
  });

  pqPage2BackBtn.addEventListener('click', function () {
    showProfileScreen('profileQuestionnaire');
    showPQScreen('pq-page1');
  });

  profileCustomizeBackBtn.addEventListener('click', function () {
    showProfileScreen('profileQuestionnaire');
    showPQScreen('pq-page2');
  });

  // Type card click
  var typeCards = document.querySelectorAll('.profile-type-card');
  for (var tc = 0; tc < typeCards.length; tc++) {
    typeCards[tc].addEventListener('click', function () {
      var type = this.getAttribute('data-profile-type');
      _selectedProfileType = type;
      _editingProfile = null;
      _profileAnswers = initProfileAnswers(type);

      var defaults = PROFILE_TYPE_DEFAULTS[type] || PROFILE_TYPE_DEFAULTS.other;
      _selectedIcon = defaults.icon;
      _selectedColourIndex = defaults.colourIndex;

      crumb('profile_type_selected', { type: type });
      trackEvent('portme_pro_type_selected', { type: type });

      renderProfileQuestionnaire(type);
      showProfileScreen('profileQuestionnaire');
      showPQScreen('pq-page1');
    });
  }

  // Profile questionnaire page 1 Next
  pqPage1NextBtn_profile.addEventListener('click', function () {
    var config = PROFILE_QUESTIONNAIRE_CONFIG[_selectedProfileType];
    if (!config) return;

    var page1 = config.pages[0];
    if (!page1) return;

    // Validate: first multi-select must have at least one selection
    for (var s = 0; s < page1.sections.length; s++) {
      var sec = page1.sections[s];
      if (sec.type === 'multi-select') {
        if (!Array.isArray(_profileAnswers[sec.key]) || _profileAnswers[sec.key].length === 0) {
          return; // don't advance — need at least one selection
        }
        if (Array.isArray(_profileAnswers[sec.key]) && _profileAnswers[sec.key].indexOf('other') >= 0) {
          var otherText = document.getElementById('pq-other-text-' + sec.key);
          if (otherText) {
            var val = otherText.value.trim();
            if (!val) { otherText.focus(); return; }
            _profileAnswers[sec.key + '_customText'] = val;
          }
        }
        break; // only validate first multi-select
      }
    }

    crumb('profile_quest_page1_done');
    showPQScreen('pq-page2');
  });

  // Profile questionnaire page 2 Next → go to customize
  pqPage2NextBtn.addEventListener('click', function () {
    var config = PROFILE_QUESTIONNAIRE_CONFIG[_selectedProfileType];
    if (!config) return;

    // Capture textarea answers
    var page2 = config.pages[1];
    if (page2) {
      for (var s = 0; s < page2.sections.length; s++) {
        var sec = page2.sections[s];
        if (sec.type === 'textarea') {
          var ta = document.getElementById('pq-textarea-' + sec.key);
          if (ta) _profileAnswers[sec.key] = ta.value.trim();
        }
      }
    }

    crumb('profile_quest_page2_done');
    renderProfileCustomizeScreen();
    showProfileScreen('profileCustomize');
  });

  // Profile build button removed — profile click now advances directly to destination picker.

  // "+ New Profile" button in picker
  profileNewBtn.addEventListener('click', function () {
    if (_cachedProfiles && _cachedProfiles.length >= getMaxProfiles(_userTier)) {
      trackEvent('portme_pro_new_profile_blocked', { profileCount: _cachedProfiles.length });
      return;
    }
    crumb('profile_new');
    showProfileScreen('profileTypeScreen');
  });

  // Save & Port button on customize screen
  profileSaveBtn.addEventListener('click', async function () {
    var name = profileNameInput.value.trim();
    if (!name) {
      profileCustomizeStatus.textContent = 'Please enter a name.';
      profileCustomizeStatus.className = 'profile-customize-status error';
      return;
    }
    if (name.length > MAX_PROFILE_NAME_LENGTH) {
      profileCustomizeStatus.textContent = 'Name is too long (max ' + MAX_PROFILE_NAME_LENGTH + ' chars).';
      profileCustomizeStatus.className = 'profile-customize-status error';
      return;
    }

    profileSaveBtn.disabled = true;
    profileSaveBtn.textContent = 'Saving\u2026';
    profileCustomizeStatus.textContent = '';

    try {
      var auth = await ensureAuthenticated();
      var now = new Date().toISOString();
      var isFirst = !_cachedProfiles || _cachedProfiles.length === 0;

      var profile = {
        id: _editingProfile ? _editingProfile.id : generateProfileId(),
        name: name,
        type: _selectedProfileType,
        icon: _selectedIcon,
        colourIndex: _selectedColourIndex,
        answers: _profileAnswers,
        isDefault: isFirst || (_editingProfile ? _editingProfile.isDefault : false),
        lastUsed: now,
        createdAt: _editingProfile ? _editingProfile.createdAt : now,
      };

      await saveProfileToFirestore(profile, auth.userId, auth.idToken, auth.firebaseUid);

      crumb('profile_saved', { profileId: profile.id, type: profile.type });
      trackEvent('portme_pro_profile_created', { profileId: profile.id, type: profile.type, icon: profile.icon, colourIndex: profile.colourIndex });

      // Mark questionnaire as completed (for tryGetInstructions compatibility)
      await new Promise(function (resolve) {
        chrome.storage.local.set({ questionnaire_completed: true }, resolve);
      });

      // Port with the new profile
      await portWithProfile(profile, auth);
    } catch (err) {
      crumb('profile_save_failed', { error: (err.message || '').substring(0, 200) });
      profileCustomizeStatus.textContent = err.message || 'Failed to save. Try again.';
      profileCustomizeStatus.className = 'profile-customize-status error';
    } finally {
      profileSaveBtn.disabled = false;
      profileSaveBtn.textContent = 'Save & Port';
    }
  });


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
    // placeholder for future cleanup
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
    // Also exit any profile screen
    exitProfileScreens();
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
  var _isSupportedPage = false;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.url) {
      setStatus('This website is not supported. Try porting from an AI chat.');
      return;
    }

    const url = tab.url;
    _isSupportedPage = /claude\.ai/i.test(url) || /chatgpt\.com/i.test(url) || /gemini\.google\.com/i.test(url);

    if (!_isSupportedPage) {
      setStatus('This website is not supported. Try porting from an AI chat.');
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
  copyBtn.addEventListener('click', async () => {
    if (!_isSupportedPage) {
      setStatus('This website is not supported. Try porting from an AI chat.', true);
      return;
    }
    crumb('port_chat_start');
    try {
      var auth = await ensureAuthenticated();
      refreshTierSilently(auth);
    } catch (e) {
      setStatus('Please sign in to continue.', true);
      return;
    }
    _portMode = 'chat';
    screen2Label.textContent = 'Port conversation to\u2026';
    setScreen2Status('');
    setAllDestBtnsDisabled(false);
    includeProfileLabel.style.display = 'none';
    includeImagesLabel.style.display = 'none';

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
    _pmcProExtractPromise = null;
    _pmcProTab = null;
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
          // Store text for auto-paste + auto-submit on destination tab
          await new Promise(function (resolve) {
            chrome.storage.local.set({ portility_pending_paste: _decryptedInstructions }, resolve);
          });
          chrome.tabs.create({ url: DESTINATION_URLS[destination] });
          setScreen2Status('Instructions copied \u2014 paste them in the new tab!');
          crumb('instr_ported', { dest: destination });
          trackEvent('operating_instructions_ported', { destination: destination });
        }
        // Record successful use (fire-and-forget)
        if (_pendingAuth && _pendingFeature) {
          recordUse(_pendingAuth.idToken, _pendingAuth.firebaseUid, _pendingFeature);
          _pendingAuth = null; _pendingFeature = null;
        }
      } catch (err) {
        crumb('instr_failed', { error: (err.message || '').substring(0, 200) });
        setScreen2Status(err.message || 'Something went wrong.', true);
        setAllDestBtnsDisabled(false);
      }
      return;
    }

    // ── PMC Pro mode: extract (background) → optionally summarize → port ──
    if (_portMode === 'pmc_pro') {
      var pmcTextModeData = await new Promise(function (resolve) {
        chrome.storage.local.get('portility_pmc_text_mode', function (d) { resolve(d); });
      });
      var pmcTextMode = pmcTextModeData.portility_pmc_text_mode || 'full';
      crumb('pmc_pro_dest', { dest: destination, textMode: pmcTextMode });
      try {
        if (!_pmcProExtractPromise) {
          throw new Error('No extraction in progress.');
        }

        // Wait for background extraction to complete
        setScreen2Status('Extracting conversation\u2026');
        var extractResponse = await _pmcProExtractPromise;
        crumb('pro_extracted', { messageCount: extractResponse.messageCount, assetCount: (extractResponse.assets || []).length });

        // Moderation check
        setScreen2Status('Checking content\u2026');
        var moderationResult = await checkModeration(extractResponse.text);
        crumb('pro_moderated', { flagged: moderationResult.flagged });
        if (moderationResult.flagged) {
          trackEvent('portility_moderation_flagged', { source: 'pmc_pro', platform: _pmcProTab.sourcePlatform });
          showModerationModal();
          _pmcProExtractPromise = null;
          _pmcProTab = null;
          return;
        }

        var portContent = extractResponse.text;

        // Read captured images from chrome.storage.local (stored by content script)
        var images = [];
        var capturedImageCount = extractResponse.capturedImageCount || 0;
        if (capturedImageCount > 0) {
          var imgData = await new Promise(function (resolve) {
            chrome.storage.local.get('portility_captured_images', function (d) { resolve(d); });
          });
          var allCapturedImages = imgData.portility_captured_images || [];

          // Full-text mode: show captured images for selection (no AI reasons)
          if (pmcTextMode !== 'summary' && allCapturedImages.length > 0) {
            setScreen2Status('Select files to include\u2026');
            var fullTextSelected = await showImageSelection(allCapturedImages, null);
            images = fullTextSelected.map(function(i) { return allCapturedImages[i]; });
          }
        }

        // Include profile instructions if checkbox is checked
        var includeProfile = includeProfileCheckbox.checked;
        var profileInstructions = null;
        if (includeProfile) {
          try {
            var selectedProfileId = profileSelect.value;
            var profiles = _cachedProfiles || [];
            var selectedProfile = profiles.find(function (p) { return p.id === selectedProfileId; });
            if (selectedProfile && selectedProfile.answers) {
              profileInstructions = buildProfileInstructionPacket(selectedProfile);
            } else if (profiles.length > 0) {
              // Fallback to default or first
              var fallback = profiles.find(function (p) { return p.isDefault; }) || profiles[0];
              if (fallback.answers) {
                profileInstructions = buildProfileInstructionPacket(fallback);
              }
            }
            if (!profileInstructions) {
              profileInstructions = await fetchAndDecryptInstructions();
            }
          } catch (e) {
            // Profile fetch failed — continue without it
            crumb('pmc_pro_profile_failed', { error: (e.message || '').substring(0, 100) });
          }
        }
        crumb('pmc_pro_profile', { included: !!profileInstructions });

        // If "Port Summary" selected, summarize via API
        if (pmcTextMode === 'summary') {
          setScreen2Status('Summarizing\u2026');
          crumb('pro_summarize');
          var proxyBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL !== 'YOUR_WORKER_URL') ? PROXY_URL : '';
          if (!proxyBase) throw new Error('Proxy URL not configured.');

          var phDistinctId = await getDistinctId();
          // Strip dataUrl from assets before sending to API (too large for request body)
          var assetsForApi = (extractResponse.assets || []).map(function (a) {
            var copy = { type: a.type, url: a.url, alt: a.alt, filename: a.filename, role: a.role, turnIndex: a.turnIndex };
            if (a.thumbnailUrl && !a.thumbnailUrl.startsWith('data:')) copy.thumbnailUrl = a.thumbnailUrl;
            return copy;
          });
          var summaryResp = await fetch(proxyBase + '/summarize-pro', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Portility-Distinct-Id': phDistinctId },
            body: JSON.stringify({
              conversation: extractResponse.text,
              assets: assetsForApi,
            }),
          });
          if (!summaryResp.ok) throw new Error('AI analysis failed (HTTP ' + summaryResp.status + ')');
          var summaryData = await summaryResp.json();
          trackTokenUsage('summarize-pro', summaryData._usage);
          crumb('pro_summarized', { hasContent: !!(summaryData.content && summaryData.content.length) });

          var contentText = '';
          if (summaryData.content && summaryData.content.length > 0) {
            contentText = summaryData.content[0].text || '';
          }

          // Parse structured response
          var parsed;
          try {
            var jsonStr = contentText;
            var codeBlockMatch = contentText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
            if (codeBlockMatch) jsonStr = codeBlockMatch[1];
            parsed = JSON.parse(jsonStr);
          } catch (e) {
            parsed = { title: 'Project Brief', brief: contentText, assets: [] };
          }

          var mergedAssets = mergeAssets(extractResponse.assets || [], parsed.assets || []);
          _proData = {
            title: parsed.title || 'Project Brief',
            brief: parsed.brief || contentText,
            assets: mergedAssets,
            rawConversation: extractResponse.text,
            sourcePlatform: _pmcProTab.sourcePlatform,
            sourceUrl: _pmcProTab.url,
          };

          // Save to IndexedDB
          await saveProjectBrief({
            title: _proData.title,
            brief: _proData.brief,
            assets: _proData.assets,
            sourcePlatform: _proData.sourcePlatform,
            sourceUrl: _proData.sourceUrl,
            rawConversation: _proData.rawConversation,
          });
          chrome.storage.local.set({ lastProBrief: { brief: _proData.brief, timestamp: Date.now() } });

          portContent = buildDownloadContent(_proData, false);

          // Summary mode: show captured images for selection, enriched with AI reasons
          if (capturedImageCount > 0 && allCapturedImages && allCapturedImages.length > 0) {
            var imageAssets = mergedAssets.filter(function(a) { return a.type === 'image' || a.type === 'file'; });
            setScreen2Status('Select files to include\u2026');
            var summarySelected = await showImageSelection(allCapturedImages, imageAssets);
            images = summarySelected.map(function(i) { return allCapturedImages[i]; });
          }
        }

        // Prepend profile instructions if available
        if (profileInstructions) {
          portContent = profileInstructions + '\n\n---\n\n' + portContent;
        }

        // Port the content
        setScreen2Status(destination === 'save' ? 'Saving file\u2026' : 'Opening destination\u2026');
        if (destination === 'save') {
          blob = new Blob([portContent], { type: pmcTextMode === 'summary' ? 'text/markdown' : 'text/plain' });
          blobUrl = URL.createObjectURL(blob);
          chrome.downloads.download({
            url: blobUrl,
            filename: pmcTextMode === 'summary'
              ? 'portility-pro-brief-' + ({ claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }[_pmcProTab && _pmcProTab.sourcePlatform] || '') + '-' + new Date().toISOString().slice(0, 10) + '.md'
              : safeChatFilename((_pmcProTab && _pmcProTab.title) || '', _pmcProTab && _pmcProTab.sourcePlatform) + '.txt',
            saveAs: true,
          }, function () {
            URL.revokeObjectURL(blobUrl);
          });
          setScreen2Status('Conversation saved!');
          crumb('pmc_pro_ported', { dest: 'save', textMode: pmcTextMode });
          trackEvent('pmc_pro_ported', { destination: 'file', text_mode: pmcTextMode });
        } else {
          await writeClipboard(portContent);
          var storagePayload = { portility_pending_paste: portContent };
          if (images.length > 0) {
            storagePayload.portility_pending_images = images;
          }
          console.log('[Portility][Popup] Storing for paste:', {
            textLen: portContent.length,
            imageCount: images.length,
            images: images.map(function (img) {
              return { type: img.type, filename: img.filename, hasDataUrl: !!img.dataUrl, dataUrlLen: img.dataUrl ? img.dataUrl.length : 0 };
            }),
          });
          await new Promise(function (resolve, reject) {
            chrome.storage.local.set(storagePayload, function () {
              if (chrome.runtime.lastError) {
                console.error('[Portility] Storage write failed:', chrome.runtime.lastError.message);
                reject(new Error('Failed to store images for porting: ' + chrome.runtime.lastError.message));
              } else {
                resolve();
              }
            });
          });
          chrome.storage.local.remove('portility_captured_images');
          chrome.tabs.create({ url: DESTINATION_URLS[destination] });
          var statusMsg = images.length > 0
            ? 'Brief + ' + images.length + ' file(s) porting!'
            : 'Conversation copied \u2014 paste it in the new tab!';
          setScreen2Status(statusMsg);
          crumb('pmc_pro_ported', { dest: destination, textMode: pmcTextMode });
          trackEvent('pmc_pro_ported', { destination: destination, text_mode: pmcTextMode, imageCount: images.length });
        }

        _pmcProExtractPromise = null;
        _pmcProTab = null;
        _proData = null;
        // Record successful use (fire-and-forget)
        if (_pendingAuth && _pendingFeature) {
          recordUse(_pendingAuth.idToken, _pendingAuth.firebaseUid, _pendingFeature);
          _pendingAuth = null; _pendingFeature = null;
        }
      } catch (err) {
        crumb('pmc_pro_failed', { error: (err.message || '').substring(0, 200) });
        setScreen2Status(err.message || 'Something went wrong.', true);
        setAllDestBtnsDisabled(false);
        _pmcProExtractPromise = null;
        _pmcProTab = null;
      }
      return;
    }

    // ── Pro brief mode: port the project brief ──
    if (_portMode === 'pro_brief') {
      crumb('pro_brief_dest', { dest: destination });
      try {
        if (!_proData) {
          throw new Error('No project brief available.');
        }

        if (destination === 'save') {
          // Embed images inline for the saved markdown file
          var saveContent = buildDownloadContent(_proData, true);
          var safeTitle = (_proData.title || 'brief').replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 50).trim();
          blob = new Blob([saveContent], { type: 'text/markdown' });
          blobUrl = URL.createObjectURL(blob);
          chrome.downloads.download({
            url: blobUrl,
            filename: 'portility-pro-' + (safeTitle || 'brief') + '-' + ({ claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }[_proData.sourcePlatform] || '') + '-' + new Date().toISOString().slice(0, 10) + '.md',
            saveAs: true,
          }, function () {
            URL.revokeObjectURL(blobUrl);
          });
          setScreen2Status('Project brief saved!');
          crumb('pro_brief_ported', { dest: 'save' });
          trackEvent('pro_brief_ported', { destination: 'file' });
        } else {
          // For AI destinations: text brief + auto-paste images via content script
          var clipContent = buildDownloadContent(_proData, false);
          var selectedImages = (_proData.assets || []).filter(function (a) {
            return a.selected && (a.type === 'image' || a.type === 'file') && a.dataUrl;
          });

          await writeClipboard(clipContent);

          // Store text for auto-paste
          storagePayload = { portility_pending_paste: clipContent };

          // Store image data for content script to paste as attachments
          if (selectedImages.length > 0) {
            storagePayload.portility_pending_images = selectedImages.map(function (a) {
              return { dataUrl: a.dataUrl, filename: a.filename || (a.type === 'file' ? 'file.bin' : 'image.jpg'), type: a.type || 'image' };
            });
          }
          console.log('[Pro] Storing for auto-paste:', {
            textLength: clipContent.length,
            imageCount: selectedImages.length,
            imagesHaveDataUrl: selectedImages.map(function (a) { return !!a.dataUrl; }),
          });

          await new Promise(function (resolve, reject) {
            chrome.storage.local.set(storagePayload, function () {
              if (chrome.runtime.lastError) {
                console.error('[Portility] Storage write failed:', chrome.runtime.lastError.message);
                reject(new Error('Failed to store images for porting: ' + chrome.runtime.lastError.message));
              } else {
                resolve();
              }
            });
          });

          chrome.tabs.create({ url: DESTINATION_URLS[destination] });
          statusMsg = selectedImages.length > 0
            ? 'Brief + ' + selectedImages.length + ' file(s) porting!'
            : 'Brief copied \u2014 paste it in the new tab!';
          setScreen2Status(statusMsg);
          crumb('pro_brief_ported', { dest: destination });
          trackEvent('pro_brief_ported', { destination: destination, imagesDownloaded: selectedImages.length });
        }

        _proData = null;
      } catch (err) {
        crumb('pro_brief_failed', { error: (err.message || '').substring(0, 200) });
        setScreen2Status(err.message || 'Something went wrong.', true);
        setAllDestBtnsDisabled(false);
      }
      return;
    }

    // ── Chat mode: extract from page ──
    crumb('port_chat_extract');
    setScreen2Status('Extracting conversation\u2026');

    try {
      const tabs = await new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, resolve);
      });
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) throw new Error('No active tab found.');

      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT', skipClipboard: true }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error('This website is not supported. Try porting from an AI chat.'));
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

      setScreen2Status(destination === 'save' ? 'Saving file\u2026' : 'Opening destination\u2026');
      if (destination === 'save') {
        const blob = new Blob([finalText], { type: 'text/plain' });
        const blobUrl = URL.createObjectURL(blob);

        chrome.downloads.download({
          url: blobUrl,
          filename: safeChatFilename(tab.title, /claude\.ai/i.test(tab.url) ? 'claude' : /chatgpt\.com/i.test(tab.url) ? 'chatgpt' : /gemini\.google\.com/i.test(tab.url) ? 'gemini' : '') + '.txt',
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

  function hideProReview() {
    document.body.classList.remove('pro-review-active');
  }

  // Check if two descriptions refer to the same asset via word overlap
  function assetDescriptionsMatch(a, b) {
    if (!a || !b) return false;
    // Strip punctuation, split into significant words (3+ chars)
    var wordsA = a.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function(w) { return w.length >= 3; });
    var wordsB = b.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function(w) { return w.length >= 3; });
    if (wordsA.length === 0 || wordsB.length === 0) return false;
    var setB = {};
    for (var i = 0; i < wordsB.length; i++) setB[wordsB[i]] = true;
    var overlap = 0;
    for (var j = 0; j < wordsA.length; j++) {
      if (setB[wordsA[j]]) overlap++;
    }
    var smaller = Math.min(wordsA.length, wordsB.length);
    return overlap >= Math.ceil(smaller * 0.5);
  }

  function mergeAssets(extractedAssets, sonnetAssets) {
    var merged = [];
    var matchedExtractedIndices = {};

    for (var i = 0; i < sonnetAssets.length; i++) {
      var sa = sonnetAssets[i];
      var matched = null;
      var matchedIdx = -1;
      var saDesc = sa.description || '';
      for (var j = 0; j < extractedAssets.length; j++) {
        if (matchedExtractedIndices[j]) continue;
        var ea = extractedAssets[j];
        // Match by word overlap against filename or alt text
        if (assetDescriptionsMatch(saDesc, ea.filename) || assetDescriptionsMatch(saDesc, ea.alt)) {
          matched = ea;
          matchedIdx = j;
          break;
        }
      }
      if (matchedIdx >= 0) matchedExtractedIndices[matchedIdx] = true;

      merged.push({
        id: sa.id || ('asset_' + i),
        type: sa.type || (matched ? matched.type : 'file'),
        description: sa.description || (matched ? matched.alt : ''),
        important: sa.important !== undefined ? sa.important : true,
        reason: sa.reason || '',
        url: matched ? matched.url : null,
        thumbnailUrl: matched ? matched.thumbnailUrl : null,
        dataUrl: matched ? matched.dataUrl : null,
        filename: matched ? matched.filename : (sa.description || 'asset_' + i),
        selected: sa.important !== false,
      });
    }

    // Add extracted assets not matched to Sonnet's list
    for (var k = 0; k < extractedAssets.length; k++) {
      if (matchedExtractedIndices[k]) continue;
      var ea2 = extractedAssets[k];
      if (ea2.url) {
        merged.push({
          id: 'extra_' + k,
          type: ea2.type,
          description: ea2.alt || ea2.filename || 'Detected asset',
          important: false,
          reason: 'Detected in conversation but not flagged by AI analysis',
          url: ea2.url,
          thumbnailUrl: ea2.thumbnailUrl,
          dataUrl: ea2.dataUrl || null,
          filename: ea2.filename,
          selected: false,
        });
      }
    }

    return merged;
  }

  /**
   * Show the proReview overlay with per-image checkboxes.
   * Driven by capturedImages (the actual portable images in storage).
   * Optional aiAssets are used to enrich rows with AI-provided reasons.
   * Returns a promise that resolves with an array of selected indices
   * into the capturedImages array.
   */
  // Minimum dataUrl length to consider an image "real" (filters favicons/logos).
  // A 32x32 icon at 0.7 JPEG quality is ~3-5KB base64 (~5000-7000 chars).
  // Real photos are 20KB+ (~27000+ chars).
  var MIN_IMAGE_DATA_LENGTH = 10000;

  function showImageSelection(capturedImages, aiAssets) {
    proAssetTableBody.innerHTML = '';

    // Filter out tiny images (favicons, logos, tiny thumbnails).
    // File-type assets skip the size filter — any non-empty dataUrl is valid.
    var realImages = capturedImages.filter(function(ci) {
      if (!ci.dataUrl) return false;
      if (ci.type === 'file') return true;
      return ci.dataUrl.length >= MIN_IMAGE_DATA_LENGTH;
    });

    if (realImages.length === 0) return Promise.resolve([]);

    // Build a map from original index to filtered index so we can
    // return indices into the original capturedImages array
    var originalIndices = [];
    for (var oi = 0; oi < capturedImages.length; oi++) {
      var ci = capturedImages[oi];
      if (!ci.dataUrl) continue;
      if (ci.type === 'file' || ci.dataUrl.length >= MIN_IMAGE_DATA_LENGTH) {
        originalIndices.push(oi);
      }
    }

    // Only match against AI-analyzed assets (exclude "extra" detected ones)
    var flaggedAssets = aiAssets ? aiAssets.filter(function(a) {
      return !a.id || !a.id.startsWith('extra_');
    }) : null;

    realImages.forEach(function(ci, i) {
      var tr = document.createElement('tr');

      // Try to find a matching AI-flagged asset for this captured image
      var aiMatch = null;
      if (flaggedAssets && flaggedAssets.length > 0) {
        var ciUrl = (ci.url || '').toLowerCase();
        var ciFile = (ci.filename || '').toLowerCase();
        for (var a = 0; a < flaggedAssets.length; a++) {
          var aUrl = (flaggedAssets[a].url || '').toLowerCase();
          var af = (flaggedAssets[a].filename || '').toLowerCase();
          var ad = (flaggedAssets[a].description || '').toLowerCase();
          if (ciUrl && aUrl && ciUrl === aUrl) {
            aiMatch = flaggedAssets[a];
            break;
          }
          if (ciFile && (af === ciFile || ad.indexOf(ciFile.replace(/\.[^.]+$/, '')) >= 0)) {
            aiMatch = flaggedAssets[a];
            break;
          }
          if (assetDescriptionsMatch(ciFile, ad) || assetDescriptionsMatch(ci.alt || '', ad)) {
            aiMatch = flaggedAssets[a];
            break;
          }
        }
      }

      // Pre-select if AI flagged it, or if no AI data available (full-text mode)
      var tdCheck = document.createElement('td');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = aiMatch ? true : !flaggedAssets || flaggedAssets.length === 0;
      cb.setAttribute('data-asset-index', String(originalIndices[i]));
      tdCheck.appendChild(cb);
      tr.appendChild(tdCheck);

      // Asset description cell with thumbnail or file icon
      var tdAsset = document.createElement('td');
      var isFile = ci.type === 'file';
      if (isFile) {
        var fileIcon = document.createElement('span');
        fileIcon.className = 'pro-asset-thumb pro-asset-file-icon';
        fileIcon.textContent = '\uD83D\uDCC4';
        tdAsset.appendChild(fileIcon);
        tdAsset.appendChild(document.createTextNode(' '));
      } else if (ci.dataUrl) {
        var img = document.createElement('img');
        img.src = ci.dataUrl;
        img.className = 'pro-asset-thumb';
        tdAsset.appendChild(img);
        tdAsset.appendChild(document.createTextNode(' '));
      }
      var label = isFile
        ? (ci.filename || (aiMatch && aiMatch.description) || ci.alt || 'File ' + (i + 1))
        : ((aiMatch && aiMatch.description) || ci.alt || ci.filename || 'Image ' + (i + 1));
      tdAsset.appendChild(document.createTextNode(label));
      tr.appendChild(tdAsset);

      // Type badge cell
      var tdType = document.createElement('td');
      var badge = document.createElement('span');
      var fileExt = isFile && ci.filename ? (ci.filename.match(/\.([^.]+)$/) || [])[1] : null;
      badge.className = 'pro-asset-type ' + (isFile ? 'file' : 'image');
      badge.textContent = isFile ? (fileExt || 'file') : 'image';
      tdType.appendChild(badge);
      tr.appendChild(tdType);

      // Reason cell
      var tdWhy = document.createElement('td');
      tdWhy.className = 'pro-asset-reason';
      tdWhy.textContent = (aiMatch && aiMatch.reason) || 'Detected in conversation';
      tr.appendChild(tdWhy);

      proAssetTableBody.appendChild(tr);
    });

    // Show the overlay
    document.getElementById('proLoading').style.display = 'none';
    document.getElementById('proContent').style.display = 'block';
    document.getElementById('proAssetsSection').style.display = 'block';
    document.getElementById('proNoAssets').style.display = 'none';
    proError.textContent = '';
    proStatus.textContent = '';
    proConfirmBtn.disabled = false;
    document.body.classList.add('pro-review-active');

    return new Promise(function(resolve) {
      _imageConfirmResolve = resolve;
    });
  }

  function buildDownloadContent(data, embedImages) {
    var md = '# ' + data.title + '\n\n';
    md += '*Generated by Portility Pro on ' + new Date().toLocaleDateString() + '*\n';
    md += '*Source: ' + data.sourcePlatform + '*\n\n';
    md += '---\n\n';
    md += data.brief + '\n\n';

    var selectedAssets = data.assets.filter(function (a) { return a.selected; });
    var imageAssets = selectedAssets.filter(function (a) { return a.type === 'image'; });
    var otherAssets = selectedAssets.filter(function (a) { return a.type !== 'image'; });

    // Embed captured images (for "save" destination)
    if (embedImages && imageAssets.length > 0) {
      md += '---\n\n';
      md += '## Images\n\n';
      for (var i = 0; i < imageAssets.length; i++) {
        var img = imageAssets[i];
        var desc = img.description || img.alt || img.filename || 'Image ' + (i + 1);
        var src = img.dataUrl || img.url || '';
        if (src) {
          md += '### ' + desc + '\n';
          md += '![' + desc + '](' + src + ')\n\n';
        }
      }
    }

    // Non-image asset manifest (files, artifacts)
    if (otherAssets.length > 0) {
      md += '---\n\n';
      md += '## Asset Manifest\n\n';
      md += '| Asset | Type | Description |\n';
      md += '|-------|------|-------------|\n';
      for (var j = 0; j < otherAssets.length; j++) {
        var a = otherAssets[j];
        md += '| ' + (a.filename || a.description || 'Asset ' + (j + 1)) +
              ' | ' + (a.type || '-') +
              ' | ' + (a.description || '-') + ' |\n';
      }
    }

    return md;
  }

  proChatBtn.addEventListener('click', async function () {
    if (!_isSupportedPage) {
      setStatus('This website is not supported. Try porting from an AI chat.', true);
      return;
    }
    proChatBtn.disabled = true;
    setStatus('');

    try {
      // Usage gating — authorize (no increment yet)
      var auth = await ensureAuthenticated();
      var usageResult = applyDevTierToResult(await authorizeFeature(auth.idToken, auth.firebaseUid, 'port_my_chat_pro'));
      if (!usageResult.allowed) {
        proChatBtn.disabled = false;
        setStatus('');
        showUsageBlocked(usageResult, 'port_my_chat_pro');
        return;
      }
      if (usageResult.warning) showUsageWarning(usageResult.warning);
      if (usageResult.trial && usageResult.trial.just_started) showTrialStarted();
      _pendingAuth = auth;
      _pendingFeature = 'port_my_chat_pro';

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

      _pmcProTab = { id: tab.id, url: tab.url, title: tab.title, sourcePlatform: sourcePlatform };

      // Step 2: Show destination picker immediately with toggle + profile checkbox
      _portMode = 'pmc_pro';
      screen2Label.textContent = 'Port conversation to\u2026';
      setScreen2Status('');
      setAllDestBtnsDisabled(false);
      instructionsCheckboxLabel.style.display = 'none';
      includeProfileLabel.style.display = 'flex';
      includeImagesLabel.style.display = 'none';

      // Restore saved settings (toggle + checkbox + profile selection)
      restorePmcSettings();

      // Populate profile dropdown from cached profiles or fetch
      if (_cachedProfiles && _cachedProfiles.length > 0) {
        populateProfileDropdown(_cachedProfiles);
      } else {
        // Fetch profiles in background to populate dropdown
        (async function () {
          try {
            await migrateLegacyProfile(auth.userId, auth.idToken, auth.firebaseUid);
            var profiles = await listProfilesFromFirestore(auth.userId, auth.idToken, auth.firebaseUid);
            _cachedProfiles = profiles;
            populateProfileDropdown(profiles);
          } catch (e) {
            populateProfileDropdown([]);
          }
        })();
      }

      showScreen('screen2');

      // Step 3: Start extraction in background while user chooses destination
      crumb('pro_extract');
      _pmcProExtractPromise = new Promise(function (resolve, reject) {
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PRO' }, function (resp) {
          if (chrome.runtime.lastError) {
            reject(new Error('This website is not supported. Try porting from an AI chat.'));
            return;
          }
          if (!resp || !resp.success) {
            reject(new Error(resp && resp.error ? resp.error : 'Extraction failed.'));
            return;
          }
          resolve(resp);
        });
      });

      // Images are now handled via per-image selection in handleDestination
      // (errors from extraction are handled there too)

    } catch (err) {
      crumb('pro_failed', { error: (err.message || '').substring(0, 200) });
      setStatus(err.message || 'Something went wrong.', true);
    } finally {
      proChatBtn.disabled = false;
    }
  });

  proBackBtn.addEventListener('click', function () {
    // Image selection mode: resolve with empty array (skip all images)
    if (_imageConfirmResolve) {
      _imageConfirmResolve([]);
      _imageConfirmResolve = null;
      document.body.classList.remove('pro-review-active');
      return;
    }
    // Pro brief review mode
    if (_proData) {
      trackEvent('pro_brief_cancelled', {
        sourcePlatform: _proData.sourcePlatform,
      });
    }
    hideProReview();
    _proData = null;
  });

  proConfirmBtn.addEventListener('click', async function () {
    // Image selection mode: resolve with selected indices (into original capturedImages)
    if (_imageConfirmResolve) {
      var checkboxes = proAssetTableBody.querySelectorAll('input[type="checkbox"]');
      var selectedIndices = [];
      for (var i = 0; i < checkboxes.length; i++) {
        if (checkboxes[i].checked) {
          selectedIndices.push(parseInt(checkboxes[i].getAttribute('data-asset-index'), 10));
        }
      }
      _imageConfirmResolve(selectedIndices);
      _imageConfirmResolve = null;
      document.body.classList.remove('pro-review-active');
      return;
    }

    // Pro brief review mode
    if (!_proData) return;
    crumb('pro_confirm');

    proConfirmBtn.disabled = true;
    proStatus.textContent = 'Saving...';
    proError.textContent = '';

    try {
      // Collect user's checkbox selections
      var checkboxes2 = proAssetTableBody.querySelectorAll('input[type="checkbox"]');
      for (var j = 0; j < checkboxes2.length; j++) {
        var idx = parseInt(checkboxes2[j].getAttribute('data-asset-index'), 10);
        if (_proData.assets[idx]) {
          _proData.assets[idx].selected = checkboxes2[j].checked;
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

      trackEvent('pro_brief_confirmed', {
        sourcePlatform: _proData.sourcePlatform,
        assetsTotal: _proData.assets.length,
        assetsSelected: _proData.assets.filter(function (a) { return a.selected; }).length,
        imagesCaptured: _proData.assets.filter(function (a) { return a.type === 'image' && a.dataUrl; }).length,
      });

      // Show destination picker (content is built per-destination in handleDestination)
      _portMode = 'pro_brief';
      screen2Label.textContent = 'Port project brief to\u2026';
      setScreen2Status('');
      setAllDestBtnsDisabled(false);
      instructionsCheckboxLabel.style.display = 'none';
      includeProfileLabel.style.display = 'none';
      includeImagesLabel.style.display = 'none';
      hideProReview();
      showScreen('screen2');

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

  // ─── Sign in link (hidden if already authenticated) ─────────────────────
  const loginBtn = document.getElementById('loginBtn');
  loginBtn.style.display = 'none'; // hidden by default

  // Check both Google token and Firebase token to determine sign-in state
  chrome.storage.local.get(['firebase_id_token', 'firebase_token_expiry'], function (result) {
    var hasValidFirebase = result.firebase_id_token && result.firebase_token_expiry &&
      result.firebase_token_expiry > Date.now();
    if (hasValidFirebase) {
      loginBtn.style.display = 'none';
      return;
    }
    // Fallback: check Google auth token
    chrome.identity.getAuthToken({ interactive: false }, function (token) {
      if (chrome.runtime.lastError || !token) {
        loginBtn.style.display = '';
      }
    });
  });

  loginBtn.addEventListener('click', async function () {
    loginBtn.disabled = true;
    loginBtn.textContent = 'Creating account\u2026';
    try {
      var auth = await ensureAuthenticated();
      refreshTierSilently(auth);
      // Re-check tier and update UI immediately
      await checkUserTier();
      loginBtn.style.display = 'none';
      crumb('login_btn_success');
    } catch (e) {
      loginBtn.textContent = 'Create a Free Account';
      setStatus('Sign in failed. Try again.', true);
      crumb('login_btn_failed', { error: (e.message || '').substring(0, 200) });
    } finally {
      loginBtn.disabled = false;
    }
  });

  // ─── Second Opinion ────────────────────────────────────────────────────────
  async function triggerSecondOpinion() {
    // Usage gating — authorize (no increment yet)
    var soAuth;
    try {
      soAuth = await ensureAuthenticated();
      var soUsageResult = applyDevTierToResult(await authorizeFeature(soAuth.idToken, soAuth.firebaseUid, 'second_opinion'));
      if (!soUsageResult.allowed) {
        showUsageBlocked(soUsageResult, 'second_opinion');
        return;
      }
      if (soUsageResult.warning) showUsageWarning(soUsageResult.warning);
      if (soUsageResult.trial && soUsageResult.trial.just_started) showTrialStarted();
      _pendingAuth = soAuth;
      _pendingFeature = 'second_opinion';
    } catch (e) {
      setStatus(e.message || 'Auth failed. Try signing in.', true);
      return;
    }

    var proxyBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL !== 'YOUR_WORKER_URL') ? PROXY_URL : '';
    if (!proxyBase) {
      setStatus('Worker URL not configured.', true);
      return;
    }

    secondOpinionBtn.disabled = true;
    showDialLoading();
    updateSOStep(1, 'Detecting platform...');
    var _soStartTime = Date.now();

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

      var platformLabel = platform === 'chatgpt' ? 'ChatGPT' : platform === 'gemini' ? 'Gemini' : 'Claude';
      setSODetail(1, 'Extracting from ' + platformLabel + '...');

      // Step 2: Extract conversation from the page
      var extractResponse = await new Promise(function (resolve, reject) {
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PRO' }, function (resp) {
          if (chrome.runtime.lastError) {
            reject(new Error('This website is not supported. Try porting from an AI chat.'));
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
      setSODetail(1, platformLabel + ' conversation read');

      // Read captured images from storage and filter out tiny ones
      var soImageData = await new Promise(function (resolve) {
        chrome.storage.local.get('portility_captured_images', function (d) { resolve(d); });
      });
      var soCapturedImages = (soImageData.portility_captured_images || []).filter(function (ci) {
        return ci.dataUrl && ci.dataUrl.length >= MIN_IMAGE_DATA_LENGTH;
      });
      var soImagesForApi = soCapturedImages.map(function (ci) {
        return { dataUrl: ci.dataUrl, filename: ci.filename || '', alt: ci.alt || '' };
      });

      // Ensure "Reading" step spins for at least 3s before advancing
      var _soStep1Elapsed = Date.now() - _soStartTime;
      if (_soStep1Elapsed < 3000) {
        await new Promise(function (r) { setTimeout(r, 3000 - _soStep1Elapsed); });
      }

      // Steps 3-5: Summarize (if long) and second-opinion in parallel
      var soDistinctId = await getDistinctId();
      var soOpinionBody = { brief: extractResponse.text, platform: platform };
      if (soImagesForApi.length > 0) soOpinionBody.images = soImagesForApi;

      // Skip summarize for short conversations (~3K tokens ≈ 12K chars) — pass raw text directly
      var SO_SHORT_THRESHOLD = 12000;
      var skipSummarize = extractResponse.text.length < SO_SHORT_THRESHOLD;

      var artifact;
      var soData;

      if (skipSummarize) {
        updateSOStep(2, 'Getting 2nd opinion...');
        var soResp = await fetch(proxyBase + '/second-opinion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Portility-Distinct-Id': soDistinctId },
          body: JSON.stringify(soOpinionBody),
        });
        soData = await soResp.json();
        if (!soResp.ok) throw new Error(soData.error || 'Second opinion request failed');
        trackTokenUsage('second-opinion', soData._usage);
        artifact = extractResponse.text;
      } else {
        updateSOStep(2, 'Summarizing & getting 2nd opinion...');

        // Strip dataUrl from assets before sending to API
        var soAssetsForApi = (extractResponse.assets || []).map(function (a) {
          var copy = { type: a.type, url: a.url, alt: a.alt, filename: a.filename, role: a.role, turnIndex: a.turnIndex };
          if (a.thumbnailUrl && !a.thumbnailUrl.startsWith('data:')) copy.thumbnailUrl = a.thumbnailUrl;
          return copy;
        });
        var soBody = {
          conversation: extractResponse.text,
          assets: soAssetsForApi,
        };
        if (soImagesForApi.length > 0) soBody.images = soImagesForApi;
        var summarizePromise = fetch(proxyBase + '/summarize-pro', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Portility-Distinct-Id': soDistinctId },
          body: JSON.stringify(soBody),
        });

        var secondOpinionPromise = fetch(proxyBase + '/second-opinion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Portility-Distinct-Id': soDistinctId },
          body: JSON.stringify(soOpinionBody),
        });

        var [summaryResp, soResp] = await Promise.all([summarizePromise, secondOpinionPromise]);

        if (!summaryResp.ok) throw new Error('AI analysis failed (HTTP ' + summaryResp.status + ')');
        var summaryData = await summaryResp.json();
        trackTokenUsage('summarize-pro', summaryData._usage);

        soData = await soResp.json();
        if (!soResp.ok) throw new Error(soData.error || 'Second opinion request failed');
        trackTokenUsage('second-opinion', soData._usage);

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

        artifact = parsed.brief || contentText;
      }

      // Compress any embedded base64 images in the summary
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

      // Step 6: POST to /compare
      setSODetail(2, 'Responses received');
      updateSOStep(3, 'Scoring agreement...');

      var compareResp = await fetch(proxyBase + '/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Portility-Distinct-Id': soDistinctId },
        body: JSON.stringify({ original: artifact, secondOpinion: soData.text }),
      });

      var compareData = await compareResp.json();
      if (!compareResp.ok) throw new Error(compareData.error || 'Comparison request failed');
      trackTokenUsage('compare', compareData._usage);

      // Step 7: Pass to results UI (Task 14)
      setSODetail(3, 'Analysis complete');
      soNewBtn.style.display = 'none';
      showSecondOpinionResults({
        originalBrief: artifact,
        secondOpinion: soData.text,
        source: soData.source,
        platform: platform,
        comparison: compareData,
        durationMs: Date.now() - _soStartTime,
      });
      // Record successful use (fire-and-forget)
      if (_pendingAuth && _pendingFeature) {
        recordUse(_pendingAuth.idToken, _pendingAuth.firebaseUid, _pendingFeature);
        _pendingAuth = null; _pendingFeature = null;
      }
    } catch (err) {
      stopNeedleSweep();
      resetSOSteps();
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
  var soNewBtn = document.getElementById('soNewBtn');
  var _soCurrentScore = 0;
  var _soAnimFrame;
  var _soResultData = null;
  var SO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Check for cached SO result on popup open (invalidate if tab URL changed)
  chrome.storage.local.get('so_cached_result', function (result) {
    var cached = result.so_cached_result;
    if (cached && cached.data && cached.timestamp && (Date.now() - cached.timestamp < SO_CACHE_TTL)) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var currentUrl = (tabs && tabs[0]) ? tabs[0].url : '';
        if (cached.tabUrl && cached.tabUrl !== currentUrl) {
          // Page changed — clear cache and lastProBrief, stay on home screen
          chrome.storage.local.remove(['so_cached_result', 'lastProBrief']);
          return;
        }
        showSecondOpinionResults(cached.data);
        soNewBtn.style.display = 'inline';
      });
    }
  });

  function soZoneColors(score) {
    if (score < 34) return { text: '#fa000c', needle: '#fa000c' };
    if (score < 67) return { text: '#FFD348', needle: '#FFD348' };
    return { text: '#41f531', needle: '#41f531' };
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

  /**
   * Split a comparison point into a short descriptive topic title and the rest.
   */
  function soSplitTitleBody(text) {
    if (!text) return { title: 'Point', summary: '' };
    // Handle object format {title, text} from updated API
    if (typeof text === 'object' && text.title) {
      return { title: text.title, summary: text.text || '' };
    }
    if (typeof text !== 'string') return { title: 'Point', summary: String(text) };
    // Strip common AI-analysis preambles to get to the substance
    var body = text;
    var preambles = [
      /^both\s+(recognize|acknowledge|note|agree|identify|highlight|mention|discuss|address|cover|provide|include|present|focus|emphasize)\s+(that|the|on|how|a)?\s*:?\s*/i,
      /^(response [AB]|they both|each response|the responses?|both AIs?|both models?)\s+(recognize|acknowledge|note|agree|identify|highlight|mention|discuss|address|present|focus|emphasize)s?\s+(that|the|on|how|a)?\s*:?\s*/i,
      /^(response [AB])\s+(presents?|focuses?|covers?|provides?|includes?|discusses?|emphasizes?)\s*:?\s*/i,
    ];
    for (var i = 0; i < preambles.length; i++) {
      body = body.replace(preambles[i], '');
    }
    // Extract topic: take first 2-3 meaningful words as the title
    // Look for a natural break (comma, dash, period, "while", "and", "but", "with")
    var breakMatch = body.match(/^(.{8,35?}?)(?:\s*[,\-\u2014]\s|\s+(?:while|and then|but|with|including|between|from|versus|vs)\s)/i);
    var titleText;
    if (breakMatch) {
      titleText = breakMatch[1].trim();
    } else {
      var words = body.split(/\s+/).slice(0, 3);
      titleText = words.join(' ');
    }
    titleText = titleText.replace(/[.,;:!?]+$/, '');
    // Capitalize first letter
    titleText = titleText.charAt(0).toUpperCase() + titleText.slice(1);
    return { title: titleText, summary: text };
  }

  /**
   * Find relevant quotes from each AI's response matching a topic keyword.
   */
  function soFindQuotes(data, topic) {
    var keywords = topic.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 3; });
    if (keywords.length === 0) return '';

    function findRelevant(text) {
      if (!text) return '';
      var sentences = text.split(/[.!?\n]+/).filter(function (s) { return s.trim().length > 10; });
      for (var i = 0; i < sentences.length; i++) {
        var lower = sentences[i].toLowerCase();
        for (var k = 0; k < keywords.length; k++) {
          if (lower.indexOf(keywords[k]) !== -1) {
            var s = sentences[i].trim();
            if (s.length > 120) s = s.substring(0, 117) + '...';
            return s;
          }
        }
      }
      return '';
    }

    var platformNames = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
    var origName = platformNames[data.platform] || data.platform || 'AI 1';
    var secName = platformNames[data.source] || data.source || 'AI 2';

    var q1 = findRelevant(data.originalBrief);
    var q2 = findRelevant(data.secondOpinion);

    var html = '';
    if (q1) html += '<div class="so-row-quote"><strong>' + escHtml(origName) + ':</strong> "' + escHtml(q1) + '"</div>';
    if (q2) html += '<div class="so-row-quote"><strong>' + escHtml(secName) + ':</strong> "' + escHtml(q2) + '"</div>';
    if (!html) html = '<div class="so-row-quote" style="color:#bbb;">No matching quotes found.</div>';
    return html;
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
    var questionType = cmp.question_type || 'analytical';
    var tc = soTypeColors(questionType);

    // Badge
    var badge = document.getElementById('so-badge');
    badge.textContent = questionType.charAt(0).toUpperCase() + questionType.slice(1);
    badge.style.background = tc[0];
    badge.style.color = tc[1];
    badge.style.borderColor = tc[2];

    // Stop needle sweep and restore CSS transition for the snap
    stopNeedleSweep();
    var needleEl = document.getElementById('so-needle');
    needleEl.style.transition = 'transform 0.9s cubic-bezier(0.34,1.2,0.64,1)';

    // Ensure gauge band is visible
    document.getElementById('so-gauge-band').style.opacity = '1';
    document.getElementById('so-dial-svg').style.opacity = '1';

    // Needle — snap to real score
    var svgRot = -120 + (score / 100) * 240;
    needleEl.style.transform = 'rotate(' + svgRot + 'deg)';
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
        var parts = soSplitTitleBody(a);
        return '<div class="so-list-row" style="border-color:#C0DD97">' +
          '<span class="so-row-title">' + escHtml(parts.title) + ':</span> ' + escHtml(parts.summary) +
          '<div class="so-row-body">' + soFindQuotes(data, parts.title) + '</div>' +
        '</div>';
      }).join('');

    // Divergences
    document.getElementById('so-diff-list').innerHTML =
      (cmp.divergences || []).map(function (d) {
        var parts = soSplitTitleBody(d);
        return '<div class="so-list-row" style="border-color:#F7C1C1">' +
          '<span class="so-row-title">' + escHtml(parts.title) + ':</span> ' + escHtml(parts.summary) +
          '<div class="so-row-body">' + soFindQuotes(data, parts.title) + '</div>' +
        '</div>';
      }).join('');

    // Wire expand/collapse on list rows
    document.querySelectorAll('.so-list-row').forEach(function (row) {
      row.addEventListener('click', function () { this.classList.toggle('expanded'); });
    });

    // Model name for footer
    var modelMap = { chatgpt: 'GPT-4o', claude: 'Claude Sonnet 4.6' };
    soModelName.textContent = 'Comparison model: ' + (modelMap[data.source] || data.source);

    // Store full result data for rating page
    _soResultData = {
      originalBrief: data.originalBrief || '',
      secondOpinion: data.secondOpinion || '',
      source: data.source || '',
      platform: data.platform || '',
      comparison: data.comparison || {},
    };

    // Persist for history + ML training
    var durationMs = data.durationMs || 0;
    try {
      saveSOComparison({
        originalBrief: data.originalBrief || '',
        secondOpinion: data.secondOpinion || '',
        source: data.source || '',
        platform: data.platform || '',
        comparison: data.comparison || {},
        durationMs: durationMs,
      });
    } catch (e) {
      console.log('[SecondOpinion] Failed to save to history:', e);
    }

    trackEvent('second_opinion_completed', {
      platform: data.platform,
      source: data.source,
      aiScore: score,
      questionType: questionType,
      durationMs: durationMs,
      durationSec: Math.round(durationMs / 1000),
    });

    // Transition from loading to results
    soResultsEl.classList.remove('so-loading');
    setStatus('');
    screen1.style.display = 'none';
    soResultsEl.style.display = 'block';

    // Cache results for 5-minute persistence (with tab URL for navigation invalidation)
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tabUrl = (tabs && tabs[0]) ? tabs[0].url : '';
      chrome.storage.local.set({
        so_cached_result: {
          data: {
            originalBrief: data.originalBrief || '',
            secondOpinion: data.secondOpinion || '',
            source: data.source || '',
            platform: data.platform || '',
            comparison: data.comparison || {},
          },
          timestamp: Date.now(),
          tabUrl: tabUrl,
        }
      });
    });
  }

  var _soSweepFrame = null;

  function updateSOStep(stepNum, detail) {
    var steps = document.querySelectorAll('#so-steps .so-step');
    steps.forEach(function (el) {
      var s = parseInt(el.getAttribute('data-step'), 10);
      el.classList.remove('active', 'done');
      if (s < stepNum) el.classList.add('done');
      else if (s === stepNum) el.classList.add('active');
    });
    if (detail) setSODetail(stepNum, detail);
  }

  function setSODetail(stepNum, text) {
    var el = document.getElementById('so-detail-' + stepNum);
    if (el) el.textContent = text;
  }

  function resetSOSteps() {
    document.querySelectorAll('#so-steps .so-step').forEach(function (el) {
      el.classList.remove('active', 'done');
    });
    for (var i = 1; i <= 3; i++) {
      var d = document.getElementById('so-detail-' + i);
      if (d) d.textContent = '';
    }
  }

  // Map a needle degree to the zone color (same thresholds as soZoneColors)
  function sweepNeedleColor(deg) {
    // deg -120 = score 0, deg +120 = score 100
    var score = (deg + 120) / 240 * 100;
    if (score < 34) return '#fa000c';
    if (score < 67) return '#FFD348';
    return '#41f531';
  }

  function startNeedleSweep() {
    var needle = document.getElementById('so-needle');
    var needleMain = document.getElementById('so-needle-main');
    var needleTail = document.getElementById('so-needle-tail');
    var hubDot = document.getElementById('so-hub-dot');
    var scoreEl = document.getElementById('so-score-number');
    var minDeg = -120;
    var maxDeg = 120;
    var halfCycle = 10000; // 10s per sweep direction
    var startTime = null;
    var lastColor = '';

    // Disable CSS transition so RAF controls the needle directly
    needle.style.transition = 'none';

    function tick(ts) {
      if (!startTime) startTime = ts;
      var elapsed = ts - startTime;
      // Triangle wave: 0→1 over halfCycle, then 1→0 over halfCycle, repeat
      var cycle = elapsed % (halfCycle * 2);
      var p = cycle < halfCycle ? cycle / halfCycle : 2 - cycle / halfCycle;
      // Smooth with ease-in-out
      var eased = p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);

      var deg = minDeg + (maxDeg - minDeg) * eased;
      needle.style.transform = 'rotate(' + deg + 'deg)';

      // Track score number with needle position
      var score = Math.round((deg - minDeg) / (maxDeg - minDeg) * 100);
      scoreEl.textContent = score;

      // Update needle + score color to match the zone
      var c = sweepNeedleColor(deg);
      if (c !== lastColor) {
        needleMain.setAttribute('stroke', c);
        needleTail.setAttribute('stroke', c);
        hubDot.setAttribute('fill', c);
        scoreEl.setAttribute('fill', c);
        lastColor = c;
      }

      _soSweepFrame = requestAnimationFrame(tick);
    }
    _soSweepFrame = requestAnimationFrame(tick);
  }

  function stopNeedleSweep() {
    if (_soSweepFrame) {
      cancelAnimationFrame(_soSweepFrame);
      _soSweepFrame = null;
    }
  }

  function showDialLoading(statusText) {
    // Reset dial to gray/neutral state
    document.getElementById('so-score-number').textContent = '\u2026';
    document.getElementById('so-score-number').setAttribute('fill', '#d1d5db');
    document.getElementById('so-score-lbl').textContent = '';
    document.getElementById('so-needle').style.transition = 'none';
    document.getElementById('so-needle').style.transform = 'rotate(-120deg)';
    document.getElementById('so-needle-main').setAttribute('stroke', '#d1d5db');
    document.getElementById('so-needle-tail').setAttribute('stroke', '#d1d5db');
    document.getElementById('so-hub-dot').setAttribute('fill', '#d1d5db');
    document.getElementById('so-gauge-band').style.opacity = '0.15';
    document.getElementById('so-agree-list').innerHTML = '';
    document.getElementById('so-diff-list').innerHTML = '';
    document.getElementById('so-interp').textContent = '';
    document.getElementById('so-likert-status').textContent = '';
    document.querySelectorAll('.so-likert-btn').forEach(function (b) {
      b.classList.remove('selected', 'submitted');
    });
    _soCurrentScore = 0;

    // Reset steps
    resetSOSteps();

    // Add loading class + hide lists
    soResultsEl.classList.add('so-loading');

    // Start the slow needle sweep
    startNeedleSweep();

    // Show the results screen
    screen1.style.display = 'none';
    soResultsEl.style.display = 'block';
    expandPopup();
  }


  // Expose for console testing (remove before release)
  window._testSO = showSecondOpinionResults;

  soViewFullBtn.addEventListener('click', async function () {
    if (!_soResultData) return;
    var rd = _soResultData;
    var fcAuth;
    try { fcAuth = await ensureAuthenticated(); } catch (e) { fcAuth = null; }
    var proxyBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL !== 'YOUR_WORKER_URL') ? PROXY_URL : '';

    var compData = {
      originalBrief: rd.originalBrief || '',
      secondOpinion: rd.secondOpinion || '',
      source: rd.source || '',
      platform: rd.platform || '',
      comparison: rd.comparison || {},
      idToken: fcAuth ? fcAuth.idToken : '',
      proxyUrl: proxyBase,
    };
    await new Promise(function (resolve) {
      chrome.storage.local.set({ portility_comparison_data: compData }, resolve);
    });
    chrome.tabs.create({ url: chrome.runtime.getURL('comparison.html') });
  });

  // ── Inline Likert rating ────────────────────────────────────────────────────
  document.querySelectorAll('.so-likert-btn').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      if (!_soResultData) return;
      var rating = parseInt(btn.dataset.rating, 10);

      // Highlight selected button
      document.querySelectorAll('.so-likert-btn').forEach(function (b) {
        b.classList.remove('selected');
        b.classList.add('submitted');
      });
      btn.classList.add('selected');

      var statusEl = document.getElementById('so-likert-status');
      statusEl.textContent = 'Saving\u2026';
      statusEl.style.color = '#6b7280';

      try {
        var auth = await ensureAuthenticated();
        var cmp = _soResultData.comparison || {};
        var score = Math.round(cmp.agreement_score || 0);
        var proxyBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL !== 'YOUR_WORKER_URL') ? PROXY_URL : '';

        var resp = await fetch(proxyBase + '/feedback', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + auth.idToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: _soResultData.platform || '',
            comparisonModel: _soResultData.source || '',
            aiScore: score,
            humanRating: String(rating),
            humanReason: '',
            originalBrief: _soResultData.originalBrief || '',
            secondOpinion: _soResultData.secondOpinion || '',
            questionType: cmp.question_type || 'analytical',
          }),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        statusEl.textContent = 'Thanks for your feedback!';
        statusEl.style.color = '#16a34a';

        trackEvent('second_opinion_feedback_submitted', {
          aiScore: score,
          humanRating: rating,
          platform: _soResultData.platform,
        });
      } catch (e) {
        statusEl.textContent = 'Could not save — ' + (e.message || e);
        statusEl.style.color = '#dc2626';
        // Re-enable buttons so they can retry
        document.querySelectorAll('.so-likert-btn').forEach(function (b) {
          b.classList.remove('submitted');
        });
        console.error('[Likert] Save failed:', e);
      }
    });
  });

  soBackBtn.addEventListener('click', function () {
    stopNeedleSweep();
    soResultsEl.classList.remove('so-loading');
    soResultsEl.style.display = 'none';
    soNewBtn.style.display = 'none';
    chrome.storage.local.remove('so_cached_result');
    resetPopup();
    screen1.style.display = 'block';
  });

  soNewBtn.addEventListener('click', function () {
    stopNeedleSweep();
    soResultsEl.classList.remove('so-loading');
    soResultsEl.style.display = 'none';
    soNewBtn.style.display = 'none';
    chrome.storage.local.remove('so_cached_result');
    resetPopup();
    screen1.style.display = 'block';
    triggerSecondOpinion();
  });

  secondOpinionBtn.addEventListener('click', function () {
    if (!_isSupportedPage) {
      setStatus('This website is not supported. Try porting from an AI chat.', true);
      return;
    }
    triggerSecondOpinion();
  });

  // ─── Settings gear ─────────────────────────────────────────────────────────
  settingsGearBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ─── Upgrade button — always navigates to pricing ───────────────────────
  upgradeBtn.addEventListener('click', function () {
    chrome.tabs.create({ url: 'https://www.portility.ai/pricing' });
  });

  // ─── Port Me (free) — same handler as Port Me Pro ────────────────────────
  portInstructionsBtnFree.addEventListener('click', async function () {
    crumb('instr_free_start');
    // Free users: existing single-profile questionnaire flow
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
      portInstructionsBtnFree.disabled = true;
      crumb('instr_free_fetch');
      _decryptedInstructions = await fetchAndDecryptInstructions();
      crumb('instr_free_decrypted');
      setPortStatus('');
      portInstructionsBtnFree.disabled = false;
      screen2Label.textContent = 'Port instructions to\u2026';
      setScreen2Status('');
      setAllDestBtnsDisabled(false);
      instructionsCheckboxLabel.style.display = 'none';
      includeProfileLabel.style.display = 'none';
      includeImagesLabel.style.display = 'none';
      showScreen('screen2');
    } catch (err) {
      crumb('instr_free_failed', { error: (err.message || '').substring(0, 200) });
      portInstructionsBtnFree.disabled = false;
      setPortStatus(err.message || 'Something went wrong.', true);
    }
  });
});
