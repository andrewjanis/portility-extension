import Stripe from 'https://esm.sh/stripe@14';

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
 *   OPENAI_API_KEY   — your OpenAI API key
 *   ANTHROPIC_API_KEY — your Anthropic API key
 */

async function handleStripeWebhook(request, env) {
  const stripe = require('stripe')(env.STRIPE_SECRET_KEY);
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response('Webhook signature verification failed', { status: 400 });
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const firebaseUID = session.metadata.firebase_uid;
    if (firebaseUID) {
      const userRef = db.collection('users').doc(firebaseUID);
      await userRef.update({ tier: 'paid' });
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
      'Access-Control-Allow-Headers': 'Content-Type',
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
    return new Response(JSON.stringify({ text: text, source: 'claude' }), {
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
    return new Response(JSON.stringify({ text: text, source: 'chatgpt' }), {
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

  var systemPrompt = 'You are an expert analyst comparing two AI-generated reviews of the same project. ' +
    'Return ONLY valid JSON with no markdown code fences, no extra text. Use this exact structure:\n' +
    '{\n' +
    '  "agreement_score": <number 0-100>,\n' +
    '  "areas_of_agreement": [\n' +
    '    { "title": "Short title", "detail": "Explanation of what both AIs agree on" },\n' +
    '    { "title": "Short title", "detail": "..." },\n' +
    '    { "title": "Short title", "detail": "..." }\n' +
    '  ],\n' +
    '  "areas_of_disagreement": [\n' +
    '    { "title": "Short title", "detail": "Explanation of where the AIs differ" },\n' +
    '    { "title": "Short title", "detail": "..." },\n' +
    '    { "title": "Short title", "detail": "..." }\n' +
    '  ]\n' +
    '}\n\n' +
    'Rules:\n' +
    '- agreement_score: 0 = complete disagreement, 100 = perfect alignment\n' +
    '- Provide EXACTLY 3 areas_of_agreement and 3 areas_of_disagreement\n' +
    '- Each title should be concise (3-6 words)\n' +
    '- Each detail should be 1-2 sentences';

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
          content: 'ORIGINAL ANALYSIS:\n\n' + original + '\n\n---\n\nSECOND OPINION:\n\n' + secondOpinion,
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

  return new Response(JSON.stringify(parsed), {
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
  });
}
