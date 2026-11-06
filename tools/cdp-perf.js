'use strict';
// 真实窗口（最大化）下的性能采样：绘制帧率、丢帧、音频重排、主线程长任务
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9340;
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const SECONDS = parseInt(process.env.SECONDS || '24', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

(async () => {
  const tmp = path.join(__dirname, '..', '.chrome-tmp6');
  fs.rmSync(tmp, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
    '--no-first-run', '--start-maximized', '--autoplay-policy=no-user-gesture-required',
    'http://127.0.0.1:8090/',
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 80; i++) { await sleep(300); try { list = await getJSON(`http://127.0.0.1:${PORT}/json/list`); } catch (_) {} if (list && list.some((t) => t.type === 'page' && t.url.includes('8090'))) break; }
  const target = list.find((t) => t.type === 'page' && t.url.includes('8090')) || list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pending = new Map();
  ws.on('message', (m) => { const j = JSON.parse(m.toString()); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const ev = async (e, a = false) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: a, returnByValue: true });
    if (r.result && r.result.exceptionDetails) console.error('JSERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result && r.result.result.value;
  };

  await send('Runtime.enable');
  await sleep(1200);
  await ev('(async()=>{const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"perftest"})});const j=await r.json();localStorage.setItem("mm3_session",JSON.stringify({user:j.user,token:j.token}));location.reload();return 1})()', true);
  await sleep(2200);
  await ev(`
    window.__long = 0;
    try { new PerformanceObserver((l) => { window.__long += l.getEntries().length; }).observe({ entryTypes: ['longtask'] }); } catch (_) {}
    1`);
  await ev('document.querySelector("#btn-create").click(); 1');
  await sleep(6000); // 等模拟器起来

  for (let i = 0; i < SECONDS / 3; i++) {
    const st = await ev(`JSON.stringify({
      view: document.body.dataset.view,
      cw: document.querySelector('#screen').width, ch: document.querySelector('#screen').height,
      drawn: state.framesDrawn, recv: state.framesRecv, drop: state.framesDropped,
      apkt: state.audioPkt, aq: state.audioQueued, adrop: state.audioDrop,
      ctx: state.audioCtx && state.audioCtx.state,
      base: state.audioCtx && +state.audioCtx.baseLatency.toFixed(3),
      drawMs: +state.drawMs.toFixed(2),
      long: window.__long,
      perf: document.querySelector('#perf').textContent
    })`);
    console.log('t+' + ((i + 1) * 3) + 's', st);
    await sleep(3000);
  }

  console.log('auto:', await ev(`JSON.stringify({mode:state.qmode,w:document.querySelector('#screen').width,h:document.querySelector('#screen').height})`));
  await ev(`document.querySelector('#btn-quality').click(); 1`);
  await sleep(1200);
  console.log('low :', await ev(`JSON.stringify({mode:state.qmode,w:document.querySelector('#screen').width,h:document.querySelector('#screen').height,perf:document.querySelector('#perf').textContent})`));
  await ev(`document.querySelector('#btn-quality').click(); 1`);
  await sleep(1200);
  console.log('high:', await ev(`JSON.stringify({mode:state.qmode,w:document.querySelector('#screen').width,h:document.querySelector('#screen').height})`));

  ws.close(); chrome.kill(); await sleep(300); process.exit(0);
})();
