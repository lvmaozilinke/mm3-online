'use strict';

const KEY = { a: 1, b: 2, select: 4, start: 8, right: 16, left: 32, up: 64, down: 128, r: 256, l: 512, x: 1024, y: 2048 };
const BT_ORDER = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'];
const BT_NAME = { up: '上', down: '下', left: '左', right: '右', a: 'A', b: 'B', x: 'X', y: 'Y', l: 'L', r: 'R', start: 'START', select: 'SELECT' };

const DEFAULT_KEYS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  a: 'KeyX', b: 'KeyZ', x: 'KeyA', y: 'KeyS', l: 'KeyQ', r: 'KeyW',
  start: 'Enter', select: 'ShiftRight',
};
const DEFAULT_PAD = { a: 0, b: 1, x: 2, y: 3, l: 4, r: 5, select: 8, start: 9, up: 12, down: 13, left: 14, right: 15 };
const BIND_STORE = 'mm3_binds_v2';

const $ = (s) => document.querySelector(s);

const state = {
  user: null, token: null, room: null, slot: -1, ws: null,
  keys: 0, kbMask: 0, padMask: 0, touch: null,
  sendTimer: 0, lastFrameAt: 0,
  audioCtx: null, audioGain: null, audioNext: 0, audioPkt: 0, audioQueued: 0, audioDrop: 0, muted: false,
  decoding: false, ctx2d: null, drawMs: 0, adaptScale: 1, framesDropped: 0, framesRecv: 0, framesDrawn: 0, canvasRO: null,
  kb: Object.assign({}, DEFAULT_KEYS), pad: Object.assign({}, DEFAULT_PAD),
  learn: null, learnPrevPad: {}, pollTimer: 0, frameWatch: 0,
};

// ---------------- 会话 ----------------
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem('mm3_session') || 'null');
    if (s && s.user && s.token) { state.user = s.user; state.token = s.token; }
  } catch (_) {}
}
function saveSession() {
  localStorage.setItem('mm3_session', JSON.stringify({ user: state.user, token: state.token }));
}
function loadBinds() {
  try {
    const b = JSON.parse(localStorage.getItem(BIND_STORE) || 'null');
    if (b && b.kb) state.kb = Object.assign({}, DEFAULT_KEYS, b.kb);
    if (b && b.pad) state.pad = Object.assign({}, DEFAULT_PAD, b.pad);
  } catch (_) {}
}
function saveBinds() {
  localStorage.setItem(BIND_STORE, JSON.stringify({ kb: state.kb, pad: state.pad }));
}

// 服务器重启后 token 会失效（token 只存在内存里）：自动用昵称重新登录一次再重试
async function relogin() {
  if (!state.user) return false;
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: state.user }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    state.token = j.token;
    saveSession();
    return true;
  } catch (_) { return false; }
}

async function api(path, opts = {}, retried = false) {
  // 自动把当前 token 注入 JSON 请求体（重登后重试时也用的是新 token）
  let req = opts;
  if (typeof opts.body === 'string' && opts.body.trim().startsWith('{')) {
    try {
      const b = JSON.parse(opts.body);
      b.token = state.token;
      req = Object.assign({}, opts, { body: JSON.stringify(b) });
    } catch (_) { req = opts; }
  }
  const headers = Object.assign({ 'Content-Type': 'application/json' }, req.headers || {});
  const r = await fetch(path, Object.assign({}, req, { headers }));
  if (r.status === 401 && !retried) {
    if (await relogin()) return api(path, opts, true);
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}

function screenCtx() {
  const cv = $('#screen');
  if (!cv) return null;
  if (!state.ctx2d) {
    state.ctx2d = cv.getContext('2d', { alpha: false }) || cv.getContext('2d');
  }
  return state.ctx2d;
}

function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  document.body.dataset.view = view;
  if (view !== 'game') $('#keypanel').classList.add('hidden');
}

function setUserbar() {
  if (!state.user) { $('#userbar').textContent = '未登录'; return; }
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = state.user + ' · 退出';
  a.onclick = (e) => { e.preventDefault(); localStorage.removeItem('mm3_session'); location.reload(); };
  $('#userbar').innerHTML = '';
  $('#userbar').appendChild(a);
}

// ---------------- 登录 ----------------
async function doLogin() {
  const name = $('#login-name').value.trim();
  if (!name) return;
  const j = await api('/api/login', { method: 'POST', body: JSON.stringify({ name }) });
  state.user = j.user; state.token = j.token;
  saveSession();
  setUserbar();
  await enterLobby();
}

// ---------------- 大厅 ----------------
async function enterLobby() {
  show('lobby');
  await Promise.all([refreshRooms(), refreshSaves(), refreshStats()]);
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshRooms, 3000);
}

async function refreshRooms() {
  const j = await api('/api/rooms');
  const box = $('#room-list');
  box.innerHTML = '';
  if (!j.rooms.length) {
    box.innerHTML = '<div class="hint">还没有房间，创建一个吧。</div>';
    return;
  }
  for (const r of j.rooms) {
    const el = document.createElement('div');
    el.className = 'room';
    const names = r.players.map((p) => p || '空位').join(' vs ');
    const n = r.players.filter(Boolean).length;
    el.innerHTML = `<div><div class="name">${escapeHtml(r.name)}</div><div class="meta">${escapeHtml(names)} · ${n}/${r.maxPlayers}</div></div>`;
    const btn = document.createElement('button');
    btn.textContent = r.players.includes(state.user) ? '回到房间' : (n >= r.maxPlayers ? '满' : '加入');
    btn.disabled = n >= r.maxPlayers && !r.players.includes(state.user);
    btn.onclick = () => joinRoom(r.id);
    el.appendChild(btn);
    box.appendChild(el);
  }
}

async function createRoom() {
  $('#btn-create').disabled = true;
  try {
    const j = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: $('#room-name').value.trim(), token: state.token, save: $('#save-select').value }) });
    enterGame(j.room, j.slot, j.token);
  } catch (e) { alert('创建失败：' + e.message); }
  finally { $('#btn-create').disabled = false; }
}

async function joinRoom(id) {
  try {
    const j = await api(`/api/rooms/${id}/join`, { method: 'POST', body: JSON.stringify({ token: state.token, save: $('#save-select').value }) });
    enterGame(j.room, j.slot, j.token);
  } catch (e) { alert('加入失败：' + e.message); }
}

async function refreshSaves() {
  const j = await api('/api/saves?user=' + encodeURIComponent(state.user));
  const sel = $('#save-select');
  sel.innerHTML = '<option value="">不使用存档</option>';
  for (const f of j.files) {
    const o = document.createElement('option');
    o.value = f; o.textContent = f;
    sel.appendChild(o);
  }
  $('#save-info').textContent = j.files.length ? `已上传 ${j.files.length} 个存档` : '还没有存档（.sav）';
}

async function refreshStats() {
  const j = await api('/api/stats?user=' + encodeURIComponent(state.user));
  $('#stats').textContent = `胜 ${j.stats.wins} 场 · 负 ${j.stats.losses} 场`;
}

async function uploadSave() {
  const f = $('#save-file').files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  const name = f.name.endsWith('.sav') ? f.name : f.name + '.sav';
  await fetch(`/api/saves?user=${encodeURIComponent(state.user)}&name=${encodeURIComponent(name)}`, { method: 'POST', body: buf });
  $('#save-file').value = '';
  await refreshSaves();
  alert('存档已上传：' + name);
}

// ---------------- 音频 ----------------
function ensureAudio() {
  if (!state.audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      state.audioCtx = new AC({ latencyHint: state.qmode === 'low' ? 'playback' : 'interactive' });
      state.audioGain = state.audioCtx.createGain();
      state.audioGain.gain.value = state.muted ? 0 : 1;
      state.audioGain.connect(state.audioCtx.destination);
      state.audioNext = 0;
    } catch (e) { console.warn('audio init failed', e); return; }
  }
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(() => {});
  updateAudioBadge();
}

function updateAudioBadge() {
  const b = $('#btn-audio');
  if (!b) return;
  const ctx = state.audioCtx;
  if (state.muted || !ctx) { b.textContent = '🔇'; }
  else b.textContent = ctx.state === 'running' ? '🔊' : '🔈';
  b.title = ctx ? `音频 ${ctx.state} · 收到 ${state.audioPkt} 块 · 播放 ${state.audioQueued} 块 · 重排 ${state.audioDrop} 次` : '声音未启用';
}

function toggleAudio() {
  state.muted = !state.muted;
  ensureAudio();
  if (state.audioGain) state.audioGain.gain.value = state.muted ? 0 : 1;
  updateAudioBadge();
}

function playPcm(u8) {
  const ctx = state.audioCtx;
  if (!ctx || state.muted || ctx.state !== 'running') return;
  const frames = Math.floor(u8.byteLength / 4);
  if (frames < 16) return;
  const buf = ctx.createBuffer(2, frames, 48000);
  const l = buf.getChannelData(0), r = buf.getChannelData(1);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let i = 0; i < frames; i++) {
    l[i] = dv.getInt16(i * 4, true) / 32768;
    r[i] = dv.getInt16(i * 4 + 2, true) / 32768;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(state.audioGain);
  const now = ctx.currentTime;
  const base = state.audioBase || 0.18;
  if (state.audioNext < now + 0.02) state.audioNext = now + base; // 起播缓冲
  // 缓冲太长：用极小加速慢慢追回来（1~3% 听不出来），避免直接丢弃产生爆音
  let rate = 1.0;
  const backlog = state.audioNext - now;
  if (backlog > base + 0.12) rate = 1.03;
  else if (backlog > base + 0.06) rate = 1.015;
  if (backlog > base + 0.6) { state.audioNext = now + base; state.audioDrop++; } // 异常堆积才重排
  src.playbackRate.value = rate;
  try { src.start(state.audioNext); } catch (_) { return; }
  state.audioNext += buf.duration / rate;
  state.audioQueued++;
}

// 让画布的后备像素尺寸跟上显示尺寸，避免大窗口下 CSS 放大导致的卡顿
function setupCanvasSize() {
  const cv = $('#screen');
  if (!cv || !window.ResizeObserver) return;
  const fit = () => {
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cap = (QMODES[state.qmode] || QMODES.auto).cap;
    let h = Math.min(Math.round(r.height * dpr), cap, 1536);
    if (!r.width || !h) return;
    let w = Math.round(h / 1.5);
    w = Math.max(256, Math.min(w, 1024));
    h = Math.max(384, Math.round(w * 1.5));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  };
  if (state.canvasRO) state.canvasRO.disconnect();
  state.canvasRO = new ResizeObserver(fit);
  state.canvasRO.observe(cv);
  fit();
}

// 自适应分辨率：大窗口/弱显卡时自动降低画布后备尺寸，保证 30fps 不卡
function adaptResolution() {
  const cv = $('#screen');
  if (!cv || !state.drawMs || state.qmode !== 'auto') return;
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const nativeW = Math.min(Math.round(r.width * dpr), 1024);
  const nativeH = Math.min(Math.round(r.height * dpr), 1536);
  if (state.adaptScale === undefined) state.adaptScale = 1;
  let scale = state.adaptScale;
  if (state.drawMs > 16) scale = Math.max(0.35, scale * 0.85);        // 太慢：降
  else if (state.drawMs < 5 && scale < 1) scale = Math.min(1, scale * 1.08); // 很快：升
  if (Math.abs(scale - state.adaptScale) > 0.001) {
    state.adaptScale = scale;
    const w = Math.max(256, Math.round(nativeW * scale));
    const hh = Math.max(384, Math.round(w * 1.5)); // 保持 2:3
    if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
  }
}

// ---------------- 游戏 ----------------
function enterGame(room, slot, token) {
  state.room = room; state.slot = slot;
  state.keys = 0; state.kbMask = 0; state.padMask = 0; state.touch = null;
  state.audioPkt = 0; state.audioQueued = 0; state.audioDrop = 0;
  clearInterval(state.pollTimer);
  show('game');
  $('#conn-state').textContent = '连接中…';
  ensureAudio();
  setupCanvasSize();
  applyQMode();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${room.id}&slot=${slot}&token=${token}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  ws.onopen = () => { $('#conn-state').textContent = '已连接，等待画面…'; sendInput(true); };
  ws.onclose = () => { $('#conn-state').textContent = '连接已断开'; };
  ws.onerror = () => { $('#conn-state').textContent = '连接错误'; };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return;
    const u8 = new Uint8Array(ev.data);
    if (u8.length < 3) return;
    const type = u8[1];
    const payload = u8.subarray(2);
    if (type === 1) {
      state.lastFrameAt = Date.now();
      state.framesRecv++;
      // 解码跟不上时丢掉旧帧，只画最新的一帧，避免延迟越堆越大
      if (state.decoding) { state.framesDropped++; return; }
      state.decoding = true;
      const blob = new Blob([payload], { type: 'image/jpeg' });
      createImageBitmap(blob).then((bmp) => {
        const cv = $('#screen');
        const ctx = screenCtx();
        // 直接画到画布真实像素尺寸：CSS 不再做逐帧放大，窗口最大化也不掉帧
        const t0 = performance.now();
        if (cv.width !== 256 || cv.height !== 384) ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
        else ctx.drawImage(bmp, 0, 0, 256, 384);
        state.drawMs = state.drawMs * 0.8 + (performance.now() - t0) * 0.2;
        bmp.close && bmp.close();
        $('#conn-state').textContent = '';
        state.framesDrawn++;
      }).catch(() => {}).then(() => { state.decoding = false; });
    } else if (type === 2) {
      state.audioPkt++;
      playPcm(payload);
    }
  };
  clearInterval(state.speedWatch);
  state.speedWatch = setInterval(async () => {
    if (!state.room) return;
    try {
      const j = await api('/api/rooms');
      const r = j.rooms.find((x) => x.id === state.room.id);
      state.emuSpeed = r && r.speed ? r.speed[state.slot] : null;
    } catch (_) {}
  }, 2000);
  clearInterval(state.frameWatch);
  state.perfPrev = { t: performance.now(), drawn: 0, apkt: 0 };
  state.frameWatch = setInterval(() => {
    if (state.lastFrameAt && Date.now() - state.lastFrameAt > 2000) $('#conn-state').textContent = '画面暂停（等待模拟器/对方）';
    updateAudioBadge();
    adaptResolution();
    const perf = $('#perf');
    if (perf) {
      const cv = $('#screen');
      const now = performance.now();
      const pv = state.perfPrev || { t: now, drawn: state.framesDrawn, apkt: state.audioPkt };
      const dt = Math.max(1, now - pv.t) / 1000;
      const fps = ((state.framesDrawn - pv.drawn) / dt).toFixed(1);
      const aps = ((state.audioPkt - pv.apkt) / dt).toFixed(1);
      state.perfPrev = { t: now, drawn: state.framesDrawn, apkt: state.audioPkt };
      const buf = state.audioCtx ? Math.max(0, state.audioNext - state.audioCtx.currentTime) : 0;
      // 自动降级：连续掉帧/音频重排明显时，自动切到“流畅”模式一次
      const badAudio = state.audioDrop - (state.lastAudioDrop || 0);
      const badFrame = state.framesDropped - (state.lastDropFrames || 0);
      state.lastAudioDrop = state.audioDrop; state.lastDropFrames = state.framesDropped;
      if (state.qmode === 'auto' && !state.autoDowngraded && (badAudio >= 2 || badFrame >= 10)) {
        state.autoDowngraded = true;
        state.qmode = 'low';
        applyQMode();
        $('#conn-state').textContent = '检测到卡顿，已切换到流畅模式';
        setTimeout(() => { if ($('#conn-state').textContent === '检测到卡顿，已切换到流畅模式') $('#conn-state').textContent = ''; }, 4000);
      }
      const emu = (state.emuSpeed != null) ? ` · 模拟器 ${Math.round(state.emuSpeed * 100)}%` : '';
      perf.textContent = `[${(QMODES[state.qmode] || QMODES.auto).label}] ${cv.width}×${cv.height} · 画 ${fps}fps · 丢 ${state.framesDropped} · 绘制 ${(state.drawMs || 0).toFixed(2)}ms · 音 ${aps}/s · 缓冲 ${buf.toFixed(2)}s${emu}`;
    }
  }, 1000);
}

function setBit(bit, on) {
  if (on) state.kbMask |= bit; else state.kbMask &= ~bit;
  state.keys = state.kbMask | state.padMask;
  sendInput(true);
}

function sendInput(force) {
  if (!state.ws || state.ws.readyState !== 1) return;
  const now = performance.now();
  if (!force && now - state.sendTimer < 30) return;
  state.sendTimer = now;
  state.ws.send(JSON.stringify({ t: 'input', keys: state.keys, touch: state.touch }));
}

// ---- 键盘 ----
function kbMap() {
  const m = {};
  for (const b of BT_ORDER) { const code = state.kb[b]; if (code && !m[code]) m[code] = b; }
  return m;
}

function bindKeyboard() {
  const down = (e) => {
    if (state.learn && state.learn.type === 'kb') {
      e.preventDefault();
      if (e.code === 'Escape') { stopLearn(); return; }
      state.kb[state.learn.btn] = e.code;
      saveBinds(); stopLearn(); renderKeyPanel();
      return;
    }
    const k = kbMap()[e.code];
    if (!k) return;
    e.preventDefault();
    if (e.repeat) return;
    ensureAudio();
    setBit(KEY[k], true);
  };
  const up = (e) => {
    const k = kbMap()[e.code];
    if (!k) return;
    e.preventDefault();
    setBit(KEY[k], false);
  };
  window.addEventListener('keydown', down, true);
  window.addEventListener('keyup', up, true);
  window.addEventListener('blur', () => { state.kbMask = 0; state.keys = state.padMask; sendInput(true); });
}

// ---- 手柄 ----
function pollGamepads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  if (state.learn && state.learn.type === 'pad') {
    for (const p of pads) {
      if (!p) continue;
      for (let i = 0; i < p.buttons.length && i < 32; i++) {
        const pressed = !!(p.buttons[i] && p.buttons[i].pressed);
        const key = p.index + ':' + i;
        if (pressed && !state.learnPrevPad[key]) {
          state.pad[state.learn.btn] = i;
          saveBinds(); stopLearn(); renderKeyPanel();
          return;
        }
        state.learnPrevPad[key] = pressed;
      }
    }
  }
  let mask = 0;
  for (const p of pads) {
    if (!p) continue;
    for (const b of BT_ORDER) {
      const idx = state.pad[b];
      if (idx >= 0 && p.buttons[idx] && p.buttons[idx].pressed) mask |= KEY[b];
    }
    const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
    if (ax < -0.55) mask |= KEY.left;
    if (ax > 0.55) mask |= KEY.right;
    if (ay < -0.55) mask |= KEY.up;
    if (ay > 0.55) mask |= KEY.down;
  }
  if (mask !== state.padMask) {
    state.padMask = mask;
    state.keys = state.kbMask | state.padMask;
    sendInput(true);
  }
}

// ---- 触屏 + 虚拟按钮 ----
function bindControls() {
  document.querySelectorAll('.k[data-key]').forEach((el) => {
    const k = el.dataset.key;
    const on = (e) => { e.preventDefault(); e.stopPropagation(); ensureAudio(); setBit(KEY[k], true); el.classList.add('pressed'); };
    const off = (e) => { e.preventDefault(); e.stopPropagation(); setBit(KEY[k], false); el.classList.remove('pressed'); };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave', off);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  const canvas = $('#screen');
  const toTouch = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * 256);
    const y = Math.floor((e.clientY - r.top) / r.height * 384);
    if (y < 192) return null;
    return { x: Math.max(0, Math.min(255, x)), y: Math.max(0, Math.min(191, y - 192)), p: 1 };
  };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ensureAudio();
    canvas.setPointerCapture(e.pointerId);
    const t = toTouch(e);
    if (t) { state.touch = t; sendInput(true); }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.touch || !state.touch.p) return;
    const t = toTouch(e);
    if (t) { state.touch = t; sendInput(); }
  });
  const up = () => { if (state.touch) { state.touch = Object.assign({}, state.touch, { p: 0 }); sendInput(true); } };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---- 按键设置面板 ----
function codeLabel(code) {
  if (!code) return '—';
  const map = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: 'Enter', NumpadEnter: '小键盘Enter', ShiftRight: '右Shift', ShiftLeft: '左Shift',
    ControlRight: '右Ctrl', ControlLeft: '左Ctrl', AltRight: '右Alt', AltLeft: '左Alt',
    Space: '空格', Backspace: '退格', Tab: 'Tab', CapsLock: 'CapsLock',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    BracketLeft: '[', BracketRight: ']', Backquote: '`', Minus: '-', Equal: '=',
  };
  if (map[code]) return map[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return '小键盘' + code.slice(6);
  return code;
}

function renderKeyPanel() {
  const box = $('#keylist');
  if (!box) return;
  box.innerHTML = '';
  for (const b of BT_ORDER) {
    const row = document.createElement('div');
    row.className = 'keyrow' + (state.learn && state.learn.btn === b ? ' learning' : '');
    row.innerHTML = `<div class="btname">${BT_NAME[b]}</div>
      <div class="bind">${state.learn && state.learn.btn === b ? '请按键…' : escapeHtml(codeLabel(state.kb[b]))}</div>`;
    const kbBtn = document.createElement('button');
    kbBtn.textContent = '键盘';
    kbBtn.onclick = () => startLearn('kb', b);
    const padBtn = document.createElement('button');
    padBtn.textContent = '手柄(' + (state.pad[b] >= 0 ? state.pad[b] : '—') + ')';
    padBtn.onclick = () => startLearn('pad', b);
    row.appendChild(kbBtn);
    row.appendChild(padBtn);
    box.appendChild(row);
  }
}

function startLearn(type, btn) {
  state.learnPrevPad = {};
  state.learn = { type, btn };
  renderKeyPanel();
}

function stopLearn() {
  state.learn = null;
  renderKeyPanel();
}

// ---------------- 其它 ----------------
async function reportResult(win) {
  if (!state.room) return;
  try {
    const j = await api(`/api/rooms/${state.room.id}/result`, { method: 'POST', body: JSON.stringify({ token: state.token, win }) });
    alert(win ? '已记录胜利' : '已记录失败');
    if (j.stats) $('#stats') && ($('#stats').textContent = `胜 ${j.stats.wins} 场 · 负 ${j.stats.losses} 场`);
  } catch (e) { alert('记录失败：' + e.message); }
}

async function restartEmu() {
  if (!state.room) return;
  try { await api(`/api/rooms/${state.room.id}/restart`, { method: 'POST', body: JSON.stringify({ token: state.token, slot: state.slot }) }); } catch (_) {}
}

async function leaveRoom() {
  if (state.room) {
    try { await api(`/api/rooms/${state.room.id}/leave`, { method: 'POST', body: JSON.stringify({ token: state.token, slot: state.slot }) }); } catch (_) {}
  }
  if (state.ws) { try { state.ws.close(); } catch (_) {} }
  state.room = null; state.slot = -1;
  clearInterval(state.speedWatch);
  state.speedWatch = setInterval(async () => {
    if (!state.room) return;
    try {
      const j = await api('/api/rooms');
      const r = j.rooms.find((x) => x.id === state.room.id);
      state.emuSpeed = r && r.speed ? r.speed[state.slot] : null;
    } catch (_) {}
  }, 2000);
  clearInterval(state.frameWatch);
  if (state.audioCtx) { try { state.audioCtx.suspend(); } catch (_) {} }
  await enterLobby();
}

function leaveBeacon() {
  if (!state.room || !navigator.sendBeacon) return;
  try {
    const body = new Blob([JSON.stringify({ token: state.token, slot: state.slot })], { type: 'application/json' });
    navigator.sendBeacon(`/api/rooms/${state.room.id}/leave`, body);
  } catch (_) {}
}

const QMODES = {
  auto: { label: '自动', cap: 1536, audioBuf: 0.18 },
  low:  { label: '流畅', cap: 720,  audioBuf: 0.30 },
  high: { label: '清晰', cap: 1536, audioBuf: 0.12 },
};
function applyQMode() {
  const m = QMODES[state.qmode] || QMODES.auto;
  state.audioBase = m.audioBuf;
  const btn = $('#btn-quality');
  if (btn) { btn.textContent = '⚡' + m.label; btn.title = '画面性能模式：' + m.label + '（点击切换 自动/流畅/清晰）'; }
  setupCanvasSize();
  try { localStorage.setItem('mm3_qmode', state.qmode); } catch (_) {}
}
function cycleQMode() {
  const order = ['auto', 'low', 'high'];
  state.qmode = order[(order.indexOf(state.qmode) + 1) % order.length];
  state.adaptScale = 1;
  applyQMode();
}

function toggleFullscreen() {
  // 手机上不用浏览器原生全屏：部分手机浏览器会把网页当成视频，弹出“倍速/投屏”之类的悬浮提示。
  // 改用 CSS 沉浸模式（铺满可视区域），行为可控、不会有额外弹窗。
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (coarse || !document.documentElement.requestFullscreen) {
    document.body.classList.toggle('immersive');
    const on = document.body.classList.contains('immersive');
    $('#btn-full').textContent = on ? '⛶' : '⛶';
    $('#btn-full').title = on ? '退出全屏' : '全屏';
    return;
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}


function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('DOMContentLoaded', () => {
  loadSession();
  loadBinds();
  try { state.qmode = localStorage.getItem('mm3_qmode') || 'auto'; } catch (_) {}
  if (!QMODES[state.qmode]) state.qmode = 'auto';
  setUserbar();
  bindControls();
  bindKeyboard();
  renderKeyPanel();

  $('#btn-login').onclick = doLogin;
  $('#login-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#btn-refresh').onclick = refreshRooms;
  $('#btn-create').onclick = createRoom;
  $('#btn-upload').onclick = uploadSave;
  $('#btn-restart').onclick = restartEmu;
  $('#btn-leave').onclick = leaveRoom;
  $('#btn-audio').onclick = toggleAudio;
  $('#btn-full').onclick = toggleFullscreen;
  $('#btn-quality').onclick = cycleQMode;
  $('#btn-keys').onclick = () => { $('#keypanel').classList.remove('hidden'); renderKeyPanel(); };
  $('#btn-keyclose').onclick = () => { stopLearn(); $('#keypanel').classList.add('hidden'); };
  $('#btn-keydone').onclick = () => { stopLearn(); $('#keypanel').classList.add('hidden'); };
  $('#btn-keyreset').onclick = () => {
    state.kb = Object.assign({}, DEFAULT_KEYS);
    state.pad = Object.assign({}, DEFAULT_PAD);
    saveBinds(); stopLearn(); renderKeyPanel();
  };

  const tick = () => { pollGamepads(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  // 浏览器要求用户交互后才能出声：任何一次触摸/点击/按键都尝试解锁音频
  const unlock = () => ensureAudio();
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureAudio(); });
  window.addEventListener('pagehide', leaveBeacon);
  window.addEventListener('beforeunload', leaveBeacon);

  if (state.user) enterLobby(); else show('login');
});
