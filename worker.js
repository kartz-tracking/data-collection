/**
 * Kartz key holder — a Cloudflare Worker that keeps the Ollama Cloud key off the page.
 *
 * A static site cannot hold a secret. Anything index.html sends, a viewer can read out of
 * the network tab in about ten seconds, so obfuscating the key in JavaScript buys nothing.
 * The only real fix is for the key to live somewhere the browser never sees, and for the
 * browser to talk to that instead. This Worker is that somewhere.
 *
 * The page posts the ordinary Gemini-shaped request body to POST /<model>. The Worker
 * translates it into Ollama's /api/chat format, adds the key, sends it to Ollama Cloud and
 * hands the answer back in the Gemini shape the page already parses. The page's model
 * fallback chain therefore keeps working unchanged.
 *
 * Normally this runs as part of the Cloudflare Pages deployment, mounted at /api by
 * functions/api/[[path]].js. In that arrangement the page and this code share an origin,
 * secrets come from the project's settings, and ALLOWED_ORIGINS can stay empty.
 *
 * It also stands alone as a plain Worker, for hosting the page somewhere else:
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler deploy
 *   3. wrangler secret put OLLAMA_API_KEY <- your key from ollama.com, at the prompt
 *   4. wrangler secret put SHARED_PASS    <- the phrase you give your officers
 *   5. Add the page's origin to ALLOWED_ORIGINS below, then deploy again.
 *
 * Either way the key only ever exists in Cloudflare.
 */

// Extra origins allowed to call this, for when the page is hosted somewhere else — GitHub
// Pages, say. Anything served from this same deployment is allowed automatically, so on
// Cloudflare Pages this list can stay empty.
const ALLOWED_ORIGINS = [
  'http://localhost:8731',
  'https://kartz-tracking.github.io',
  'https://data-collection.jk06nm04.workers.dev',
];

const OLLAMA_URL = 'https://ollama.com/api/chat';

// The rows the page expects back, enforced by Ollama's structured output rather than hoped for.
// Every field is a string for the same reason as on the page: a model asked for a number will
// sometimes answer "1,234" or "#4", and the page converts them itself.
const ROW_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      rank:        { type: 'string' },
      roster_name: { type: 'string' },
      seen:        { type: 'string' },
      points:      { type: 'string' },
    },
    required: ['rank', 'seen', 'points'],
  },
};

// Ollama Cloud speaks its own /api/chat dialect. The page always sends the Gemini request
// shape, so translate here in both directions, as runWorkersAI does below, rather than
// teaching the page another dialect.
async function runOllama(env, model, body) {
  const parts = body?.contents?.[0]?.parts || [];
  const text = parts.filter(p => p.text).map(p => p.text).join('\n');
  const images = parts.filter(p => p.inline_data).map(p => p.inline_data.data);   // raw base64
  const gc = body?.generationConfig || {};
  const r = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OLLAMA_API_KEY },
    body: JSON.stringify({
      model,
      stream: false,
      // Gemma 4 thinks by default, and on a request this size the thinking can eat the whole
      // output budget and minutes of time before a single row is written. Off.
      think: false,
      messages: [{ role: 'user', content: text, images }],
      format: ROW_SCHEMA,
      options: {
        temperature: gc.temperature ?? 0,
        seed: gc.seed ?? 7,
        num_predict: gc.maxOutputTokens ?? 32768,
      },
    }),
  });
  if (!r.ok) {
    const err = new Error(r.status + ': ' + (await r.text()).slice(0, 300));
    err.status = r.status;
    throw err;
  }
  const j = await r.json();
  // hand it back in the shape the page already parses, token count included so the page's
  // per-minute gate settles against what was really spent
  return {
    candidates: [{ content: { parts: [{ text: j.message?.content || '' }] } }],
    usageMetadata: { totalTokenCount: (j.prompt_eval_count || 0) + (j.eval_count || 0) },
  };
}

// Cloudflare's own models can be reached from inside a Worker through the AI binding.
// They are deliberately NOT reachable from the page: the Workers AI REST API answers a
// CORS preflight with 405 and sets no allow-origin header on the response either, so a
// static site cannot call it however the request is shaped. Running it here sidesteps that
// and keeps the account token out of the browser at the same time.
//
// The page always speaks the Gemini request shape, so translate in both directions rather
// than teaching the page a third dialect.
async function runWorkersAI(env, model, body) {
  if (!env.AI) throw new Error('This Worker has no AI binding. Add [ai]\nbinding = "AI" to wrangler.toml.');
  const parts = body?.contents?.[0]?.parts || [];
  const text = parts.filter(p => p.text).map(p => p.text).join('\n');
  const images = parts.filter(p => p.inline_data).map(p => p.inline_data.data);
  const content = [
    ...images.map(d => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + d } })),
    { type: 'text', text },
  ];
  const out = await env.AI.run(model, {
    messages: [{ role: 'user', content }],
    max_tokens: 4096,
    temperature: 0,
  });
  const reply = out?.response ?? out?.result?.response ?? out?.choices?.[0]?.message?.content ?? '';
  // hand it back in the shape the page already parses
  return { candidates: [{ content: { parts: [{ text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] } }] };
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-kartz-pass',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Anything that is not the API is the site itself. Static files are normally served
    // before this script ever runs; this covers the rest, so one deployment answers for
    // both halves and there is no second origin to authorise.
    if (!url.pathname.replace(/^\/+/, '').startsWith('api')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('No ASSETS binding: add [assets] to wrangler.toml.', { status: 500 });
    }

    const origin = request.headers.get('Origin') || '';
    // Same-origin covers the Cloudflare Pages deployment, where the page and this code are
    // one site and no cross-origin request happens at all.
    const knownOrigin = !!origin
      && (origin === new URL(request.url).origin || ALLOWED_ORIGINS.includes(origin));
    // A request with no Origin at all is not a browser — curl, or a script. Those are fine,
    // but only when they bring the shared phrase: otherwise an unconfigured deployment is
    // an open AI proxy for anyone who finds the URL. An origin header proves nothing on its
    // own (it is trivially forged), so the phrase is the real gate; this just means a
    // deployment with no phrase set is still not usable by strangers.
    const hasPass = !!env.SHARED_PASS && request.headers.get('x-kartz-pass') === env.SHARED_PASS;
    const allowed = knownOrigin || hasPass;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: allowed ? 204 : 403,
                                  headers: allowed ? corsHeaders(origin) : {} });
    }
    if (!allowed) return new Response('origin not allowed', { status: 403 });

    const cors = corsHeaders(origin);
    const reply = (body, status) => new Response(JSON.stringify(body),
      { status, headers: { ...cors, 'content-type': 'application/json' } });

    if (request.method !== 'POST') return reply({ error: 'POST only' }, 405);

    // No separate phrase check here. The gate above already decided: a request either came
    // from an origin this deployment recognises — the site itself — or it brought the shared
    // phrase. Demanding the phrase a second time would lock out the very page being served,
    // which no longer sends one.

    // Path is /<model>, or /api/<model> when mounted as a Pages Function.
    const model = decodeURIComponent(
      new URL(request.url).pathname.replace(/^\/+/, '').replace(/^api\/+/, ''));
    const isCf = model.startsWith('@cf/');
    // Ollama tags carry a colon (gemma4:31b), so it is allowed here.
    if (!(isCf ? /^@cf\/[a-zA-Z0-9._\/\-]{1,80}$/ : /^[a-zA-Z0-9.:\-]{1,64}$/).test(model))
      return reply({ error: { code: 400, message: 'Bad model name.' } }, 400);

    // Cloudflare's own models come from the binding, so no Ollama key is needed for those.
    if (!isCf && !env.OLLAMA_API_KEY)
      return reply({ error: { code: 500, message: 'Worker has no OLLAMA_API_KEY secret set.' } }, 500);

    // Frames are large; cap the body so a stray caller cannot post something enormous.
    const body = await request.text();
    if (body.length > 25 * 1024 * 1024)
      return reply({ error: { code: 413, message: 'Request too large.' } }, 413);

    if (isCf) {
      try {
        const out = await runWorkersAI(env, model, JSON.parse(body));
        return reply(out, 200);
      } catch (e) {
        // surface it as a normal upstream failure so the page's fallback logic still applies
        return reply({ error: { code: 502, message: String(e && e.message || e) } }, 502);
      }
    }

    try {
      return reply(await runOllama(env, model, JSON.parse(body)), 200);
    } catch (e) {
      // Pass the upstream status through: the page relies on seeing 429 and 503 so it can
      // wait or move down its fallback chain. Anything without one is a plain 502.
      const status = e && e.status || 502;
      return reply({ error: { code: status, message: String(e && e.message || e) } }, status);
    }
  },
};
