#!/usr/bin/env node
'use strict';
// Dragonwilds Server Kit panel: web UI, API and server rules. No npm dependencies.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { Auth, hashPassword } = require('./src/auth');
const { Link } = require('./src/link');
const { Game, normalizeSnapshot } = require('./src/game');
const { Store } = require('./src/store');
const { Rules } = require('./src/rules');
const { AppError, describe } = require('./src/errors');

const ROOT = __dirname;
const DATA = process.env.DWK_DATA || path.join(ROOT, 'data');
const CONFIG = process.env.DWK_CONFIG || path.join(ROOT, 'config.json');
const TICK_MS = 500;
const MAX_LOG = 300;
const MAX_BODY = 64 * 1024;
const DEATH_MEMORY_MS = 10 * 60 * 1000;
const PERKS = new Set(['health', 'stamina', 'hunger', 'thirst', 'endurance', 'cooldown']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function loadConfig() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`invalid config.json: ${e.message}`);
    const password = crypto.randomBytes(9).toString('base64url');
    cfg = { host: '127.0.0.1', port: 8090, socket: '/opt/dragonwilds-kit/kit.sock', users: [{ name: 'admin', ...hashPassword(password) }] };
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    // Never in the log: the server's logs are shared and kept.
    const secret = path.join(path.dirname(CONFIG), 'initial-password.txt');
    fs.writeFileSync(secret, `admin ${password}
`, { mode: 0o600 });
    console.log(`First run: admin login saved to ${secret}`);
  }
  return cfg;
}

const cfg = loadConfig();
cfg.host = process.env.DWK_HOST ? process.env.DWK_HOST.split(',') : cfg.host;
cfg.port = Number(process.env.DWK_PORT || cfg.port);
const auth = new Auth(cfg.users);
const store = new Store(path.join(DATA, 'settings.json'));
const link = new Link(process.env.DWK_SOCKET || cfg.socket);
const game = new Game(link);

const clients = new Set();
const logEntries = [];
const deaths = new Map();
let snapshot = { world: null, fps: 0, players: [] };

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const c of clients) send(c, event, data);
}

function log(entry) {
  const e = { t: Date.now(), ...entry };
  logEntries.push(e);
  if (logEntries.length > MAX_LOG) logEntries.shift();
  broadcast('log', e);
}

const rules = new Rules(store, game, log);

/** What the browser sees: internal object pointers never leave the panel. */
function publicState() {
  const d = store.data;
  return {
    online: link.connected,
    world: snapshot.world,
    fps: snapshot.fps,
    players: snapshot.players.map((p) => ({
      id: p.id,
      name: p.name,
      ping: p.ping,
      pos: p.pos,
      yaw: p.yaw,
      health: p.health,
      maxHealth: p.maxHealth,
      stamina: p.stamina,
      maxStamina: p.maxStamina,
      dead: p.dead,
      exempt: rules.isExempt(p.id),
      perks: d.perks[p.id] || {},
    })),
    solo: rules.soloStatus(snapshot.players),
  };
}

function publicSettings() {
  const d = store.data;
  const known = Object.entries(d.known)
    .map(([id, k]) => ({ id, name: k.name, lastSeen: k.lastSeen, soloUsed: d.soloUsed[id] || 0 }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
  return { solo: d.solo, messages: d.messages, exempt: d.exempt, bans: d.bans, known };
}

let ticking = false;
async function tick() {
  if (ticking || !link.connected) return;
  ticking = true;
  try {
    const before = new Map(snapshot.players.map((p) => [p.id, p]));
    snapshot = normalizeSnapshot(await link.rpc('snapshot'));
    for (const p of snapshot.players) {
      if (!before.has(p.id)) log({ kind: 'join', key: 'join', params: { name: p.name } });
      before.delete(p.id);
    }
    for (const p of before.values()) log({ kind: 'leave', key: 'leave', params: { name: p.name } });
    for (const p of snapshot.players) if (p.dead && p.pos) deaths.set(p.id, { ...p.pos, t: Date.now() });
    await rules.tick(snapshot.players);
    broadcast('state', publicState());
  } catch (e) {
    log({ kind: 'error', key: 'update_failed', err: describe(e) });
  } finally {
    ticking = false;
  }
}

link.on('up', () => {
  game.cache.clear();
  log({ kind: 'system', key: 'linked' });
});
link.on('down', () => {
  snapshot = { world: null, fps: 0, players: [] };
  rules.reset();
  store.save();
  log({ kind: 'system', key: 'offline' });
  broadcast('state', publicState());
});
setInterval(tick, TICK_MS);

class ApiError extends AppError {
  constructor(status, code, params) {
    super(code, params, status);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new ApiError(413, 'too_large'));
      } else parts.push(d);
    });
    req.on('end', () => {
      if (!parts.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        reject(new ApiError(400, 'bad_json'));
      }
    });
  });
}

/**
 * Behind a tunnel every request comes from the same local address, so one person's failed logins
 * would lock everyone out. Trusted only when the config names the tunnel's address.
 */
function clientAddress(req) {
  const peer = req.socket.remoteAddress;
  const forwarded = req.headers['cf-connecting-ip'];
  return forwarded && [].concat(cfg.trustedProxies || []).includes(peer) ? String(forwarded) : peer;
}

function finite(v, name, min = -Infinity, max = Infinity) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ApiError(400, 'invalid_field', { field: name });
  return n;
}

function online(id) {
  const p = snapshot.players.find((x) => x.id === id);
  if (!p) throw new ApiError(404, 'player_offline');
  return p;
}

function withPawn(id) {
  const p = online(id);
  if (!p.pawn || p.pawn === '0x0') throw new ApiError(409, 'player_no_pawn');
  return p;
}

// The catalog is generated after installation (see docs/INSTALL.md): the panel also runs without it.
function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/catalog.json'), 'utf8'));
  } catch (e) {
    console.warn(`No item catalog yet (${e.code || e.message}): items and creatures stay empty until it is generated.`);
    return { items: [], enemies: [], skills: [] };
  }
}
const catalog = loadCatalog();
const itemPaths = new Set(catalog.items.map((i) => i.path));
const enemyPaths = new Set(catalog.enemies.map((e) => e.path));
const skillIds = new Set();
for (const s of catalog.skills) skillIds.add(s.id);

const playerActions = {
  async item(id, b, user) {
    if (!itemPaths.has(b.path)) throw new ApiError(400, 'item_unknown');
    const p = withPawn(id);
    const count = finite(b.count, 'quantity', 1, 100000);
    await game.giveItem(p, b.path, count);
    log({ kind: 'admin', key: 'item', params: { user, count, item: b.path.split('.').pop(), name: p.name } });
  },
  async xp(id, b, user) {
    if (!skillIds.has(b.skill)) throw new ApiError(400, 'skill_unknown');
    const p = online(id);
    const amount = finite(b.amount, 'xp', 1, 100000000);
    await game.giveXp(p, b.skill, amount);
    log({ kind: 'admin', key: 'xp', params: { user, amount, skill: b.skill.replace('SKILL_', ''), name: p.name } });
  },
  async revive(id, b, user) {
    const p = withPawn(id);
    const death = deaths.get(id);
    if (p.dead) {
      await game.revive(p);
    } else if (death && Date.now() - death.t < DEATH_MEMORY_MS) {
      // The game respawns players by itself within seconds: bring them back to where they fell.
      await game.teleport(p, death.x, death.y, death.z + 150);
      await game.restoreHealth(p);
      deaths.delete(id);
    } else {
      throw new ApiError(409, 'not_dead');
    }
    log({ kind: 'admin', key: 'revive', params: { user, name: p.name } });
  },
  async restore(id, b, user) {
    const p = withPawn(id);
    await game.restoreHealth(p);
    await game.restoreStamina(p);
    log({ kind: 'admin', key: 'restore', params: { user, name: p.name } });
  },
  async perk(id, b, user) {
    if (!PERKS.has(b.perk)) throw new ApiError(400, 'perk_unknown');
    const perks = store.data.perks[id] || {};
    perks[b.perk] = !!b.on;
    store.data.perks[id] = perks;
    store.save();
    const name = (store.data.known[id] || {}).name || id;
    log({ kind: 'admin', key: b.on ? 'perk_on' : 'perk_off', params: { user, perk: b.perk, name } });
  },
  async teleport(id, b, user) {
    const p = withPawn(id);
    const x = finite(b.x, 'X');
    const y = finite(b.y, 'Y');
    const z = b.z === undefined || b.z === null || b.z === '' ? null : finite(b.z, 'Z');
    const final = await game.teleport(p, x, y, z);
    log({ kind: 'admin', key: 'teleport', params: { user, name: p.name, x: Math.round(x), y: Math.round(y), z: Math.round(final) } });
  },
  async spawn(id, b, user) {
    if (!enemyPaths.has(b.path)) throw new ApiError(400, 'enemy_unknown');
    const p = withPawn(id);
    const count = finite(b.count, 'quantity', 1, 20);
    const level = finite(b.level ?? 1, 'level', 1, 200);
    const radius = finite(b.radius ?? 800, 'radius', 0, 20000);
    const x = b.x === undefined ? p.pos.x : finite(b.x, 'X');
    const y = b.y === undefined ? p.pos.y : finite(b.y, 'Y');
    const z = b.z === undefined ? p.pos.z : finite(b.z, 'Z');
    for (let i = 0; i < count; i++) await game.spawnEnemy(b.path, p, x, y, z, radius, level);
    log({ kind: 'admin', key: 'spawn', params: { user, count, enemy: b.path.split('.').pop().replace(/_C$/, ''), name: p.name } });
  },
  async kick(id, b, user) {
    const p = online(id);
    await game.kick(p, String(b.reason || store.data.messages.kick).slice(0, 200));
    log({ kind: 'admin', key: 'kick', params: { user, name: p.name } });
  },
  async ban(id, b, user) {
    const known = store.data.known[id];
    if (!known) throw new ApiError(404, 'player_unknown');
    if (!rules.isBanned(id)) store.data.bans.push({ id, name: known.name, reason: String(b.reason || '').slice(0, 200), at: Date.now() });
    store.save();
    log({ kind: 'admin', key: 'ban', params: { user, name: known.name } });
    broadcast('settings', publicSettings());
  },
  async unban(id, b, user) {
    const ban = store.data.bans.find((x) => x.id === id);
    store.data.bans = store.data.bans.filter((x) => x.id !== id);
    store.save();
    if (ban) log({ kind: 'admin', key: 'unban', params: { user, name: ban.name } });
    broadcast('settings', publicSettings());
  },
  async exempt(id, b, user) {
    const known = store.data.known[id];
    if (!known) throw new ApiError(404, 'player_unknown');
    store.data.exempt = store.data.exempt.filter((x) => x.id !== id);
    if (b.on) store.data.exempt.push({ id, name: known.name });
    store.save();
    log({ kind: 'admin', key: b.on ? 'exempt_on' : 'exempt_off', params: { user, name: known.name } });
    broadcast('settings', publicSettings());
  },
  async resetsolo(id, b, user) {
    delete store.data.soloUsed[id];
    store.save();
    broadcast('settings', publicSettings());
    log({ kind: 'admin', key: 'reset_solo', params: { user, name: (store.data.known[id] || {}).name || id } });
  },
};

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const reply = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'POST' && (req.headers['content-type'] || '').split(';')[0] !== 'application/json') {
    throw new ApiError(415, 'json_required');
  }

  if (parts[1] === 'login' && req.method === 'POST') {
    const b = await readBody(req);
    const r = auth.login(String(b.user || ''), b.password, clientAddress(req));
    if (r.error) return reply(401, { error: r.error, params: {} });
    log({ kind: 'system', key: 'panel_login', params: { user: r.user } });
    return reply(200, { user: r.user }, { 'Set-Cookie': auth.cookie(r.token) });
  }

  const s = auth.session(req);
  if (!s) throw new ApiError(401, 'login_required');

  if (parts[1] === 'logout' && req.method === 'POST') {
    auth.logout(req);
    return reply(200, {}, { 'Set-Cookie': auth.clearCookie() });
  }
  if (parts[1] === 'me') return reply(200, { user: s.user });
  if (parts[1] === 'bootstrap') return reply(200, { state: publicState(), settings: publicSettings(), log: logEntries });
  if (parts[1] === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    clients.add(res);
    send(res, 'state', publicState());
    req.on('close', () => clients.delete(res));
    return undefined;
  }
  if (parts[1] === 'settings' && req.method === 'POST') {
    const b = await readBody(req);
    const solo = store.data.solo;
    if (b.enabled !== undefined) solo.enabled = !!b.enabled;
    if (b.limitMinutes !== undefined) solo.limitMinutes = finite(b.limitMinutes, 'limit', 1, 100000);
    if (Array.isArray(b.warnMinutes)) solo.warnMinutes = b.warnMinutes.map((m) => finite(m, 'warning', 1, 100000)).sort((x, y) => y - x);
    if (b.kickReason !== undefined) solo.kickReason = String(b.kickReason).slice(0, 200);
    if (b.warnText !== undefined) solo.warnText = String(b.warnText).slice(0, 200);
    if (b.kickMessage !== undefined) store.data.messages.kick = String(b.kickMessage).slice(0, 200);
    if (b.banMessage !== undefined) store.data.messages.ban = String(b.banMessage).slice(0, 200);
    store.save();
    log({ kind: 'admin', key: solo.enabled ? 'solo_on' : 'solo_off', params: { user: s.user, minutes: solo.limitMinutes } });
    broadcast('settings', publicSettings());
    return reply(200, publicSettings());
  }
  if (parts[1] === 'skills' && parts[2] && req.method === 'GET') {
    return reply(200, await game.skills(online(decodeURIComponent(parts[2]))));
  }
  if (parts[1] === 'player' && parts[2] && parts[3] && req.method === 'POST') {
    const action = Object.prototype.hasOwnProperty.call(playerActions, parts[3]) ? playerActions[parts[3]] : null;
    if (!action) throw new ApiError(404, 'unknown_action');
    await action(decodeURIComponent(parts[2]), await readBody(req), s.user);
    return reply(200, { ok: true });
  }
  throw new ApiError(404, 'not_found');
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.normalize(path.join(ROOT, 'public', rel));
  if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    return res.end(data);
  });
  return undefined;
}

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://panel');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
  try {
    await api(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    const { code, params } = describe(e);
    res.writeHead(e.status || 502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: code, params }));
  }
  return undefined;
};

const stop = () => {
  store.save();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// "host" is one address or a list. Listing them keeps the panel off interfaces it should not face.
for (const host of [].concat(cfg.host)) {
  http.createServer(handler).listen(cfg.port, host, () => console.log(`Panel at http://${host}:${cfg.port}`));
}
