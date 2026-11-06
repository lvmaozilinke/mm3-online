'use strict';
// 用本地 Chrome(CDP) 给平台界面截图，检查桌面/手机竖屏/手机横屏布局
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const OUT = path.join(__dirname, '..', 'shots');
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  const tmp = path.join(__dirname, '..', '.chrome-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try { list = await getJSON(`http://127.0.0.1:${PORT}/json/list`); } catch (_) {}
    if (list && list.some((t) => t.type === 'page')) break;
  }
  if (!list) { console.error('chrome not ready'); process.exit(1); }
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const j = JSON.parse(m.toString());
    if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJS = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) console.error('JS ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result && r.result.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r.result || !r.result.data) { console.error('shot failed', name, JSON.stringify(r).slice(0, 200)); return; }
    const p = path.join(OUT, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log('shot', p);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1500);

  await evalJS(`(async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'tester'})});const j=await r.json();localStorage.setItem('mm3_session',JSON.stringify({user:j.user,token:j.token}));location.reload();return 1;})()`, true);
  await sleep(2500);
  await shot('01-lobby-desktop');

  await evalJS(`show('game'); document.querySelector('#conn-state').textContent=''; 1`);
  await sleep(500);
  await shot('02-game-desktop');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  await shot('03-game-portrait');

  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  await shot('04-game-landscape');

  await send('Emulation.clearDeviceMetricsOverride');
  await evalJS(`document.querySelector('#btn-keys').click(); 1`);
  await sleep(400);
  await shot('05-keypanel');

  ws.close();
  chrome.kill();
  await sleep(300);
  process.exit(0);
})();
