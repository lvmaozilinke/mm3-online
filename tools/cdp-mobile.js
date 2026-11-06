'use strict';
// 手机竖屏 / 横屏沉浸模式布局检查
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9342;
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => { http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(__dirname, '..', '.chrome-tmp8');
  fs.rmSync(tmp, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
    '--no-first-run', '--disable-gpu', '--window-size=500,900', 'about:blank'], { stdio: 'ignore' });
  let list = null;
  for (let i = 0; i < 80; i++) { await sleep(250); try { list = await getJSON(`http://127.0.0.1:${PORT}/json/list`); } catch (_) {} if (list && list.some((t) => t.type === 'page')) break; }
  const t = list.find((x) => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0; const p = new Map();
  ws.on('message', (m) => { const j = JSON.parse(m.toString()); if (j.id && p.has(j.id)) { p.get(j.id)(j); p.delete(j.id); } });
  const send = (m, q = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: q })); });
  const ev = async (e, a = false) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: a, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1200);
  await ev(`(async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'tester'})});const j=await r.json();localStorage.setItem('mm3_session',JSON.stringify({user:j.user,token:j.token}));location.reload();return 1})()`, true);
  await sleep(2200);

  const measure = async (label) => {
    const s = await ev(`JSON.stringify((()=>{const c=document.querySelector('#screen').getBoundingClientRect();const g=document.querySelector('#game-root').getBoundingClientRect();const d=document.querySelector('.dpad').getBoundingClientRect();return {cssW:Math.round(c.width),cssH:Math.round(c.height),vh:innerHeight,vw:innerWidth,rootH:Math.round(g.height),dpad:Math.round(d.width),ratio:+(c.height/innerHeight).toFixed(2)};})())`);
    console.log(label, s);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, label + '.png'), Buffer.from(r.result.data, 'base64'));
  };

  // 竖屏
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  await ev(`show('game'); setupCanvasSize(); applyQMode(); 1`);
  await sleep(500);
  await measure('30-portrait-normal');

  // 竖屏沉浸（模拟手机全屏）
  await ev(`document.body.classList.add('immersive'); 1`);
  await sleep(500);
  await measure('31-portrait-immersive');

  // 横屏沉浸
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  await measure('32-landscape-immersive');

  ws.close(); chrome.kill(); await sleep(200); process.exit(0);
})();
