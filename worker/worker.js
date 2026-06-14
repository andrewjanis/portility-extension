import Stripe from 'stripe';

/**
 * Portility — Cloudflare Worker proxy
 * Hides API keys from the Chrome extension.
 *
 * Endpoints:
 *   POST /moderate      — forwards to OpenAI Moderation API
 *   POST /summarize     — forwards to Anthropic Claude API (Haiku, basic summary)
 *   POST /summarize-pro — forwards to Anthropic Claude API (Sonnet, project brief + asset catalog)
 *
 * Environment variables (set as secrets in Cloudflare dashboard):
 *   OPENAI_API_KEY        — your OpenAI API key
 *   ANTHROPIC_API_KEY     — your Anthropic API key
 *   STRIPE_SECRET_KEY     — Stripe secret key (sk_...)
 *   STRIPE_WEBHOOK_SECRET — Stripe webhook signing secret (whsec_...)
 *   FIREBASE_PROJECT_ID   — Firebase project ID (e.g. 'portility')
 *   FIREBASE_SA_EMAIL     — Service account client_email from JSON key
 *   FIREBASE_SA_KEY       — Service account private_key from JSON key (PEM format)
 */

// ─── PostHog LLM generation tracking ────────────────────────────────────────
function trackLLMGeneration(env, distinctId, params) {
  if (!env.POSTHOG_API_KEY) return;
  var inputTruncated = params.input;
  if (Array.isArray(inputTruncated)) {
    inputTruncated = inputTruncated.map(function (msg) {
      return { role: msg.role, content: typeof msg.content === 'string' ? msg.content.substring(0, 500) : msg.content };
    });
  }
  fetch('https://app.posthog.com/capture/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.POSTHOG_API_KEY,
      event: '$ai_generation',
      distinct_id: distinctId || 'worker-anonymous',
      properties: {
        $ai_model: params.model,
        $ai_provider: params.provider,
        $ai_input_tokens: params.inputTokens,
        $ai_output_tokens: params.outputTokens,
        $ai_latency: params.latencyMs,
        $ai_http_status: params.httpStatus,
        $ai_input: inputTruncated,
        $ai_output_choices: params.outputText ? [{ content: params.outputText }] : [],
        $ai_base_url: params.provider === 'anthropic'
          ? 'https://api.anthropic.com' : 'https://api.openai.com',
        $lib: 'portility-worker',
      },
      timestamp: new Date().toISOString(),
    }),
  }).catch(function () {});
}

// ─── Token usage extraction ──────────────────────────────────────────────────
function extractUsage(data, provider, model) {
  if (provider === 'anthropic' && data.usage) {
    return {
      provider: 'anthropic',
      model: model,
      input_tokens: data.usage.input_tokens || 0,
      output_tokens: data.usage.output_tokens || 0,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
    };
  }
  if (provider === 'openai' && data.usage) {
    return {
      provider: 'openai',
      model: model,
      input_tokens: data.usage.prompt_tokens || 0,
      output_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0,
    };
  }
  return null;
}

// ─── Google Service Account JWT → Access Token ──────────────────────────────
async function getFirebaseAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.FIREBASE_SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signingInput = enc(header) + '.' + enc(payload);

  // Import the PEM private key
  const pemBody = env.FIREBASE_SA_KEY
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );

  // Sign the JWT
  const sigBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = signingInput + '.' + signature;

  // Exchange JWT for access token
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    throw new Error('Failed to get Firebase access token: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

// ─── Firebase ID Token verification ─────────────────────────────────────────
async function verifyFirebaseIdToken(idToken, firebaseApiKey) {
  var resp = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + firebaseApiKey,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: idToken }) }
  );
  if (!resp.ok) {
    var errBody = await resp.json().catch(function () { return {}; });
    var errMsg = (errBody.error && errBody.error.message) ? errBody.error.message : ('HTTP ' + resp.status);
    throw new Error('Firebase token verification failed: ' + errMsg);
  }
  var data = await resp.json();
  if (!data.users || !data.users.length) throw new Error('No user found');
  return data.users[0].localId;
}

// ─── Usage tiers ────────────────────────────────────────────────────────────
var USAGE_TIERS = {
  free:  { limit: Infinity, monthly: false },
  paid:  { limit: 50, monthly: true },
  paid2: { limit: 150, monthly: true },
  paid3: { limit: Infinity, monthly: true },
};
var UPGRADE_URLS = {
  free:  'https://www.portility.ai/pricing',
  paid:  'https://www.portility.ai/pricing',
  paid2: 'https://www.portility.ai/pricing',
  paid3: null,
};

// Stripe Price ID → tier mapping
var PRICE_TO_TIER = {
  'price_1TUBYrCJMK2eGD36aLlU5Z0a': 'paid',   // $5/month
  'price_1TUBbZCJMK2eGD36B3lhLzFk': 'paid',   // $50/year
  'price_1TX0AoCJMK2eGD36UBbK3WFD': 'paid2',  // $10/month
  'price_1TX0BGCJMK2eGD3656Rv2pOh': 'paid2',  // $100/year
  // paid3 (Unlimited) — add Stripe price IDs here when created
};

// Trial constants
var TRIAL_DURATION_DAYS = 7;
var TRIAL_USE_LIMIT = 50;
var FREE_FEATURES = ['port_my_chat', 'port_me'];
var ENTITLEMENT_MAP = {
  paid:  ['port_my_chat_pro', 'port_me_pro', 'second_opinion'],
  paid2: ['port_my_chat_pro', 'port_me_pro', 'second_opinion'],
  paid3: ['port_my_chat_pro', 'port_me_pro', 'second_opinion'],
};

// ─── JSON response helper ────────────────────────────────────────────────────
function jsonResponse(status, data, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
  });
}

// ─── Auth + user doc helper (shared by /authorize, /record-use, /use) ────────
async function authenticateAndReadUser(request, body, env) {
  var claimedUid = body.firebaseUid;
  if (!claimedUid) throw { status: 400, error: 'Missing firebaseUid' };

  var authHeader = request.headers.get('Authorization') || '';
  var idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) throw { status: 401, error: 'Missing Authorization header' };

  var verifiedUid;
  try {
    verifiedUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_API_KEY);
  } catch (e) {
    throw { status: 401, error: 'Invalid token: ' + e.message };
  }
  if (verifiedUid !== claimedUid) throw { status: 403, error: 'UID mismatch' };

  var accessToken = await getFirebaseAccessToken(env);
  var docUrl = 'https://firestore.googleapis.com/v1/projects/' +
    env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/users/' + claimedUid;

  var docResp = await fetch(docUrl, {
    headers: { 'Authorization': 'Bearer ' + accessToken },
  });

  var fields = {};
  if (docResp.ok) {
    var doc = await docResp.json();
    fields = doc.fields || {};
  }

  return { uid: claimedUid, accessToken: accessToken, docUrl: docUrl, fields: fields };
}

// ─── Firestore helpers for /use ─────────────────────────────────────────────
function computeWindowKey(billingAnchorDate) {
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

function migrateOldUsage(fields, tier, tierConfig) {
  if (!tierConfig.monthly) {
    // Free tier: read lifetimeFreeUsed
    return parseInt(fields.lifetimeFreeUsed?.integerValue || '0', 10);
  }
  // Paid tier: read monthlyUsage[windowKey]
  var anchorDate = fields.billingAnchorDate?.timestampValue || null;
  var windowKey = computeWindowKey(anchorDate);
  var mapFields = fields.monthlyUsage?.mapValue?.fields;
  if (mapFields && mapFields[windowKey]) {
    return parseInt(mapFields[windowKey].integerValue || '0', 10);
  }
  return 0;
}

async function firestorePatchFields(accessToken, docUrl, fieldsObj, fieldPaths) {
  var qs = fieldPaths.map(function (p) { return 'updateMask.fieldPaths=' + p; }).join('&');
  var resp = await fetch(docUrl + '?' + qs, {
    method: 'PATCH',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: fieldsObj }),
  });
  if (!resp.ok) {
    throw new Error('Firestore patch failed: ' + resp.status);
  }
  return resp.json();
}

function trackUsageEvent(env, distinctId, params) {
  if (!env.POSTHOG_API_KEY) return;
  fetch('https://app.posthog.com/capture/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.POSTHOG_API_KEY,
      event: 'pro_feature_used',
      distinct_id: distinctId || 'worker-anonymous',
      properties: {
        feature: params.feature,
        tier: params.tier,
        tier_class: params.tier_class,
        used: params.used,
        limit: params.limit,
        $lib: 'portility-worker',
      },
      timestamp: new Date().toISOString(),
    }),
  }).catch(function () {});
}

// ─── POST /use — atomic usage check + increment ────────────────────────────
async function handleUse(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  var body;
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var claimedUid = body.firebaseUid;
  var feature = body.feature || 'unknown';

  if (!claimedUid) {
    return new Response(JSON.stringify({ error: 'Missing firebaseUid' }), {
      status: 400, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  // Verify Firebase ID token
  var authHeader = request.headers.get('Authorization') || '';
  var idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var verifiedUid;
  try {
    verifiedUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_API_KEY);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid token: ' + e.message }), {
      status: 401, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  if (verifiedUid !== claimedUid) {
    return new Response(JSON.stringify({ error: 'UID mismatch' }), {
      status: 403, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  // Get service account access token
  var accessToken = await getFirebaseAccessToken(env);
  var docUrl = 'https://firestore.googleapis.com/v1/projects/' +
    env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/users/' + claimedUid;

  // Read user doc
  var docResp = await fetch(docUrl, {
    headers: { 'Authorization': 'Bearer ' + accessToken },
  });

  var fields = {};
  if (docResp.ok) {
    var doc = await docResp.json();
    fields = doc.fields || {};
  }

  var tier = fields.tier?.stringValue || 'free';
  // Allow client-side dev tier override for testing (block paid3)
  if (body.tierOverride && USAGE_TIERS[body.tierOverride] && body.tierOverride !== 'paid3') {
    tier = body.tierOverride;
  }
  var tierConfig = USAGE_TIERS[tier] || USAGE_TIERS.free;
  var limit = tierConfig.limit;

  // Determine current usage_count — with lazy migration from old schema
  var usageCount;
  var needsMigration = false;

  if (fields.usage_count !== undefined) {
    usageCount = parseInt(fields.usage_count.integerValue || '0', 10);
  } else {
    // Old schema — migrate
    usageCount = migrateOldUsage(fields, tier, tierConfig);
    needsMigration = true;
  }

  // Check reset_date for paid tiers
  var resetDate = fields.reset_date?.timestampValue || null;
  var now = new Date();

  if (tierConfig.monthly && resetDate && now > new Date(resetDate)) {
    // Billing cycle has passed — reset
    usageCount = 0;
    // Write reset immediately (reset_date will be updated by next invoice.paid webhook)
    await firestorePatchFields(accessToken, docUrl, {
      usage_count: { integerValue: '0' },
    }, ['usage_count']);
  }

  // Check limit
  if (usageCount >= limit) {
    return new Response(JSON.stringify({
      allowed: false,
      used: usageCount,
      limit: limit,
      tier: tier,
      upgradeUrl: UPGRADE_URLS[tier] !== undefined ? UPGRADE_URLS[tier] : null,
    }), {
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  // Atomic increment via Firestore commit with fieldTransforms
  var commitUrl = 'https://firestore.googleapis.com/v1/projects/' +
    env.FIREBASE_PROJECT_ID + '/databases/(default)/documents:commit';

  var tierClass = tier === 'free' ? 'free' : 'paid';

  var commitBody = {
    writes: [
      {
        transform: {
          document: 'projects/' + env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/users/' + claimedUid,
          fieldTransforms: [
            { fieldPath: 'usage_count', increment: { integerValue: '1' } },
            { fieldPath: 'lifetime_total', increment: { integerValue: '1' } },
          ],
        },
      },
      {
        update: {
          name: 'projects/' + env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/stats/global',
          fields: {},
        },
        updateMask: { fieldPaths: [] },
        updateTransforms: [
          { fieldPath: 'total_ports', increment: { integerValue: '1' } },
          { fieldPath: tierClass === 'free' ? 'total_free_ports' : 'total_paid_ports', increment: { integerValue: '1' } },
        ],
      },
    ],
  };

  var commitResp = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commitBody),
  });

  if (!commitResp.ok) {
    var errText = await commitResp.text();
    return new Response(JSON.stringify({ error: 'Increment failed: ' + errText }), {
      status: 500, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var newUsed = usageCount + 1;

  // If migrating, also write the usage_count baseline and reset_date
  if (needsMigration) {
    var migrateFields = {
      usage_count: { integerValue: String(newUsed) },
      lifetime_total: { integerValue: String(newUsed) },
    };
    var migratePaths = ['usage_count', 'lifetime_total'];
    if (tierConfig.monthly && !resetDate) {
      // Set a reset_date from billingAnchorDate if available, otherwise leave null
      var anchorTs = fields.billingAnchorDate?.timestampValue;
      if (anchorTs) {
        // Calculate next reset: anchor day in the next month
        var anchor = new Date(anchorTs);
        var nextReset = new Date(now.getFullYear(), now.getMonth() + 1, anchor.getDate());
        if (nextReset <= now) nextReset.setMonth(nextReset.getMonth() + 1);
        migrateFields.reset_date = { timestampValue: nextReset.toISOString() };
        migratePaths.push('reset_date');
      }
    }
    await firestorePatchFields(accessToken, docUrl, migrateFields, migratePaths).catch(function () {});
  }

  // 80% warning
  var warning = null;
  if (newUsed >= limit * 0.8) {
    warning = {
      message: 'You\'ve used ' + newUsed + ' of ' + limit + ' uses' + (tierConfig.monthly ? ' this month.' : '.'),
      used: newUsed,
      limit: limit,
      tier: tier,
    };
  }

  // Fire PostHog event
  trackUsageEvent(env, claimedUid, { feature: feature, tier: tier, tier_class: tierClass, used: newUsed, limit: limit });

  return new Response(JSON.stringify({
    allowed: true,
    used: newUsed,
    limit: limit,
    tier: tier,
    warning: warning,
  }), {
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
  });
}

// ─── POST /reset-usage — reset usage_count without touching lifetime_total ──
async function handleResetUsage(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  var body;
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var claimedUid = body.firebaseUid;
  if (!claimedUid) {
    return new Response(JSON.stringify({ error: 'Missing firebaseUid' }), {
      status: 400, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var authHeader = request.headers.get('Authorization') || '';
  var idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var verifiedUid;
  try {
    verifiedUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_API_KEY);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid token: ' + e.message }), {
      status: 401, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  if (verifiedUid !== claimedUid) {
    return new Response(JSON.stringify({ error: 'UID mismatch' }), {
      status: 403, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var accessToken = await getFirebaseAccessToken(env);
  var docUrl = 'https://firestore.googleapis.com/v1/projects/' +
    env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/users/' + claimedUid;

  // Reset usage_count to 0
  await firestorePatchFields(accessToken, docUrl, {
    usage_count: { integerValue: '0' },
  }, ['usage_count']);

  // Read back lifetime_total
  var docResp = await fetch(docUrl, {
    headers: { 'Authorization': 'Bearer ' + accessToken },
  });
  var lifetimeTotal = 0;
  if (docResp.ok) {
    var doc = await docResp.json();
    lifetimeTotal = parseInt(doc.fields?.lifetime_total?.integerValue || '0', 10);
  }

  return new Response(JSON.stringify({
    success: true,
    lifetime_total: lifetimeTotal,
  }), {
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
  });
}

// ─── POST /authorize — check entitlement without incrementing ────────────────
async function handleAuthorize(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, corsHeaders);
  }

  var body;
  try { body = await request.json(); } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON' }, corsHeaders);
  }

  var feature = body.feature || 'unknown';

  // Free features: always allowed, no gating
  if (FREE_FEATURES.indexOf(feature) !== -1) {
    return jsonResponse(200, { allowed: true, gating: 'free_feature' }, corsHeaders);
  }

  // Authenticate and read user doc
  var user;
  try {
    user = await authenticateAndReadUser(request, body, env);
  } catch (err) {
    return jsonResponse(err.status || 500, { error: err.error || 'Auth failed' }, corsHeaders);
  }

  var tier = user.fields.tier?.stringValue || 'free';
  // Block paid3 from devTierOverride
  if (body.tierOverride && USAGE_TIERS[body.tierOverride] && body.tierOverride !== 'paid3') {
    tier = body.tierOverride;
  }
  var tierConfig = USAGE_TIERS[tier] || USAGE_TIERS.free;

  // ── Subscriber path ──
  if (tier !== 'free') {
    // Check entitlement
    var entitled = ENTITLEMENT_MAP[tier];
    if (entitled && entitled.indexOf(feature) === -1) {
      // Log but do not enforce — limits not surfaced to users
      return jsonResponse(200, { allowed: true, _would_block: 'not_entitled', tier: tier }, corsHeaders);
    }

    // Read usage_count with migration + reset logic
    var usageCount;
    if (user.fields.usage_count !== undefined) {
      usageCount = parseInt(user.fields.usage_count.integerValue || '0', 10);
    } else {
      usageCount = migrateOldUsage(user.fields, tier, tierConfig);
    }

    // Check reset_date
    var resetDate = user.fields.reset_date?.timestampValue || null;
    var now = new Date();
    if (tierConfig.monthly && resetDate && now > new Date(resetDate)) {
      usageCount = 0;
      await firestorePatchFields(user.accessToken, user.docUrl, {
        usage_count: { integerValue: '0' },
      }, ['usage_count']);
    }

    var limit = tierConfig.limit;
    // Log but do not enforce — limits not surfaced to users
    var _wouldBlock = usageCount >= limit ? 'limit_reached' : null;

    return jsonResponse(200, {
      allowed: true,
      gating: 'subscriber',
      used: usageCount,
      limit: limit,
      tier: tier,
      _would_block: _wouldBlock,
    }, corsHeaders);
  }

  // ── Trial path (tier === 'free') ──
  var trialStarted = user.fields.trial_started?.booleanValue || false;
  var trialStartAt = user.fields.trial_start_at?.timestampValue || null;
  var paidUseCount = parseInt(user.fields.paid_use_count?.integerValue || '0', 10);

  if (trialStarted) {
    var daysSinceStart = trialStartAt ? (Date.now() - new Date(trialStartAt).getTime()) / (1000 * 60 * 60 * 24) : TRIAL_DURATION_DAYS;
    var daysRemaining = Math.max(0, Math.ceil(TRIAL_DURATION_DAYS - daysSinceStart));
    var usesRemaining = Math.max(0, TRIAL_USE_LIMIT - paidUseCount);

    if (daysRemaining <= 0 || usesRemaining <= 0) {
      // Log but do not enforce — limits not surfaced to users
      return jsonResponse(200, {
        allowed: true,
        _would_block: 'trial_expired',
        tier: 'free',
        trial: {
          days_remaining: 0,
          uses_remaining: 0,
          paid_use_count: paidUseCount,
          started_at: trialStartAt,
        },
      }, corsHeaders);
    }

    return jsonResponse(200, {
      allowed: true,
      gating: 'trial',
      tier: 'free',
      trial: {
        days_remaining: daysRemaining,
        uses_remaining: usesRemaining,
        paid_use_count: paidUseCount,
        started_at: trialStartAt,
      },
    }, corsHeaders);
  }

  // Trial not started — start it now
  await firestorePatchFields(user.accessToken, user.docUrl, {
    trial_started: { booleanValue: true },
    trial_start_at: { timestampValue: new Date().toISOString() },
    paid_use_count: { integerValue: '0' },
  }, ['trial_started', 'trial_start_at', 'paid_use_count']);

  return jsonResponse(200, {
    allowed: true,
    gating: 'trial',
    tier: 'free',
    trial: {
      just_started: true,
      days_remaining: TRIAL_DURATION_DAYS,
      uses_remaining: TRIAL_USE_LIMIT,
      paid_use_count: 0,
    },
  }, corsHeaders);
}

// ─── POST /record-use — increment counters after successful completion ───────
async function handleRecordUse(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, corsHeaders);
  }

  var body;
  try { body = await request.json(); } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON' }, corsHeaders);
  }

  var feature = body.feature || 'unknown';

  // Free features don't record usage
  if (FREE_FEATURES.indexOf(feature) !== -1) {
    return jsonResponse(200, { recorded: true, gating: 'free_feature' }, corsHeaders);
  }

  var user;
  try {
    user = await authenticateAndReadUser(request, body, env);
  } catch (err) {
    return jsonResponse(err.status || 500, { error: err.error || 'Auth failed' }, corsHeaders);
  }

  var tier = user.fields.tier?.stringValue || 'free';
  // Block paid3 from devTierOverride
  if (body.tierOverride && USAGE_TIERS[body.tierOverride] && body.tierOverride !== 'paid3') {
    tier = body.tierOverride;
  }

  var commitUrl = 'https://firestore.googleapis.com/v1/projects/' +
    env.FIREBASE_PROJECT_ID + '/databases/(default)/documents:commit';

  var tierClass = tier === 'free' ? 'trial' : 'paid';
  var counterField = tier === 'free' ? 'paid_use_count' : 'usage_count';
  var globalField = tier === 'free' ? 'total_trial_ports' : 'total_paid_ports';

  var commitBody = {
    writes: [
      {
        transform: {
          document: 'projects/' + env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/users/' + user.uid,
          fieldTransforms: [
            { fieldPath: counterField, increment: { integerValue: '1' } },
            { fieldPath: 'lifetime_total', increment: { integerValue: '1' } },
          ],
        },
      },
      {
        update: {
          name: 'projects/' + env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/stats/global',
          fields: {},
        },
        updateMask: { fieldPaths: [] },
        updateTransforms: [
          { fieldPath: 'total_ports', increment: { integerValue: '1' } },
          { fieldPath: globalField, increment: { integerValue: '1' } },
        ],
      },
    ],
  };

  var commitResp = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + user.accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commitBody),
  });

  if (!commitResp.ok) {
    var errText = await commitResp.text();
    return jsonResponse(500, { error: 'Increment failed: ' + errText }, corsHeaders);
  }

  // Fire PostHog event
  trackUsageEvent(env, user.uid, { feature: feature, tier: tier, tier_class: tierClass, used: null, limit: null });

  return jsonResponse(200, { recorded: true }, corsHeaders);
}

// ─── POST /feedback — save Second Opinion feedback via service account ──────
async function handleFeedback(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  var body;
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  // Verify the user's token
  var authHeader = request.headers.get('Authorization') || '';
  var idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var verifiedUid;
  try {
    verifiedUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_API_KEY);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid token: ' + e.message }), {
      status: 401, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  // Write to Firestore using service account
  var accessToken = await getFirebaseAccessToken(env);
  var docId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  var docUrl = 'https://firestore.googleapis.com/v1/projects/' +
    env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/second_opinion_feedback/' + docId;

  var fields = {
    firebaseUid: { stringValue: verifiedUid },
    platform: { stringValue: body.platform || '' },
    comparisonModel: { stringValue: body.comparisonModel || '' },
    aiScore: { integerValue: String(body.aiScore || 0) },
    humanRating: { stringValue: body.humanRating || '' },
    humanReason: { stringValue: body.humanReason || '' },
    originalBrief: { stringValue: body.originalBrief || '' },
    secondOpinion: { stringValue: body.secondOpinion || '' },
    questionType: { stringValue: body.questionType || 'analytical' },
    createdAt: { timestampValue: new Date().toISOString() },
  };

  var resp = await fetch(docUrl, {
    method: 'PATCH',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: fields }),
  });

  if (!resp.ok) {
    var errText = await resp.text();
    return new Response(JSON.stringify({ error: 'Firestore write failed: ' + errText }), {
      status: resp.status, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
  });
}

async function handleStripeWebhook(request, env) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response('Webhook signature verification failed', { status: 400 });
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const firebaseUID = session.metadata.firebase_uid;
    if (firebaseUID) {
      // Get a fresh access token from service account
      const accessToken = await getFirebaseAccessToken(env);

      // Determine tier from subscription price ID, falling back to metadata
      var tierValue = session.metadata.tier || 'paid';
      if (session.subscription) {
        try {
          const subForTier = await stripe.subscriptions.retrieve(session.subscription, { expand: ['items.data.price'] });
          const priceId = subForTier.items && subForTier.items.data[0] && subForTier.items.data[0].price.id;
          if (priceId && PRICE_TO_TIER[priceId]) {
            tierValue = PRICE_TO_TIER[priceId];
          }
        } catch (e) {
          console.error('[Webhook] Price lookup failed:', e.message);
        }
      }

      // Write tier to Firestore via REST API
      const userDocUrl = 'https://firestore.googleapis.com/v1/projects/' +
        env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/users/' + firebaseUID;
      const firestoreResp = await fetch(userDocUrl + '?updateMask.fieldPaths=tier', {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: { tier: { stringValue: tierValue } },
        }),
      });
      if (!firestoreResp.ok) {
        console.error('[Webhook] Firestore tier write failed:', firestoreResp.status, await firestoreResp.text());
      }

      // Set reset_date + usage_count from Stripe subscription
      try {
        if (session.subscription) {
          // Copy firebase_uid onto the subscription so invoice.paid can find the user
          await stripe.subscriptions.update(session.subscription, {
            metadata: { firebase_uid: firebaseUID, tier: tierValue },
          });
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          const resetDate = new Date(sub.current_period_end * 1000).toISOString();
          await fetch(userDocUrl + '?updateMask.fieldPaths=reset_date&updateMask.fieldPaths=usage_count', {
            method: 'PATCH',
            headers: {
              'Authorization': 'Bearer ' + accessToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              fields: {
                reset_date: { timestampValue: resetDate },
                usage_count: { integerValue: '0' },
              },
            }),
          });
        }
      } catch (resetErr) {
        console.error('[Webhook] reset_date write failed:', resetErr.message);
      }
    }
  }

  // Handle invoice.paid — reset usage on billing cycle renewal
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object;
    const subscriptionId = invoice.subscription;
    if (subscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const firebaseUID = sub.metadata?.firebase_uid;
        if (firebaseUID) {
          const accessToken = await getFirebaseAccessToken(env);
          const userDocUrl = 'https://firestore.googleapis.com/v1/projects/' +
            env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/users/' + firebaseUID;
          const resetDate = new Date(sub.current_period_end * 1000).toISOString();
          await fetch(userDocUrl + '?updateMask.fieldPaths=reset_date&updateMask.fieldPaths=usage_count', {
            method: 'PATCH',
            headers: {
              'Authorization': 'Bearer ' + accessToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              fields: {
                reset_date: { timestampValue: resetDate },
                usage_count: { integerValue: '0' },
              },
            }),
          });
        }
      } catch (invoiceErr) {
        console.error('[Webhook] invoice.paid reset failed:', invoiceErr.message);
      }
    }
  }

  // Handle subscription cancellation — downgrade to free
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const firebaseUID = sub.metadata?.firebase_uid;
    if (firebaseUID) {
      try {
        const accessToken = await getFirebaseAccessToken(env);
        const userDocUrl = 'https://firestore.googleapis.com/v1/projects/' +
          env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/users/' + firebaseUID;
        await fetch(userDocUrl + '?updateMask.fieldPaths=tier&updateMask.fieldPaths=reset_date&updateMask.fieldPaths=usage_count', {
          method: 'PATCH',
          headers: {
            'Authorization': 'Bearer ' + accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fields: {
              tier: { stringValue: 'free' },
              reset_date: { nullValue: null },
              usage_count: { integerValue: '0' },
            },
          }),
        });
      } catch (cancelErr) {
        console.error('[Webhook] subscription.deleted handler failed:', cancelErr.message);
      }
    }
  }

  return new Response('Webhook received', { status: 200 });
}

export default {
  async fetch(request, env) {
    // CORS headers for Chrome extension
    var corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Portility-Distinct-Id, Authorization',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // GET /config — remote configuration (no auth required)
    var url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/config') {
      return handleConfig(corsHeaders);
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    var path = url.pathname;

    try {
      if (path === '/moderate') {
        return await handleModerate(request, env, corsHeaders);
      } else if (path === '/summarize') {
        return await handleSummarize(request, env, corsHeaders);
      } else if (path === '/summarize-pro') {
        return await handleSummarizePro(request, env, corsHeaders);
      } else if (path === '/second-opinion') {
        return await handleSecondOpinion(request, env, corsHeaders);
      } else if (path === '/compare') {
        return await handleCompare(request, env, corsHeaders);
      } else if (path === '/authorize') {
        return await handleAuthorize(request, env, corsHeaders);
      } else if (path === '/record-use') {
        return await handleRecordUse(request, env, corsHeaders);
      } else if (path === '/use') {
        return await handleUse(request, env, corsHeaders);
      } else if (path === '/reset-usage') {
        return await handleResetUsage(request, env, corsHeaders);
      } else if (path === '/feedback') {
        return await handleFeedback(request, env, corsHeaders);
      } else if (path === '/trainer-chat') {
        return await handleTrainerChat(request, env, corsHeaders);
      } else if (url.pathname === '/stripe-webhook' && request.method === 'POST') {
        return handleStripeWebhook(request, env);
      } else {
        return new Response('Not found', { status: 404, headers: corsHeaders });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message || 'Internal error' }), {
        status: 500,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
      });
    }
  },
};

async function handleTrainerChat(request, env, corsHeaders) {
  var body = await request.json();
  var model = body.model || 'claude-sonnet-4-20250514';
  var messages = body.messages || [];
  var system = body.system || undefined;
  var maxTokens = body.max_tokens || 1000;

  if (!messages.length) {
    return new Response(JSON.stringify({ error: 'No messages provided' }), {
      status: 400,
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var payload = { model: model, max_tokens: maxTokens, messages: messages };
  if (system) payload.system = system;

  var response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });

  var data = await response.json();
  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
  });
}

function handleConfig(corsHeaders) {
  var config = {
    configVersion: 1,

    selectors: {
      claude: {
        humanSelectors: [
          '[data-testid="user-message"]',
          '[data-testid="human-turn"]',
          '[class*="human-turn"]',
          '[class*="HumanTurn"]',
        ],
        aiClassFragment: 'font-claude-response',
        inputSelectors: [
          'div.ProseMirror[contenteditable="true"]',
          'div[contenteditable="true"]',
          'textarea',
        ],
        attachSelectors: [
          'button[aria-label="Attach files"]',
          'button[data-testid="file-upload"]',
          '[aria-label="Upload content"]',
        ],
        sendSelectors: [
          'button[aria-label="Send Message"]',
          'button[aria-label="Send message"]',
          'fieldset button[type="button"]:last-child',
          'button[data-testid="send-button"]',
        ],
      },

      chatgpt: {
        humanSelector: '[data-message-author-role="user"]',
        aiSelector: '[data-message-author-role="assistant"]',
        inputSelectors: [
          '#prompt-textarea',
          'div[contenteditable="true"]',
          'textarea',
        ],
        attachSelectors: [
          'button[aria-label="Attach files"]',
          '[data-testid="composer-attach-button"]',
          'button[aria-label="Upload file"]',
        ],
        sendSelectors: [
          'button[data-testid="send-button"]',
          'button[aria-label="Send prompt"]',
          'button[aria-label="Send"]',
        ],
        submitDelayMs: 1500,
        submitDelayWithImagesMs: 2500,
        pasteSettleMs: 800,
      },

      gemini: {
        humanSelectors: [
          '.user-query-text',
          '[data-turn-role="user"]',
          '.query-text',
          'user-query',
        ],
        aiSelectors: [
          '.model-response-text',
          '[data-turn-role="model"]',
          '.response-text',
          'model-response',
        ],
        inputSelectors: [
          '.ql-editor[contenteditable="true"]',
          'rich-textarea div[contenteditable="true"]',
          'div[contenteditable="true"]',
          'textarea',
        ],
        attachSelectors: [
          'button[aria-label="Upload file"]',
          'uploader-button button',
          '[aria-label="Add image"]',
        ],
        sendSelectors: [
          'button.send-button',
          'button[aria-label="Send message"]',
          'button[aria-label="Send Message"]',
          '.input-area button[mat-icon-button]',
        ],
      },
    },

    urls: {
      destinations: {
        claude: 'https://claude.ai/new',
        gemini: 'https://gemini.google.com/',
        chatgpt: 'https://chatgpt.com/',
      },
      featureRequest: 'https://docs.google.com/forms/d/e/1FAIpQLSeCMXd1I6-I0G0y3rl5C8a0Cl2qlrVXuwjtpa138eeaEnq_OQ/viewform?usp=dialog',
    },

    features: {
      pmcProEnabled: true,
      portProfileEnabled: true,
      secondOpinionEnabled: true,
      includeProfileDefault: true,
      textModeDefault: 'summary',
    },
  };

  return new Response(JSON.stringify(config), {
    status: 200,
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    }, corsHeaders),
  });
}

async function handleModerate(request, env, corsHeaders) {
  var body = await request.json();
  var text = body.input || body.text || '';

  if (!text) {
    return new Response(JSON.stringify({ error: 'No text provided' }), {
      status: 400,
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var response = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.OPENAI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: text }),
  });

  var data = await response.json();

  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
  });
}

async function handleSummarize(request, env, corsHeaders) {
  var body = await request.json();
  var text = body.text || '';

  if (!text) {
    return new Response(JSON.stringify({ error: 'No text provided' }), {
      status: 400,
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var distinctId = request.headers.get('X-Portility-Distinct-Id') || 'worker-anonymous';
  var startTime = Date.now();

  var response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: 'Please summarize the following conversation concisely, capturing the key topics, decisions, and context so it can be continued in a new chat:\n\n' + text,
        },
      ],
    }),
  });

  var data = await response.json();
  data._usage = extractUsage(data, 'anthropic', 'claude-3-haiku-20240307');

  trackLLMGeneration(env, distinctId, {
    model: 'claude-3-haiku-20240307',
    provider: 'anthropic',
    input: [{ role: 'user', content: text }],
    outputText: (data.content && data.content[0]) ? data.content[0].text : '',
    inputTokens: data.usage ? data.usage.input_tokens || 0 : 0,
    outputTokens: data.usage ? data.usage.output_tokens || 0 : 0,
    latencyMs: Date.now() - startTime,
    httpStatus: response.status,
  });

  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
  });
}

async function handleSummarizePro(request, env, corsHeaders) {
  var body = await request.json();
  var conversation = body.conversation || '';
  var assets = body.assets || [];
  var images = body.images || [];

  if (!conversation) {
    return new Response(JSON.stringify({ error: 'No conversation provided' }), {
      status: 400,
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var systemPrompt = 'You are a project analyst. Given a conversation between a human and an AI assistant, produce a structured project brief in JSON format.\n\n' +
    'Your response MUST be valid JSON (no markdown code fences) with this structure:\n' +
    '{\n' +
    '  "title": "Short project title",\n' +
    '  "brief": "Full markdown project brief. YOU decide the sections based on what is relevant to this particular conversation. Common sections include: Overview, Goals, Key Decisions, Technical Details, Current Status, Open Questions, Next Steps — but adapt freely. The brief should be detailed enough that another AI could pick up the project seamlessly.",\n' +
    '  "assets": [\n' +
    '    {\n' +
    '      "id": "asset_0",\n' +
    '      "type": "image|file|artifact|code",\n' +
    '      "description": "What this asset is",\n' +
    '      "important": true,\n' +
    '      "reason": "Why this is or is not important for continuing the project",\n' +
    '      "sourceRef": "Reference to where in conversation this appeared"\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'Guidelines:\n' +
    '- The brief should be a curated project document, NOT a conversation dump\n' +
    '- Identify all files, images, code artifacts, and other assets mentioned or shared in the conversation\n' +
    '- Flag each asset as important (true) or not (false) based on whether it would be needed to continue the project\n' +
    '- Provide a clear reason for each importance flag\n' +
    '- The brief markdown should stand alone as a useful project document\n' +
    '- If no assets are detected, return an empty assets array';

  // Truncate long conversations: keep first 40% + last 40%, drop middle
  var maxChars = 180000;
  if (conversation.length > maxChars) {
    var keepStart = Math.floor(maxChars * 0.4);
    var keepEnd = Math.floor(maxChars * 0.4);
    conversation = conversation.substring(0, keepStart) +
      '\n\n[... middle of conversation truncated for length ...]\n\n' +
      conversation.substring(conversation.length - keepEnd);
  }

  var userText = 'Here is the conversation to analyze:\n\n' + conversation;
  if (assets.length > 0) {
    userText += '\n\nHere are the assets detected in the conversation DOM:\n' +
      JSON.stringify(assets, null, 2);
  }

  // Build user content: multi-modal array when images present, plain string otherwise
  var userContent;
  if (images.length > 0) {
    userContent = [{ type: 'text', text: userText }];
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      var match = (img.dataUrl || '').match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) continue;
      var label = img.filename || img.alt || ('Image ' + (i + 1));
      userContent.push({ type: 'text', text: '\n[Image: ' + label + ']' });
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] },
      });
    }
  } else {
    userContent = userText;
  }

  var distinctId = request.headers.get('X-Portility-Distinct-Id') || 'worker-anonymous';
  var startTime = Date.now();

  var response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: userContent },
      ],
    }),
  });

  var data = await response.json();
  data._usage = extractUsage(data, 'anthropic', 'claude-sonnet-4-20250514');

  trackLLMGeneration(env, distinctId, {
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    input: [{ role: 'user', content: userContent }],
    outputText: (data.content && data.content[0]) ? data.content[0].text : '',
    inputTokens: data.usage ? data.usage.input_tokens || 0 : 0,
    outputTokens: data.usage ? data.usage.output_tokens || 0 : 0,
    latencyMs: Date.now() - startTime,
    httpStatus: response.status,
  });

  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
  });
}

async function handleSecondOpinion(request, env, corsHeaders) {
  var body = await request.json();
  var brief = body.brief || '';
  var platform = body.platform || '';
  var images = body.images || [];

  if (!brief) {
    return new Response(JSON.stringify({ error: 'No brief provided' }), {
      status: 400,
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  // Truncate long briefs: keep first 40% + last 40%, drop middle
  var maxChars = 180000;
  if (brief.length > maxChars) {
    var keepStart = Math.floor(maxChars * 0.4);
    var keepEnd = Math.floor(maxChars * 0.4);
    brief = brief.substring(0, keepStart) +
      '\n\n[... middle of brief truncated for length ...]\n\n' +
      brief.substring(brief.length - keepEnd);
  }

  var systemPrompt = 'You are reviewing a project brief generated from a conversation on a different AI platform. Analyze independently: soundness of conclusions, risks/gaps/blind spots, alternative approaches, priority assessment.';

  var briefText = 'Here is the project brief to review:\n\n' + brief;

  var distinctId = request.headers.get('X-Portility-Distinct-Id') || 'worker-anonymous';
  var startTime = Date.now();
  var response, data, text;

  // Platform pairing: Claude→ChatGPT, ChatGPT→Claude, Gemini→ChatGPT
  if (platform === 'chatgpt') {
    // Build Anthropic user content: multi-modal when images present
    var anthropicContent;
    if (images.length > 0) {
      anthropicContent = [{ type: 'text', text: briefText }];
      for (var ai = 0; ai < images.length; ai++) {
        var aImg = images[ai];
        var aMatch = (aImg.dataUrl || '').match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!aMatch) continue;
        var aLabel = aImg.filename || aImg.alt || ('Image ' + (ai + 1));
        anthropicContent.push({ type: 'text', text: '\n[Image: ' + aLabel + ']' });
        anthropicContent.push({
          type: 'image',
          source: { type: 'base64', media_type: aMatch[1], data: aMatch[2] },
        });
      }
    } else {
      anthropicContent = briefText;
    }

    // Call Anthropic Claude
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [
          { role: 'user', content: anthropicContent },
        ],
      }),
    });

    data = await response.json();
    if (!response.ok) {
      return new Response(JSON.stringify({ error: 'Anthropic API error: ' + ((data.error && data.error.message) || response.status) }), {
        status: response.status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
      });
    }

    text = (data.content && data.content[0]) ? data.content[0].text : '';
    trackLLMGeneration(env, distinctId, {
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      input: [{ role: 'user', content: brief }],
      outputText: text,
      inputTokens: data.usage ? data.usage.input_tokens || 0 : 0,
      outputTokens: data.usage ? data.usage.output_tokens || 0 : 0,
      latencyMs: Date.now() - startTime,
      httpStatus: response.status,
    });
    return new Response(JSON.stringify({ text: text, source: 'claude', _usage: extractUsage(data, 'anthropic', 'claude-sonnet-4-20250514') }), {
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });

  } else {
    // Build OpenAI user content: multi-modal when images present
    var openaiContent;
    if (images.length > 0) {
      openaiContent = [{ type: 'text', text: briefText }];
      for (var oi = 0; oi < images.length; oi++) {
        var oImg = images[oi];
        if (!oImg.dataUrl || !(/^data:image\//i.test(oImg.dataUrl))) continue;
        var oLabel = oImg.filename || oImg.alt || ('Image ' + (oi + 1));
        openaiContent.push({ type: 'text', text: '\n[Image: ' + oLabel + ']' });
        openaiContent.push({
          type: 'image_url',
          image_url: { url: oImg.dataUrl, detail: 'auto' },
        });
      }
    } else {
      openaiContent = briefText;
    }

    // claude or gemini → call OpenAI ChatGPT
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.OPENAI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: openaiContent },
        ],
      }),
    });

    data = await response.json();
    if (!response.ok) {
      return new Response(JSON.stringify({ error: 'OpenAI API error: ' + ((data.error && data.error.message) || response.status) }), {
        status: response.status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
      });
    }

    text = (data.choices && data.choices[0]) ? data.choices[0].message.content : '';
    trackLLMGeneration(env, distinctId, {
      model: 'gpt-4o',
      provider: 'openai',
      input: [{ role: 'user', content: brief }],
      outputText: text,
      inputTokens: data.usage ? data.usage.prompt_tokens || 0 : 0,
      outputTokens: data.usage ? data.usage.completion_tokens || 0 : 0,
      latencyMs: Date.now() - startTime,
      httpStatus: response.status,
    });
    return new Response(JSON.stringify({ text: text, source: 'chatgpt', _usage: extractUsage(data, 'openai', 'gpt-4o') }), {
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }
}

async function handleCompare(request, env, corsHeaders) {
  var body = await request.json();
  var original = body.original || '';
  var secondOpinion = body.secondOpinion || '';

  if (!original || !secondOpinion) {
    return new Response(JSON.stringify({ error: 'Both original and secondOpinion are required' }), {
      status: 400,
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var distinctId = request.headers.get('X-Portility-Distinct-Id') || 'worker-anonymous';
  var startTime = Date.now();

  var systemPrompt = 'You are a neutral evaluator comparing two AI responses to the same question. ' +
    'Judge only on substantive content — accuracy, completeness, and logical consistency. ' +
    'Do not consider tone, style, formatting, or how information is presented. ' +
    'Return JSON only — no preamble, no markdown, no explanation outside the JSON object.\n\n' +
    'EXCLUSION RULE: Do not include any agreement or divergence item that describes:\n' +
    '- How a response is structured or organised\n' +
    '- How comprehensive or detailed a response is\n' +
    '- Whether a response offers the user a choice or a single path forward\n' +
    '- Tone, style, or language approach\n' +
    '- Any observation about what "both responses do" rather than what they conclude\n' +
    'Only include items where the models take a position on a factual claim, a diagnosis, a recommendation, a risk assessment, or an analytical conclusion — and either agree or disagree on that position.\n\n' +
    'TITLE RULE: Titles must name the factual or analytical point directly. ' +
    'Never begin a title with "Both responses", "Both models", "Each response", or any phrase that describes the AI outputs. ' +
    'The title should read like a topic heading for the underlying claim.\n' +
    'CORRECT: "Keypad membrane failure cause" / "DIY repair cost estimate" / "Warranty claim eligibility"\n' +
    'INCORRECT: "Both responses identify the error cause" / "Both models recommend the same repair"\n\n' +
    'Return this JSON structure:\n' +
    '{\n' +
    '  "question_type": "factual" | "subjective" | "analytical",\n' +
    '  "agreement_score": <integer 0-100>,\n' +
    '  "agreements": [\n' +
    '    {"title": "<2-5 word noun phrase naming the factual/analytical point>", "text": "<description of what both models agree on>"}\n' +
    '  ],\n' +
    '  "divergences": [\n' +
    '    {"title": "<2-5 word noun phrase naming the factual/analytical point>", "text": "<description of how the models differ>"}\n' +
    '  ],\n' +
    '  "interpretation": "<Lead with \'Key question: [the core question being asked].\' Then one sentence on whether the models agree or disagree on the answer to that specific question. Do not describe tone, style, or how information is presented.>"\n' +
    '}\n\n' +
    'Rules:\n' +
    '- agreement_score: 0 = complete disagreement, 100 = perfect alignment\n' +
    '- "text" should be 1-2 sentences explaining the specific agreement or divergence\n\n' +
    'CRITICAL — Scoring calibration by question type:\n\n' +
    'FACTUAL questions: Score based on whether both responses state the same facts. ' +
    'If core facts match, score 90-100. If facts contradict, score accordingly.\n\n' +
    'ANALYTICAL questions: You MUST distinguish between TOPIC overlap and POSITION overlap. ' +
    'Both models discussing the same topic is NOT agreement — they must reach the same conclusion with compatible reasoning. ' +
    'Apply these thresholds strictly:\n' +
    '- 90-100: Models state the same conclusion with compatible supporting evidence. Rare for analytical questions.\n' +
    '- 70-89: Models reach similar conclusions but emphasize different evidence or frameworks. This should be the DEFAULT when both models address the topic competently.\n' +
    '- 50-69: Models address the question from different angles or frameworks, reaching compatible but non-identical conclusions.\n' +
    '- 30-49: Models reach different conclusions or prioritize fundamentally different considerations.\n' +
    '- 0-29: Models directly contradict each other.\n' +
    'Be especially skeptical of high-level synthesis or "key takeaways" sections — similar-sounding summaries often mask genuinely different underlying analyses. ' +
    'When two models both propose frameworks, check whether the frameworks lead to the same actionable conclusions, not just whether they sound similar.\n\n' +
    'SUBJECTIVE questions: When both models express the same sentiment or values using different words, ' +
    'credit that as agreement. Do not penalize stylistic differences on opinion-based content. ' +
    'If both models advocate the same position with compatible reasoning, score 85-100.\n\n' +
    'CALIBRATION EXAMPLES (human-validated correct scores):\n\n' +
    'FACTUAL — "Age requirements for House vs Senate": Both models stated identical core facts (25 and 30). Correct score: 100.\n' +
    'FACTUAL — "Joyce\'s Penelope episode technique": Both identified same technique and punctuation count; minor differences in supporting context. Correct score: 95.\n\n' +
    'ANALYTICAL — "Medical chest pain diagnostic approach": Models discussed same topic but disagreed on timing priority (simultaneous vs sequential). Discussing the same topic is NOT agreement — they must reach the same conclusion. AI overestimated agreement. Correct score: 74.\n' +
    'ANALYTICAL — "Quantum computing impact on cybersecurity": Models focused on fundamentally different technical factors (error correction thresholds vs quantum algorithms). AI overestimated agreement at 3/5; human corrected to 2/5. Correct score: 54.\n\n' +
    'SUBJECTIVE — "Unreliable narration effectiveness (subtle vs overt)": Both concluded each approach is effective for different reasons. Similar high-level sentiment but nuanced differences in supporting analysis. Correct score: 79.\n' +
    'SUBJECTIVE — "Philosophical exploration of free will": Both models advocated compatible positions with aligned reasoning and values. Correct score: 100.\n\n' +
    'Use these examples to anchor your scoring. When you see a similar pattern, align your score with the corresponding example range.';

  var userContent = 'Response A (original):\n\n' + original + '\n\n---\n\nResponse B (second opinion):\n\n' + secondOpinion;

  var response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
    }),
  });

  var data = await response.json();
  if (!response.ok) {
    return new Response(JSON.stringify({ error: 'Comparison failed: ' + ((data.error && data.error.message) || response.status) }), {
      status: response.status,
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  var contentText = (data.content && data.content[0]) ? data.content[0].text : '';

  // Parse JSON from response (strip code fences if present)
  var parsed;
  try {
    var jsonStr = contentText;
    var codeBlockMatch = contentText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1];
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Failed to parse comparison result' }), {
      status: 500,
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    });
  }

  parsed._usage = extractUsage(data, 'anthropic', 'claude-sonnet-4-20250514');

  trackLLMGeneration(env, distinctId, {
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    input: [{ role: 'user', content: userContent }],
    outputText: contentText,
    inputTokens: data.usage ? data.usage.input_tokens || 0 : 0,
    outputTokens: data.usage ? data.usage.output_tokens || 0 : 0,
    latencyMs: Date.now() - startTime,
    httpStatus: response.status,
  });

  return new Response(JSON.stringify(parsed), {
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
  });
}
