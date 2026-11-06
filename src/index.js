'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomManager, DATA_DIR } = require('./rooms');
const { loadConfig } = require('./config');

function pickRoot() {
  if (process.env.MM3_ROOT) return path.resolve(process.env.MM3_ROOT);
  const repoRoot = path.join(__dirname, '..');            // server/ 目录（开发用）
  const pkgRoot = path.join(__dirname, '..', '..');       // 发行包根目录（有 config.ini）
  return fs.existsSync(path.join(pkgRoot, 'config.ini')) ? pkgRoot : repoRoot;
}
const ROOT = pickRoot();
const CFG = loadConfig(ROOT);

const PORT = CFG.port;
const EMU_EXE = CFG.exe;
const ROM = CFG.rom;

const PUBLIC = path.join(__dirname, '..', 'public');
const SAVES = path.join(DATA_DIR, 'saves');
fs.mkdirSync(SAVES, { recursive: true });
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
let stats = {};
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (_) {}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const tokens = new Map(); // token -> user

const mgr = new RoomManager({
  emulatorExe: EMU_EXE, rom: ROM, log,
  instances: CFG.instances, quality: CFG.quality, fps: CFG.fps, audio: CFG.audio,
});

function send(res, code, obj, headers) {
  const body = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
  res.writeHead(code, Object.assign({ 'Content-Type': Buffer.isBuffer(obj) ? 'application/octet-stream' : 'application/json; charset=utf-8', 'Content-Length': body.length }, headers || {}));
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const b = await readBody(req);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch (_) { return {}; }
}

const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9_\-.]/g, '_').slice(0, 64);

function authUser(body) {
  const t = body.token || '';
  return tokens.get(t) || null;
}

function saveStat(user, win) {
  if (!user) return;
  stats[user] = stats[user] || { wins: 0, losses: 0 };
  if (win) stats[user].wins++; else stats[user].losses++;
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 1)); } catch (_) {}
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), { 'Content-Type': MIME['.html'] });
    }
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const f = path.join(PUBLIC, p.slice(8));
      if (!f.startsWith(PUBLIC) || !fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(f), { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    }

    if (req.method === 'POST' && p === '/api/login') {
      const b = await readJSON(req);
      const name = safeName(b.name);
      if (!name) return send(res, 400, { error: 'name required' });
      const token = crypto.randomUUID();
      tokens.set(token, name);
      return send(res, 200, { user: name, token, stats: stats[name] || { wins: 0, losses: 0 } });
    }

    if (req.method === 'GET' && p === '/api/rooms') {
      return send(res, 200, { rooms: mgr.list() });
    }

    if (req.method === 'POST' && p === '/api/rooms') {
      const b = await readJSON(req);
      const user = authUser(b);
      if (!user) return send(res, 401, { error: 'auth' });
      const sp = b.save ? path.join(SAVES, user, safeName(b.save)) : null;
      const r = mgr.create({ name: b.name, user, maxPlayers: b.maxPlayers || 2, savePath: sp && fs.existsSync(sp) ? sp : null });
      if (!r) return send(res, 400, { error: 'cannot create' });
      return send(res, 200, { room: r.room.toJSON(), slot: r.slot, token: r.token });
    }

    const mJoin = p.match(/^\/api\/rooms\/([0-9a-f]+)\/join$/);
    if (req.method === 'POST' && mJoin) {
      const b = await readJSON(req);
      const user = authUser(b);
      if (!user) return send(res, 401, { error: 'auth' });
      const room = mgr.get(mJoin[1]);
      if (!room) return send(res, 404, { error: 'no room' });
      const sp = b.save ? path.join(SAVES, user, safeName(b.save)) : null;
      const j = room.join(user, sp && fs.existsSync(sp) ? sp : null);
      if (!j) return send(res, 409, { error: 'full' });
      return send(res, 200, { room: room.toJSON(), slot: j.slot, token: j.token });
    }

    const mLeave = p.match(/^\/api\/rooms\/([0-9a-f]+)\/leave$/);
    if (req.method === 'POST' && mLeave) {
      const b = await readJSON(req);
      const room = mgr.get(mLeave[1]);
      if (room) room.leave(b.slot | 0);
      return send(res, 200, { ok: true });
    }

    const mResult = p.match(/^\/api\/rooms\/([0-9a-f]+)\/result$/);
    if (req.method === 'POST' && mResult) {
      const b = await readJSON(req);
      const user = authUser(b);
      if (!user) return send(res, 401, { error: 'auth' });
      saveStat(user, !!b.win);
      return send(res, 200, { ok: true, stats: stats[user] });
    }

    const mReset = p.match(/^\/api\/rooms\/([0-9a-f]+)\/restart$/);
    if (req.method === 'POST' && mReset) {
      const b = await readJSON(req);
      const user = authUser(b);
      if (!user) return send(res, 401, { error: 'auth' });
      const room = mgr.get(mReset[1]);
      if (!room || !room.emu) return send(res, 404, { error: 'no room' });
      const slot = b.slot | 0;
      room.emu.cmd(slot, 'reset');
      return send(res, 200, { ok: true });
    }

    if (p === '/api/saves' && req.method === 'GET') {
      const user = safeName(u.searchParams.get('user'));
      const dir = path.join(SAVES, user);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sav')) : [];
      return send(res, 200, { files });
    }

    if (p === '/api/saves' && req.method === 'POST') {
      const user = safeName(u.searchParams.get('user'));
      const name = safeName(u.searchParams.get('name') || 'save.sav');
      if (!user) return send(res, 400, { error: 'user required' });
      const body = await readBody(req, 8 * 1024 * 1024);
      if (!body.length || !name.endsWith('.sav')) return send(res, 400, { error: 'bad save' });
      const dir = path.join(SAVES, user);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), body);
      return send(res, 200, { ok: true, name, size: body.length });
    }

    if (p === '/api/save' && req.method === 'GET') {
      const user = safeName(u.searchParams.get('user'));
      const name = safeName(u.searchParams.get('name'));
      const f = path.join(SAVES, user, name);
      if (!f.startsWith(SAVES) || !fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(f), { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` });
    }

    if (p === '/api/stats' && req.method === 'GET') {
      const user = safeName(u.searchParams.get('user'));
      return send(res, 200, { stats: stats[user] || { wins: 0, losses: 0 } });
    }

    if (p === '/api/config' && req.method === 'GET') {
      return send(res, 200, {
        rom: path.basename(ROM), emu: !!EMU_EXE,
        quality: CFG.quality, fps: CFG.fps, audio: CFG.audio,
        instances: CFG.instances, port: PORT, config: CFG.found ? path.basename(CFG.file) : null,
      });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('http error', e);
    try { send(res, 500, { error: String(e && e.message || e) }); } catch (_) {}
  }
});

// ---- WebSocket: 画面下行 / 输入上行 ----
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/ws') { socket.destroy(); return; }
  const room = mgr.get(u.searchParams.get('room') || '');
  const slot = parseInt(u.searchParams.get('slot') || '-1', 10);
  const token = u.searchParams.get('token') || '';
  if (!room || slot < 0 || !room.players[slot] || room.players[slot].token !== token) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, { room, slot });
  });
});

wss.on('connection', (ws, { room, slot }) => {
  room.attachClient(slot, ws);
  log(`ws join room=${room.id} slot=${slot}`);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch (_) { return; }
    if (!room.emu) return;
    if (m.t === 'input') {
      room.emu.input(slot, m.keys | 0, m.touch || null);
    } else if (m.t === 'cmd') {
      room.emu.cmd(slot, String(m.action || ''));
    }
  });
  ws.on('close', () => {
    room.detachClient(slot, ws);
    log(`ws leave room=${room.id} slot=${slot}`);
  });
});

server.listen(PORT, () => {
  log(`MM3 联机平台已启动: http://0.0.0.0:${PORT}/`);
  log(`  配置: ${CFG.found ? CFG.file : '(未找到 config.ini，使用默认值)'}`);
  log(`  ROM: ${ROM}`);
  log(`  模拟器: ${EMU_EXE}`);
  log(`  画面: 质量 ${CFG.quality} / ${CFG.fps}fps / 音频 ${CFG.audio ? '开' : '关'}`);
});
