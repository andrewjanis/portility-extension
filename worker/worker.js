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

      // Determine tier from Stripe metadata (defaults to 'paid' for backwards compat)
      const tierValue = session.metadata.tier || 'paid';

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

      // Set billingAnchorDate if not already present
      try {
        const userDoc = await fetch(userDocUrl + '?mask.fieldPaths=billingAnchorDate', {
          headers: { 'Authorization': 'Bearer ' + accessToken },
        }).then(r => r.json());

        if (!userDoc.fields?.billingAnchorDate) {
          await fetch(userDocUrl + '?updateMask.fieldPaths=billingAnchorDate', {
            method: 'PATCH',
            headers: {
              'Authorization': 'Bearer ' + accessToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              fields: { billingAnchorDate: { timestampValue: new Date().toISOString() } },
            }),
          });
        }
      } catch (anchorErr) {
        console.error('[Webhook] billingAnchorDate write failed:', anchorErr.message);
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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Portility-Distinct-Id',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    var url = new URL(request.url);
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

  var userContent = 'Here is the conversation to analyze:\n\n' + conversation;
  if (assets.length > 0) {
    userContent += '\n\nHere are the assets detected in the conversation DOM:\n' +
      JSON.stringify(assets, null, 2);
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
      system: systemPrompt,
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

  var distinctId = request.headers.get('X-Portility-Distinct-Id') || 'worker-anonymous';
  var startTime = Date.now();
  var response, data, text;

  // Platform pairing: Claude→ChatGPT, ChatGPT→Claude, Gemini→ChatGPT
  if (platform === 'chatgpt') {
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
        system: systemPrompt,
        messages: [
          { role: 'user', content: 'Here is the project brief to review:\n\n' + brief },
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
          { role: 'user', content: 'Here is the project brief to review:\n\n' + brief },
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
    'Judge only on accuracy, completeness, and logical consistency. ' +
    'Do not consider tone, style, or formatting. ' +
    'Return JSON only — no preamble, no markdown, no explanation outside the JSON object.\n\n' +
    'Return this exact JSON structure:\n' +
    '{\n' +
    '  "question_type": "factual" | "subjective" | "analytical",\n' +
    '  "agreement_score": <integer 0-100>,\n' +
    '  "agreements": ["<string>", "<string>", "<string>"],\n' +
    '  "divergences": ["<string>", "<string>", "<string>"],\n' +
    '  "interpretation": "<one sentence: what the score means given the question type>"\n' +
    '}\n\n' +
    'Rules:\n' +
    '- agreement_score: 0 = complete disagreement, 100 = perfect alignment\n' +
    '- Provide EXACTLY 3 agreements and 3 divergences\n' +
    '- Each agreement/divergence should be 1-2 concise sentences';

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
      system: systemPrompt,
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
