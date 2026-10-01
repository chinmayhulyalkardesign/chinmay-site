const { SYSTEM } = require('./_system');

// The server owns everything that costs money: model, token cap, system prompt.
// The client may only send conversation messages.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const MAX_TOKENS = 500;
const UPSTREAM_TIMEOUT_MS = 25000;

const MAX_MESSAGES = 14;
const MAX_TEXT_CHARS = 2000;
const MAX_FILES = 3;
const MAX_FILE_B64_CHARS = 4_400_000; // ~3.3MB raw; Vercel rejects bodies over ~4.5MB anyway
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Best-effort per-IP limiter. State is per serverless instance, so it blunts
// casual abuse but is not a hard cap. For a hard cap, back this with Upstash/Vercel KV
// and set a spend limit in the Anthropic console.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now - v.start > RATE_WINDOW_MS) hits.delete(k);
  }
  const entry = hits.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

function cleanBlock(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.type === 'text' && typeof b.text === 'string') {
    return { type: 'text', text: b.text.slice(0, MAX_TEXT_CHARS) };
  }
  if (b.type === 'image' && b.source?.type === 'base64') {
    const { media_type, data } = b.source;
    if (!IMAGE_TYPES.has(media_type) || typeof data !== 'string' || data.length > MAX_FILE_B64_CHARS) return null;
    return { type: 'image', source: { type: 'base64', media_type, data } };
  }
  if (b.type === 'document' && b.source?.type === 'base64') {
    const { data } = b.source;
    if (typeof data !== 'string' || data.length > MAX_FILE_B64_CHARS) return null;
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return null;
}

// Returns a cleaned messages array, or null if the input is unusable.
function sanitizeMessages(input) {
  if (!Array.isArray(input) || !input.length) return null;
  const out = [];
  let files = 0;
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    let content;
    if (typeof m.content === 'string') {
      content = m.content.slice(0, MAX_TEXT_CHARS);
    } else if (Array.isArray(m.content) && m.role === 'user') {
      content = m.content.map(cleanBlock);
      if (content.some(b => b === null)) return null;
      files += content.filter(b => b.type !== 'text').length;
    } else {
      return null;
    }
    if (!content.length) continue;
    out.push({ role: m.role, content });
  }
  if (files > MAX_FILES) return null;
  // The API needs the conversation to open with a user turn and end with one.
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return out;
}

function lastUserText(messages) {
  const c = messages[messages.length - 1].content;
  const text = Array.isArray(c) ? c.find(b => b.type === 'text')?.text || '[file uploaded]' : c;
  return text.replace(/\s+/g, ' ').slice(0, 500);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    res.setHeader('Retry-After', String(Math.ceil(RATE_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'rate_limited' });
  }

  const messages = sanitizeMessages(req.body?.messages);
  if (!messages) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  console.log(`[QUESTION] ${new Date().toISOString()} — ${lastUserText(messages)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages }),
    });

    if (!upstream.ok) {
      // Log the detail server-side; never leak upstream error bodies to visitors.
      console.error(`[UPSTREAM ${upstream.status}]`, (await upstream.text()).slice(0, 500));
      return res.status(502).json({ error: 'upstream_error' });
    }

    const data = await upstream.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return res.status(200).json({ text });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'timeout' });
    console.error('[CHAT ERROR]', err.message);
    return res.status(500).json({ error: 'server_error' });
  } finally {
    clearTimeout(timer);
  }
};
