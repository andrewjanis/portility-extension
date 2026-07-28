/**
 * usage.js
 * Portility — Usage gating via server-side atomic tracking.
 *
 * All check+increment logic is handled by the worker POST /use endpoint.
 * This file provides the client wrapper and display helpers.
 */

'use strict';

var USAGE_TIERS = {
  free:  { limit: Infinity, monthly: false, label: 'Free' },
  paid:  { limit: 50, monthly: true, label: 'Pro' },
  paid2: { limit: 150, monthly: true, label: 'Premium' },
  paid3: { limit: Infinity, monthly: true, label: 'Unlimited' },
  BetaAccess: { limit: Infinity, monthly: false, label: 'BetaAccess' },
};

var UPGRADE_URLS = {
  free:  'https://www.portility.ai/pricing',
  paid:  'https://www.portility.ai/pricing',
  paid2: 'https://www.portility.ai/pricing',
  paid3: null,
  BetaAccess: null,
};

var USAGE_PROJECT_ID = 'portility';

/**
 * Authorize a paid feature use (check entitlement without incrementing).
 * @param {string} idToken - Firebase ID token
 * @param {string} firebaseUid
 * @param {string} feature - e.g. 'port_me_pro', 'port_my_chat_pro', 'second_opinion'
 * @returns {Promise<{allowed: boolean, gating?: string, reason?: string, trial?: object, used?: number, limit?: number, tier?: string, warning?: object|null, upgradeUrl?: string|null}>}
 */
async function authorizeFeature(idToken, firebaseUid, feature) {
  var proxyBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL !== 'YOUR_WORKER_URL') ? PROXY_URL : '';
  if (!proxyBase) throw new Error('Worker URL not configured.');

  var payload = { firebaseUid: firebaseUid, feature: feature };
  var override = await new Promise(function (resolve) {
    chrome.storage.local.get('devTierOverride', function (r) { resolve(r.devTierOverride || null); });
  });
  if (override && override !== 'paid3') payload.tierOverride = override;

  var resp = await fetch(proxyBase + '/authorize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + idToken,
    },
    body: JSON.stringify(payload),
  });

  if (resp.status === 401 || resp.status === 403) {
    var errData = await resp.json().catch(function () { return {}; });
    throw new Error(errData.error || 'Authentication failed');
  }

  if (!resp.ok && resp.status !== 200) {
    var errBody = await resp.json().catch(function () { return {}; });
    throw new Error(errBody.error || 'Authorization check failed');
  }

  return resp.json();
}

/**
 * Record a successful paid feature use (fire-and-forget).
 * @param {string} idToken - Firebase ID token
 * @param {string} firebaseUid
 * @param {string} feature
 */
async function recordUse(idToken, firebaseUid, feature) {
  var proxyBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL !== 'YOUR_WORKER_URL') ? PROXY_URL : '';
  if (!proxyBase) return;

  var payload = { firebaseUid: firebaseUid, feature: feature };
  var override = await new Promise(function (resolve) {
    chrome.storage.local.get('devTierOverride', function (r) { resolve(r.devTierOverride || null); });
  });
  if (override && override !== 'paid3') payload.tierOverride = override;

  fetch(proxyBase + '/record-use', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + idToken,
    },
    body: JSON.stringify(payload),
  }).catch(function (e) {
    console.warn('[Usage] recordUse failed:', e.message);
  });
}

/**
 * Single atomic call: check usage + increment if allowed.
 * @deprecated Use authorizeFeature + recordUse instead. Kept for backward compat.
 * @param {string} idToken - Firebase ID token
 * @param {string} firebaseUid
 * @param {string} feature - e.g. 'port_me_pro', 'port_my_chat_pro', 'second_opinion'
 * @returns {Promise<{allowed: boolean, used?: number, limit?: number, tier?: string, warning?: object|null, upgradeUrl?: string|null}>}
 */
async function useFeature(idToken, firebaseUid, feature) {
  var proxyBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL !== 'YOUR_WORKER_URL') ? PROXY_URL : '';
  if (!proxyBase) throw new Error('Worker URL not configured.');

  // Include dev tier override if active so the server respects it
  var payload = { firebaseUid: firebaseUid, feature: feature };
  var override = await new Promise(function (resolve) {
    chrome.storage.local.get('devTierOverride', function (r) { resolve(r.devTierOverride || null); });
  });
  if (override) payload.tierOverride = override;

  var resp = await fetch(proxyBase + '/use', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + idToken,
    },
    body: JSON.stringify(payload),
  });

  if (resp.status === 401 || resp.status === 403) {
    var errData = await resp.json().catch(function () { return {}; });
    throw new Error(errData.error || 'Authentication failed');
  }

  if (!resp.ok && resp.status !== 200) {
    var errBody = await resp.json().catch(function () { return {}; });
    throw new Error(errBody.error || 'Usage check failed');
  }

  return resp.json();
}

/**
 * Get current usage summary for display (options page).
 * Reads from Firestore directly with dual-schema fallback.
 * @param {string} idToken
 * @param {string} firebaseUid
 * @param {string} userTier
 * @returns {Promise<{used: number, limit: number, tier: string, tierLabel: string, isLifetime: boolean}>}
 */
async function getCurrentUsageSummary(idToken, firebaseUid, userTier) {
  var tierConfig = USAGE_TIERS[userTier] || USAGE_TIERS.free;

  var url = 'https://firestore.googleapis.com/v1/projects/' + USAGE_PROJECT_ID +
    '/databases/(default)/documents/users/' + firebaseUid +
    '?mask.fieldPaths=usage_count&mask.fieldPaths=reset_date' +
    '&mask.fieldPaths=lifetimeFreeUsed&mask.fieldPaths=billingAnchorDate&mask.fieldPaths=monthlyUsage' +
    '&mask.fieldPaths=trial_started&mask.fieldPaths=trial_start_at&mask.fieldPaths=paid_use_count';

  var response = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + idToken },
  });

  if (response.status === 404) {
    return { used: 0, limit: tierConfig.limit, tier: userTier, tierLabel: tierConfig.label, isLifetime: !tierConfig.monthly };
  }
  if (!response.ok) throw new Error('Failed to fetch usage data');

  var doc = await response.json();
  var fields = doc.fields || {};

  var used;
  if (fields.usage_count !== undefined) {
    // New schema
    used = parseInt(fields.usage_count.integerValue || '0', 10);
  } else if (!tierConfig.monthly) {
    // Old schema — free tier
    used = parseInt(fields.lifetimeFreeUsed?.integerValue || '0', 10);
  } else {
    // Old schema — paid tier
    var anchorDate = fields.billingAnchorDate?.timestampValue || null;
    var windowKey = getCurrentWindowKeyLegacy(anchorDate);
    var mapFields = fields.monthlyUsage?.mapValue?.fields;
    used = (mapFields && mapFields[windowKey]) ? parseInt(mapFields[windowKey].integerValue || '0', 10) : 0;
  }

  // Build trial info for free users
  var trial = null;
  if (userTier === 'free') {
    var trialStarted = fields.trial_started?.booleanValue || false;
    var trialStartAt = fields.trial_start_at?.timestampValue || null;
    var paidUseCount = parseInt(fields.paid_use_count?.integerValue || '0', 10);
    if (trialStarted && trialStartAt) {
      var daysSinceStart = (Date.now() - new Date(trialStartAt).getTime()) / (1000 * 60 * 60 * 24);
      var daysRemaining = Math.max(0, Math.ceil(7 - daysSinceStart));
      var usesRemaining = Math.max(0, 50 - paidUseCount);
      trial = {
        started: true,
        expired: daysRemaining <= 0 || usesRemaining <= 0,
        days_remaining: daysRemaining,
        uses_remaining: usesRemaining,
        paid_use_count: paidUseCount,
      };
    } else {
      trial = { started: false, expired: false };
    }
  }

  return {
    used: used,
    limit: tierConfig.limit,
    tier: userTier,
    tierLabel: tierConfig.label,
    isLifetime: !tierConfig.monthly,
    trial: trial,
  };
}

/**
 * Legacy window key calculation — only used for getCurrentUsageSummary fallback.
 */
function getCurrentWindowKeyLegacy(billingAnchorDate) {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();
  if (billingAnchorDate) {
    var anchor = new Date(billingAnchorDate);
    var anchorDay = anchor.getDate();
    if (now.getDate() < anchorDay) {
      month -= 1;
      if (month < 0) { month = 11; year -= 1; }
    }
  }
  var monthStr = String(month + 1).padStart(2, '0');
  return year + '-' + monthStr;
}

/**
 * Stub — returns empty history. Options page handles this gracefully.
 * @returns {Promise<Object>}
 */
async function getUsageHistory() {
  return {};
}
