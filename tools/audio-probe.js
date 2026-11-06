'use strict';
// 用两个账号进同一房间，抓 2P 的音频流算 RMS/峰值，确认不是全程静音
const WebSocket = require('ws');
const BASE = process.env.BASE || 'http://127.0.0.1:8090';

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const a = await post('/api/login', { name: 'probeA' });
  const b = await post('/api/login', { name: 'probeB' });
  const room = (await post('/api/rooms', { name: 'probe', token: a.token })).room;
  const jb = await post(`/api/rooms/${room.id}/join`, { token: b.token });
  console.log('room', room.id, 'slotB', jb.slot);

  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?room=${room.id}&slot=${jb.slot}&token=${jb.token}`);
  ws.binaryType = 'arraybuffer';
  let pkts = 0, samples = 0, sum = 0, peak = 0, loud = 0;
  const cnt = { 'v0': 0, 'v1': 0, 'a0': 0, 'a1': 0 };
  ws.on('open', () => console.log('ws open'));
  ws.on('message', (data) => {
    const u8 = new Uint8Array(data);
    const slot = u8[0], type = u8[1];
    cnt[(type === 1 ? 'v' : 'a') + slot] = (cnt[(type === 1 ? 'v' : 'a') + slot] || 0) + 1;
    if (type !== 2) return;
    pkts++;
    const dv = new DataView(u8.buffer, u8.byteOffset + 2, u8.byteLength - 2);
    for (let i = 0; i + 3 < dv.byteLength; i += 4) {
      const l = dv.getInt16(i, true), r = dv.getInt16(i + 2, true);
      const v = Math.max(Math.abs(l), Math.abs(r));
      sum += l * l; samples++;
      if (v > peak) peak = v;
      if (v > 800) loud++;
    }
  });
  const DUR = parseInt(process.env.DURATION || '25000', 10);
  await sleep(DUR);
  const rms = samples ? Math.sqrt(sum / samples) : 0;
  console.log(JSON.stringify({ pkts, samples, rms: Math.round(rms), peak, loudPct: samples ? +(100 * loud / samples).toFixed(1) : 0, cnt, fps: +(cnt.v1 / (DUR / 1000)).toFixed(1) }));
  ws.close();
  await post(`/api/rooms/${room.id}/leave`, { slot: jb.slot, token: b.token });
  await post(`/api/rooms/${room.id}/leave`, { slot: 0, token: a.token });
  process.exit(0);
})();
