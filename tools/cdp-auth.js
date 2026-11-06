'use strict';
// 验证：带着过期 token 进页面，点“创建房间”能自动重新登录并成功建房
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

(async () => {
  const tmp = path.join(__dirname, '..', '.chrome-tmp3');
  fs.rmSync(tmp, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
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
    if (r.result && r.result.exceptionDetails) console.error('JS ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result && r.result.result && r.result.result.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1200);
  // 塞一个“上次服务器留下的”过期 token
  await evalJS(`localStorage.setItem('mm3_session', JSON.stringify({user:'tester',token:'dead-token-1234'})); location.reload(); 1`);
  await sleep(2000);
  console.log('before:', await evalJS(`JSON.stringify({view:document.body.dataset.view, hasLobby:!!document.querySelector('#btn-create')})`));
  await evalJS(`window.__alerts=[]; window.alert=(m)=>{window.__alerts.push(String(m));}; 1`);
  await evalJS(`document.querySelector('#btn-create').click(); 1`);
  await sleep(4000);
  console.log('after :', await evalJS(`JSON.stringify({view:document.body.dataset.view, conn:document.querySelector('#conn-state')&&document.querySelector('#conn-state').textContent})`));
  console.log('alerts:', await evalJS(`JSON.stringify(window.__alerts)`));
  console.log('token now valid?', await evalJS(`(async()=>{const r=await fetch('/api/rooms');const j=await r.json();return JSON.stringify({rooms:j.rooms.length});})()`, true));

  ws.close(); chrome.kill(); await sleep(300); process.exit(0);
})();
