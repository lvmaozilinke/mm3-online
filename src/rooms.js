'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EmuHost } = require('./emuhost');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

let nextPort = 7100;
const PORT_MAX = 7199;

class FakeHost extends EmuHost {
  constructor(opts) {
    super(opts);
    this.timer = null;
  }
  connect() {
    this.emit('ready');
    // 生成一块测试画面（灰底 + 房间号 + 时间），便于在没有模拟器时调试前端
    let seq = 0;
    this.timer = setInterval(() => {
      const slotFrames = [this._makeFrame(seq, 0), this._makeFrame(seq, 1)];
      slotFrames.forEach((f, slot) => this.emit('frame', slot, f, seq));
      seq++;
    }, 100);
  }
  _makeFrame(seq, slot) {
    // 1x1 JPEG 占位（真实画面来自模拟器）；前端会用 canvas 画出“等待模拟器”提示
    return Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
  }
  input() {}
  cmd() {}
  close() { if (this.timer) clearInterval(this.timer); this.closed = true; }
}

class Room {
  constructor(mgr, opts) {
    this.mgr = mgr;
    this.quality = opts.quality || 55;
    this.fps = opts.fps || 30;
    this.audio = opts.audio !== false;
    this.id = opts.id;
    this.name = opts.name;
    this.rom = opts.rom;
    this.maxPlayers = opts.maxPlayers || 2;
    this.createdAt = Date.now();
    this.players = new Array(this.maxPlayers).fill(null);
    this.emu = null;
    this.clients = new Map(); // slot -> ws
    this.resultReported = false;
  }

  startEmu() {
    const port = this.mgr.allocPort();
    const hostExe = this.mgr.emulatorExe;
    const saves = this.players.map((p, i) => (p && p.savePath) || '');
    // 注意：Windows 下非 ASCII 的绝对路径作为参数传给模拟器会被转码搞坏，
    // 所以把 cwd 设成 ROM 所在目录、只传文件名（文件名保持 ASCII）
    const romDir = path.dirname(this.rom);
    const romName = path.basename(this.rom);
    const args = [
      '--host',
      '--rom', romName,
      '--instances', String(this.maxPlayers),
      '--port', String(port),
      '--quality', String(this.quality),
      '--fps', String(this.fps),
    ];
    let emu;
    let spawned = null;
    this.port = port;
    if (hostExe && fs.existsSync(hostExe)) {
      try {
        const env = Object.assign({}, process.env, {
          PATH: 'C:/msys64/ucrt64/bin;' + (process.env.PATH || ''),
          SDL_AUDIODRIVER: 'dummy',
        });
        spawned = spawn(hostExe, args, { cwd: romDir || path.dirname(hostExe), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
        const logline = (d) => { const t = d.toString().trim(); if (t) this.mgr.log(`[host ${this.id}] ${t.slice(0, 400)}`); };
        spawned.stdout.on('data', logline);
        spawned.stderr.on('data', logline);
        spawned.on('error', (e) => this.mgr.log(`[host ${this.id}] spawn error: ${e.message}`));
        spawned.on('exit', (code) => {
          this.mgr.log(`[host ${this.id}] exited ${code}`);
          this.hostExited = true;
        });
      } catch (e) { spawned = null; }
    }
    if (spawned) {
      emu = new EmuHost({ port, slots: this.maxPlayers, rom: this.rom, savePaths: saves });
      emu._proc = spawned;
      this.attachEmu(emu);
      let retries = 240;
      const tryConnect = () => {
        if (this.emu !== emu || emu.ready || this.hostExited) return;
        if (retries-- <= 0) { this.mgr.log(`[room ${this.id}] 连接模拟器宿主超时`); return; }
        emu.connect(() => setTimeout(tryConnect, 250));
      };
      setTimeout(tryConnect, 100);
      return;
    } else {
      this.useFake();
      return;
    }
  }

  useFake() {
    const emu = new FakeHost({ slots: this.maxPlayers, rom: this.rom });
    this.attachEmu(emu);
    emu.connect();
  }

  attachEmu(emu) {
    if (this.emu) { try { this.emu.close(); } catch (_) {} }
    this.emu = emu;
    const relay = (type, slot, payload) => {
      if (type === 2 && !this.audio) return;
      const ws = this.clients.get(slot);
      if (!ws || ws.readyState !== 1) return;
      // 客户端网络跟不上时不要无限排队（排队会让延迟越来越大）
      // 视频：积压超过 512KB 直接丢这一帧；音频：超过 256KB 也丢，避免声音越拖越晚
      const backlog = ws.bufferedAmount || 0;
      if (type === 1 && backlog > 512 * 1024) { this.droppedFrames = (this.droppedFrames || 0) + 1; return; }
      if (type === 2 && backlog > 256 * 1024) return;
      // 2 字节头：slot + type(1=视频 2=音频)
      ws.send(Buffer.concat([Buffer.from([slot, type]), payload]), { binary: true });
    };
    emu.on('frame', (slot, jpeg) => { this.frames = (this.frames || 0) + 1; this.lastFrame = Date.now(); relay(1, slot, jpeg); });
    emu.on('audio', (slot, pcm) => { relay(2, slot, pcm); });
    emu.on('msg', (m) => {
      if (m && m.t === 'stats' && Array.isArray(m.speed)) { this.speed = m.speed; return; }
      this.mgr.log(`[room ${this.id}] host: ${JSON.stringify(m)}`);
    });
    emu.on('close', () => { this.mgr.log(`[room ${this.id}] host closed`); });
  }

  join(user, savePath) {
    let slot = this.players.findIndex((p) => p === null);
    if (slot < 0) {
      // 允许重连（同 user）
      slot = this.players.findIndex((p) => p && p.user === user);
      if (slot < 0) return null;
    }
    const token = crypto.randomUUID();
    this.players[slot] = { user, token, joinedAt: Date.now(), savePath: savePath || null };
    if (!this.emu) this.startEmu();
    return { slot, token };
  }

  leave(slot) {
    if (this.players[slot]) this.players[slot] = null;
    const ws = this.clients.get(slot);
    if (ws) { try { ws.close(); } catch (_) {} this.clients.delete(slot); }
    if (this.players.every((p) => p === null)) this.mgr.destroyRoom(this.id);
  }

  attachClient(slot, ws) {
    this.clients.set(slot, ws);
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  detachClient(slot, ws) {
    if (this.clients.get(slot) === ws) this.clients.delete(slot);
    if (this.clients.size === 0) {
      // 最后一个人断开（关页面/掉线）：给 20 秒重连窗口，然后连房间带模拟器一起销毁
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.clients.size === 0) {
          this.mgr.log(`[room ${this.id}] 无人在线，回收房间与模拟器进程`);
          this.mgr.destroyRoom(this.id);
        }
      }, 20000);
    }
  }

  isFull() { return this.players.every((p) => p !== null); }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      rom: this.rom,
      maxPlayers: this.maxPlayers,
      players: this.players.map((p) => (p ? p.user : null)),
      speed: this.speed || null,
      started: !!this.emu,
      createdAt: this.createdAt,
    };
  }
}

class RoomManager {
  constructor(opts) {
    this.rooms = new Map();
    this.usedPorts = new Set();
    this.emulatorExe = opts.emulatorExe || null;
    this.rom = opts.rom || null;
    this.instances = opts.instances || 2;
    this.quality = opts.quality || 55;
    this.fps = opts.fps || 30;
    this.audio = opts.audio !== false;
    this.log = opts.log || ((s) => console.log(s));
  }

  allocPort() {
    for (let p = nextPort; p <= PORT_MAX; p++) {
      if (!this.usedPorts.has(p)) { this.usedPorts.add(p); nextPort = p + 1; if (nextPort > PORT_MAX) nextPort = 7100; return p; }
    }
    throw new Error('no free port');
  }

  create({ name, user, maxPlayers, savePath }) {
    const id = crypto.randomBytes(4).toString('hex');
    const room = new Room(this, {
      id, name: name || `${user} 的房间`, rom: this.rom, maxPlayers: maxPlayers || this.instances,
      quality: this.quality, fps: this.fps, audio: this.audio,
    });
    this.rooms.set(id, room);
    const j = room.join(user, savePath);
    if (!j) { this.rooms.delete(id); return null; }
    return { room, slot: j.slot, token: j.token };
  }

  get(id) { return this.rooms.get(id); }

  list() { return [...this.rooms.values()].map((r) => r.toJSON()); }

  destroyRoom(id) {
    const r = this.rooms.get(id);
    if (!r) return;
    if (r.idleTimer) clearTimeout(r.idleTimer);
    if (r.port) this.usedPorts.delete(r.port);
    const proc = r.emu && r.emu._proc;
    if (r.emu) { try { r.emu.close(); } catch (_) {} }
    for (const ws of r.clients.values()) { try { ws.close(); } catch (_) {} }
    r.clients.clear();
    this.rooms.delete(id);
    // 兜底：模拟器进程若没有响应 shutdown，就直接结束它
    if (proc && proc.pid && proc.exitCode === null) {
      const kill = () => {
        if (proc.exitCode !== null) return;
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/F', '/PID', String(proc.pid)], { windowsHide: true });
          else proc.kill('SIGKILL');
        } catch (_) {}
      };
      setTimeout(kill, 2000);
    }
    this.log(`[room ${id}] 已销毁${proc && proc.pid ? ` (模拟器 pid ${proc.pid})` : ''}`);
  }
}

module.exports = { RoomManager, Room, DATA_DIR };
