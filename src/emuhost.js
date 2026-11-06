'use strict';
// 与 melonDS 模拟器宿主进程（--host 模式）的 TCP 连接
const net = require('net');
const { EventEmitter } = require('events');

const TYPE_VIDEO = 0x01;
const TYPE_AUDIO = 0x02;

class EmuHost extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts; // {port, slots, rom, savePaths}
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.frames = 0;
    this.lastFrameAt = 0;
  }

  connect(onFail) {
    if (this.sock) { try { this.sock.destroy(); } catch (_) {} }
    const sock = net.createConnection({ host: '127.0.0.1', port: this.opts.port });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.on('connect', () => {
      this.ready = true;
      this.send({ t: 'hello', slots: this.opts.slots, rom: this.opts.rom, saves: this.opts.savePaths || [] });
      this.emit('ready');
    });
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => { this.ready = false; if (onFail) onFail(e); });
    sock.on('close', () => { this.ready = false; this.emit('close'); });
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 10) return;
      if (this.buf[0] === TYPE_VIDEO || this.buf[0] === TYPE_AUDIO) {
        const type = this.buf[0];
        const slot = this.buf[1];
        const seq = this.buf.readUInt32BE(2);
        const len = this.buf.readUInt32BE(6);
        if (this.buf.length < 10 + len) return;
        const payload = this.buf.subarray(10, 10 + len);
        this.buf = this.buf.subarray(10 + len);
        if (type === TYPE_VIDEO) {
          this.frames++;
          this.lastFrameAt = Date.now();
          this.emit('frame', slot, payload, seq);
        } else {
          this.emit('audio', slot, payload, seq);
        }
      } else {
        // JSON line
        const nl = this.buf.indexOf(0x0a);
        if (nl < 0) return;
        const line = this.buf.subarray(0, nl).toString('utf8');
        this.buf = this.buf.subarray(nl + 1);
        try { this.emit('msg', JSON.parse(line)); } catch (_) { /* ignore */ }
      }
    }
  }

  send(obj) {
    if (!this.sock || this.closed) return;
    try { this.sock.write(JSON.stringify(obj) + '\n'); } catch (_) { /* ignore */ }
  }

  input(slot, keys, touch) {
    this.send({ t: 'input', slot, keys: keys | 0, touch: touch || null });
  }

  cmd(slot, action, extra) {
    this.send(Object.assign({ t: action, slot }, extra || {}));
  }

  close() {
    if (this.sock) { try { this.send({ t: 'shutdown' }); } catch (_) {} this.sock.destroy(); }
    this.closed = true;
  }
}

module.exports = { EmuHost };
