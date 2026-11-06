'use strict';
// 端到端检查：创建房间 -> 真实模拟器出画面/出声音 -> 离开房间 -> 房间与进程销毁
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const OUT = path.join(__dirname, '..', 'shots');
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
function emuCount() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq melonDS.exe" /FO CSV /NH', { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).filter((l) => l.includes('melonDS.exe')).length;
  } catch (_) { return 0; }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('melonDS before:', emuCount());
  const tmp = path.join(__dirname, '..', '.chrome-tmp2');
  fs.rmSync(tmp, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 60; i++) { await sleep(300); try { list = await getJSON(`http://127.0.0.1:${PORT}/json/list`); } catch (_) {} if (list && list.some((t) => t.type === 'page')) break; }
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pending = new Map();
  ws.on('message', (m) => { const j = JSON.parse(m.toString()); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJS = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) console.error('JS ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result && r.result.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) { fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); console.log('shot', name); }
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1500);
  await evalJS(`(async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'tester'})});const j=await r.json();localStorage.setItem('mm3_session',JSON.stringify({user:j.user,token:j.token}));location.reload();return 1;})()`, true);
  await sleep(2500);

  await evalJS(`document.querySelector('#btn-create').click(); 1`);
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const st = await evalJS(`JSON.stringify({view:document.body.dataset.view,conn:document.querySelector('#conn-state').textContent,audioPkt:state.audioPkt,queued:state.audioQueued,drop:state.audioDrop,frames:!!state.lastFrameAt,ctx:state.audioCtx&&state.audioCtx.state})`);
    console.log('t+' + ((i + 1) * 5) + 's', st);
  }
  await shot('10-real-game');
  console.log('rooms:', JSON.stringify(await getJSON(BASE + '/api/rooms')));
  console.log('melonDS during:', emuCount());

  await evalJS(`document.querySelector('#btn-leave').click(); 1`);
  await sleep(3000);
  console.log('rooms after leave:', JSON.stringify(await getJSON(BASE + '/api/rooms')));
  console.log('melonDS after leave:', emuCount());

  ws.close(); chrome.kill(); await sleep(300); process.exit(0);
})();
