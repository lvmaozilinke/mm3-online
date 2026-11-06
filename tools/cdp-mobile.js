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
    const s = await ev(`JSON.stringify((()=>{const el=document.querySelector('#screen');const c={width:el.offsetWidth,height:el.offsetHeight};const br=el.getBoundingClientRect();const g=document.querySelector('#game-root').getBoundingClientRect();const d=document.querySelector('.dpad').getBoundingClientRect();return {cssW:Math.round(c.width),cssH:Math.round(c.height),bboxW:Math.round(br.width),bboxH:Math.round(br.height),sbs:document.body.classList.contains('sbs'),vh:innerHeight,vw:innerWidth,rootH:Math.round(g.height),dpad:Math.round(d.width)};})())`);
    console.log(label, s);
    console.log('  (capturing ' + label + ')');
    const r = await Promise.race([
      send('Page.captureScreenshot', { format: 'png' }),
      new Promise((res) => setTimeout(() => res({}), 5000)),
    ]);
    if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, label + '.png'), Buffer.from(r.result.data, 'base64'));
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  await ev(`show('game'); document.body.classList.add('mobile-layout','layout-portrait'); document.body.classList.remove('sbs','rot90'); layoutScreen(); 1`);
  await sleep(700);
  await measure('30-portrait-auto');

  // 手动横屏（旋转）模式：只做静态检查，避免无头浏览器在旋转层上卡住
  await ev(`document.body.classList.add('mobile-layout','layout-landscape','sbs','rot90'); 1`);
  await sleep(300);
  console.log('rotate90 classes:', await ev(`JSON.stringify({rot:document.body.classList.contains('rot90'),sbs:document.body.classList.contains('sbs')})`));
  await ev(`document.body.classList.remove('rot90','layout-landscape'); document.body.classList.add('layout-portrait'); setupCanvasSize(); 1`);
  await sleep(200);

  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  await ev(`document.body.classList.add('mobile-layout','layout-landscape','sbs'); document.body.classList.remove('layout-portrait','rot90'); layoutScreen(); 1`);
  await sleep(500);
  await measure('32-device-landscape');

  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  await ev(`document.body.classList.add('mobile-layout','layout-portrait'); document.body.classList.remove('sbs','rot90'); layoutScreen(); 1`);
  await sleep(500);
  await measure('33-small-portrait');

  ws.close(); chrome.kill(); await sleep(200); process.exit(0);
})();
