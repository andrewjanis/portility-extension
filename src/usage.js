/**
 * usage.js
 * Portility — Usage counting & billing gating for pro features.
 *
 * Tracks usage against tier limits. Free users get 10 lifetime uses.
 * Paid users get monthly allowances (50/150/250) that reset on billing anniversary.
 */

'use strict';

var USAGE_TIERS = {
  free:  { limit: 10, monthly: false, label: 'Free' },
  paid:  { limit: 50, monthly: true, label: 'Pro' },
  paid2: { limit: 150, monthly: true, label: 'Pro Plus' },
  paid3: { limit: 250, monthly: true, label: 'Pro Max' },
};

var UPGRADE_URLS = {
  free:  'https://www.portility.ai/pricing',
  paid:  'STRIPE_TIER2_CHECKOUT_URL',   // placeholder — replace with real URL
  paid2: 'STRIPE_TIER3_CHECKOUT_URL',   // placeholder — replace with real URL
  paid3: null,                           // max tier — no upgrade available
};

var USAGE_PROJECT_ID = 'portility';

/**
 * Fetch usage fields from the user document in Firestore.
 * @param {string} idToken
 * @param {string} firebaseUid
 * @returns {Promise<{lifetimeFreeUsed: number, billingAnchorDate: string|null, monthlyUsage: Object}>}
 */
async function getUsageDoc(idToken, firebaseUid) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + USAGE_PROJECT_ID +
    '/databases/(default)/documents/users/' + firebaseUid +
    '?mask.fieldPaths=lifetimeFreeUsed&mask.fieldPaths=billingAnchorDate&mask.fieldPaths=monthlyUsage';

  var response = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + idToken },
  });

  if (response.status === 404) {
    return { lifetimeFreeUsed: 0, billingAnchorDate: null, monthlyUsage: {} };
  }

  if (!response.ok) {
    throw new Error('Failed to fetch usage data');
  }

  var doc = await response.json();
  var fields = doc.fields || {};

  var result = {
    lifetimeFreeUsed: parseInt(fields.lifetimeFreeUsed?.integerValue || '0', 10),
    billingAnchorDate: fields.billingAnchorDate?.timestampValue || null,
    monthlyUsage: {},
  };

  // Parse monthlyUsage mapValue
  if (fields.monthlyUsage?.mapValue?.fields) {
    var mapFields = fields.monthlyUsage.mapValue.fields;
    for (var key in mapFields) {
      if (mapFields.hasOwnProperty(key)) {
        result.monthlyUsage[key] = parseInt(mapFields[key].integerValue || '0', 10);
      }
    }
  }

  return result;
}

/**
 * Calculate the current billing window key (YYYY-MM) from anchor date.
 * If anchor day > current day, window starts previous month.
 * @param {string} billingAnchorDate - ISO timestamp
 * @returns {string} YYYY-MM key
 */
function getCurrentWindowKey(billingAnchorDate) {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth(); // 0-indexed

  if (billingAnchorDate) {
    var anchor = new Date(billingAnchorDate);
    var anchorDay = anchor.getDate();

    // If we haven't reached the anchor day yet this month, the window started last month
    if (now.getDate() < anchorDay) {
      month -= 1;
      if (month < 0) {
        month = 11;
        year -= 1;
      }
    }
  }

  var monthStr = String(month + 1).padStart(2, '0');
  return year + '-' + monthStr;
}

/**
 * Check whether the user is allowed to use a pro feature.
 * @param {string} idToken
 * @param {string} firebaseUid
 * @param {string} userTier - 'free', 'paid', 'paid2', 'paid3'
 * @returns {Promise<{allowed: boolean, tier?: string, limit?: number, used?: number, upgradeUrl?: string|null}>}
 */
async function checkUsageAllowed(idToken, firebaseUid, userTier) {
  var tierConfig = USAGE_TIERS[userTier] || USAGE_TIERS.free;
  var usageDoc = await getUsageDoc(idToken, firebaseUid);

  var used, limit;
  limit = tierConfig.limit;

  if (!tierConfig.monthly) {
    // Free tier: lifetime count
    used = usageDoc.lifetimeFreeUsed;
  } else {
    // Paid tiers: monthly count
    var windowKey = getCurrentWindowKey(usageDoc.billingAnchorDate);
    used = usageDoc.monthlyUsage[windowKey] || 0;
  }

  if (used >= limit) {
    return {
      allowed: false,
      tier: userTier,
      limit: limit,
      used: used,
      upgradeUrl: UPGRADE_URLS[userTier] !== undefined ? UPGRADE_URLS[userTier] : null,
    };
  }

  return { allowed: true };
}

/**
 * Increment usage after a pro feature succeeds.
 * Free: increments lifetimeFreeUsed. Paid: increments monthlyUsage[currentWindowKey].
 * @param {string} idToken
 * @param {string} firebaseUid
 * @param {string} userTier
 * @returns {Promise<void>}
 */
async function incrementUsage(idToken, firebaseUid, userTier) {
  var tierConfig = USAGE_TIERS[userTier] || USAGE_TIERS.free;
  var usageDoc = await getUsageDoc(idToken, firebaseUid);

  var baseUrl = 'https://firestore.googleapis.com/v1/projects/' + USAGE_PROJECT_ID +
    '/databases/(default)/documents/users/' + firebaseUid;

  if (!tierConfig.monthly) {
    // Free tier: increment lifetimeFreeUsed
    var newCount = usageDoc.lifetimeFreeUsed + 1;
    var url = baseUrl + '?updateMask.fieldPaths=lifetimeFreeUsed';

    await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + idToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          lifetimeFreeUsed: { integerValue: String(newCount) },
        },
      }),
    });
  } else {
    // Paid tier: increment monthlyUsage[windowKey]
    var windowKey = getCurrentWindowKey(usageDoc.billingAnchorDate);
    var currentCount = usageDoc.monthlyUsage[windowKey] || 0;
    var newMonthlyCount = currentCount + 1;

    // Build the full monthlyUsage map with updated value
    var mapFields = {};
    for (var k in usageDoc.monthlyUsage) {
      if (usageDoc.monthlyUsage.hasOwnProperty(k)) {
        mapFields[k] = { integerValue: String(usageDoc.monthlyUsage[k]) };
      }
    }
    mapFields[windowKey] = { integerValue: String(newMonthlyCount) };

    var paidUrl = baseUrl + '?updateMask.fieldPaths=monthlyUsage';

    await fetch(paidUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + idToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          monthlyUsage: {
            mapValue: { fields: mapFields },
          },
        },
      }),
    });
  }
}

/**
 * Get monthly usage history map for display.
 * @param {string} idToken
 * @param {string} firebaseUid
 * @returns {Promise<Object>} monthlyUsage map { 'YYYY-MM': count }
 */
async function getUsageHistory(idToken, firebaseUid) {
  var usageDoc = await getUsageDoc(idToken, firebaseUid);
  return usageDoc.monthlyUsage;
}

/**
 * Get current usage summary for display.
 * @param {string} idToken
 * @param {string} firebaseUid
 * @param {string} userTier
 * @returns {Promise<{used: number, limit: number, tier: string, isLifetime: boolean}>}
 */
async function getCurrentUsageSummary(idToken, firebaseUid, userTier) {
  var tierConfig = USAGE_TIERS[userTier] || USAGE_TIERS.free;
  var usageDoc = await getUsageDoc(idToken, firebaseUid);

  var used;
  if (!tierConfig.monthly) {
    used = usageDoc.lifetimeFreeUsed;
  } else {
    var windowKey = getCurrentWindowKey(usageDoc.billingAnchorDate);
    used = usageDoc.monthlyUsage[windowKey] || 0;
  }

  return {
    used: used,
    limit: tierConfig.limit,
    tier: userTier,
    tierLabel: tierConfig.label,
    isLifetime: !tierConfig.monthly,
  };
}
