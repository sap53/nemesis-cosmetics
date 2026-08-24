'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

loadLocalEnvironment();

const PORT = clampInteger(process.env.PORT, 8787, 1, 65535);
const PRESENCE_TTL_MS = clampInteger(process.env.PRESENCE_TTL_SECONDS, 45, 15, 300) * 1000;
const COSMETIC_API_KEY = process.env.COSMETIC_API_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_PLAYERS = 256;
// Clients watching another wing user poll at 10 Hz so animation state changes
// arrive within roughly one network tick. Requests are tiny and all data is
// kept in memory; this still leaves headroom for reconnects and retries.
const RATE_LIMIT_PER_MINUTE = 900;
const presences = new Map();
const rateLimits = new Map();

if (COSMETIC_API_KEY.length < 20 || ADMIN_TOKEN.length < 24) {
  throw new Error('COSMETIC_API_KEY and ADMIN_TOKEN must be configured with long random values.');
}

const server = http.createServer(async (request, response) => {
  setSecurityHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Cosmetic-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    response.end();
    return;
  }

  try {
    const url = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      pruneExpired();
      sendJson(response, 200, { ok: true, online: presences.size, version: 1 });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/admin') {
      sendHtml(response, ADMIN_PAGE);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/admin/players') {
      if (!hasBearerToken(request, ADMIN_TOKEN)) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      pruneExpired();
      const players = Array.from(presences.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(publicPresence);
      sendJson(response, 200, { players, serverTime: Date.now() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/sync') {
      if (!safeEqual(request.headers['x-cosmetic-key'], COSMETIC_API_KEY)) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      if (!consumeRateLimit(getClientAddress(request))) {
        sendJson(response, 429, { error: 'rate_limited' });
        return;
      }

      const body = await readJson(request);
      const uuid = normalizeUuid(body.uuid);
      if (!uuid) {
        sendJson(response, 400, { error: 'invalid_uuid' });
        return;
      }

      const now = Date.now();
      let presence = presences.get(uuid);
      if (!presence) {
        presence = { uuid };
        presences.set(uuid, presence);
      }
      presence.name = normalizeName(body.name);
      presence.cape = normalizeCosmetic(body.cape);
      presence.wings = normalizeCosmetic(body.wings);
      presence.wingState = normalizeWingState(body.wingState);
      presence.clientVersion = normalizeVersion(body.clientVersion);
      presence.updatedAt = now;

      const requested = Array.isArray(body.players)
        ? body.players.slice(0, MAX_QUERY_PLAYERS)
        : [];
      const players = {};
      for (const rawUuid of requested) {
        const requestedUuid = normalizeUuid(rawUuid);
        if (!requestedUuid) continue;
        const remote = presences.get(requestedUuid);
        if (remote && now - remote.updatedAt <= PRESENCE_TTL_MS) {
          // Presence objects already contain only public fields. Reuse them
          // instead of allocating another object for every player at 10 Hz.
          players[requestedUuid] = remote;
        }
      }

      sendJson(response, 200, {
        players,
        expiresInMillis: PRESENCE_TTL_MS,
        serverTime: now
      });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    if (error && error.code === 'BODY_TOO_LARGE') {
      sendJson(response, 413, { error: 'body_too_large' });
    } else if (error instanceof SyntaxError) {
      sendJson(response, 400, { error: 'invalid_json' });
    } else {
      console.error(error);
      sendJson(response, 500, { error: 'internal_error' });
    }
  }
});

const cleanupTimer = setInterval(() => {
  pruneExpired();
  pruneRateLimits();
}, 15000);
cleanupTimer.unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Nemesis cosmetic backend listening on http://0.0.0.0:${PORT}`);
  console.log(`Admin dashboard: http://127.0.0.1:${PORT}/admin`);
});

function loadLocalEnvironment() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] === undefined) {
      process.env[key] = trimmed.slice(separator + 1).trim();
    }
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('body too large');
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size === 0) {
        resolve({});
        return;
      }
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', reject);
  });
}

function normalizeUuid(value) {
  if (typeof value !== 'string') return null;
  const compact = value.toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(compact)) return null;
  return compact.slice(0, 8) + '-' + compact.slice(8, 12) + '-' + compact.slice(12, 16)
    + '-' + compact.slice(16, 20) + '-' + compact.slice(20);
}

function normalizeName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(value) ? value : 'Unknown';
}

function normalizeCosmetic(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value) ? value.toLowerCase() : 'none';
}

function normalizeVersion(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 'unknown';
  return String(value).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24) || 'unknown';
}

function normalizeWingState(value) {
  if (typeof value !== 'string') return 'IDLE';
  const state = value.toUpperCase();
  return state === 'LIFT' || state === 'GLIDE' || state === 'FALL' || state === 'LAND'
    ? state : 'IDLE';
}

function publicPresence(value) {
  return {
    uuid: value.uuid,
    name: value.name,
    cape: value.cape,
    wings: value.wings,
    wingState: value.wingState,
    clientVersion: value.clientVersion,
    updatedAt: value.updatedAt
  };
}

function pruneExpired() {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [uuid, presence] of presences) {
    if (presence.updatedAt < cutoff) presences.delete(uuid);
  }
}

function consumeRateLimit(address) {
  const minute = Math.floor(Date.now() / 60000);
  const existing = rateLimits.get(address);
  if (!existing || existing.minute !== minute) {
    rateLimits.set(address, { minute, count: 1 });
    return true;
  }
  existing.count++;
  return existing.count <= RATE_LIMIT_PER_MINUTE;
}

function pruneRateLimits() {
  const minute = Math.floor(Date.now() / 60000);
  for (const [address, entry] of rateLimits) {
    if (entry.minute < minute - 1) rateLimits.delete(address);
  }
}

function getClientAddress(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return request.socket.remoteAddress || 'unknown';
}

function hasBearerToken(request, expected) {
  const authorization = request.headers.authorization || '';
  return authorization.startsWith('Bearer ') && safeEqual(authorization.slice(7), expected);
}

function safeEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function clampInteger(raw, fallback, minimum, maximum) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  response.end(body);
}

function sendHtml(response, value) {
  const body = Buffer.from(value);
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length
  });
  response.end(body);
}

const ADMIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nemesis Cosmetics</title><style>
:root{color-scheme:dark;font-family:Inter,Segoe UI,sans-serif}*{box-sizing:border-box}body{margin:0;background:#080b11;color:#f3f5fa}
main{max-width:1050px;margin:48px auto;padding:0 22px}.top{display:flex;align-items:end;justify-content:space-between;margin-bottom:22px}
h1{font-size:25px;margin:0 0 6px}.muted{color:#8992a5;font-size:13px}.badge{padding:7px 11px;border:1px solid #253250;border-radius:999px;background:#111827}
.card{background:#0d1119;border:1px solid #1b2230;border-radius:14px;overflow:hidden;box-shadow:0 20px 70px #0008}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:14px 16px;border-bottom:1px solid #171e2a;font-size:13px}
th{color:#8992a5;font-weight:600;background:#0a0e15}.cosmetic{display:inline-block;background:#182136;border:1px solid #263655;padding:4px 8px;border-radius:7px;color:#bcd2ff}
.empty{text-align:center;padding:60px;color:#8992a5}.error{color:#ff8490}input{background:#0d1119;border:1px solid #293246;border-radius:9px;color:white;padding:9px 11px;width:260px;outline:none}
</style></head><body><main><div class="top"><div><h1>Nemesis Cosmetics</h1><div class="muted">Live client cosmetic presence</div></div><div><input id="token" type="password" placeholder="Admin token"><span id="count" class="badge">0 online</span></div></div>
<div class="card"><div id="content" class="empty">Enter the admin token to connect.</div></div></main><script>
const token=document.querySelector('#token'),content=document.querySelector('#content'),count=document.querySelector('#count');token.value=localStorage.nemesisAdminToken||'';
token.oninput=()=>{localStorage.nemesisAdminToken=token.value;refresh()};const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function refresh(){if(!token.value){content.className='empty';content.textContent='Enter the admin token to connect.';return}try{const r=await fetch('/v1/admin/players',{headers:{Authorization:'Bearer '+token.value}});if(!r.ok)throw new Error(r.status===401?'Incorrect admin token.':'Backend error '+r.status);const d=await r.json();count.textContent=d.players.length+' online';content.className='';content.innerHTML=d.players.length?'<table><thead><tr><th>Player</th><th>UUID</th><th>Cape</th><th>Wings</th><th>Last update</th></tr></thead><tbody>'+d.players.map(p=>'<tr><td>'+esc(p.name)+'</td><td class="muted">'+esc(p.uuid)+'</td><td><span class="cosmetic">'+esc(p.cape)+'</span></td><td><span class="cosmetic">'+esc(p.wings)+'</span></td><td>'+Math.max(0,Math.round((Date.now()-p.updatedAt)/1000))+'s ago</td></tr>').join('')+'</tbody></table>':'<div class="empty">No clients online yet.</div>'}catch(e){content.className='empty error';content.textContent=e.message}}
setInterval(refresh,3000);refresh();</script></body></html>`;
