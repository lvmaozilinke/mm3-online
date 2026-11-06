'use strict';
// 读取 config.ini（简单 INI：; 或 # 注释，[section] key = value）
const fs = require('fs');
const path = require('path');

function parseIni(text) {
  const out = {};
  let section = '';
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === ';' || line[0] === '#') continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { section = m[1].trim(); continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    v = v.replace(/\s+[;#].*$/, '');
    if (!k) continue;
    out[section ? section + '.' + k : k] = v;
  }
  return out;
}

function defaultExe(rootDir) {
  if (process.platform === 'win32') {
    const w = path.join(rootDir, 'emulator', 'windows', 'melonDS.exe');
    return fs.existsSync(w) ? w : path.join(rootDir, 'emulator', 'melonDS.exe');
  }
  const arch = process.arch === 'arm64' ? 'linux-arm64' : (process.arch === 'x64' ? 'linux-x86_64' : 'linux-' + process.arch);
  const candidate = path.join(rootDir, 'emulator', arch, 'melonDS');
  return fs.existsSync(candidate) ? candidate : path.join(rootDir, 'emulator', 'melonDS');
}

function loadConfig(rootDir) {
  const file = process.env.MM3_CONFIG || path.join(rootDir, 'config.ini');
  let raw = {};
  let found = false;
  try { raw = parseIni(fs.readFileSync(file, 'utf8')); found = true; } catch (_) {}

  const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  const str = (v, d) => (v === undefined || v === null || v === '' ? d : v);
  const resolve = (p) => (p ? (path.isAbsolute(p) ? p : path.join(rootDir, p)) : '');
  const exeDefault = defaultExe(rootDir);

  const cfg = {
    file,
    found,
    root: rootDir,
    port: num(process.env.PORT || raw['server.port'], 8080),
    rom: resolve(str(process.env.GAME_ROM || raw['game.rom'], 'roms/mm3cn.nds')),
    exe: resolve(str(process.env.MELONDS_EXE || raw['game.exe'], exeDefault)),
    instances: num(raw['game.instances'], 2),
    quality: num(raw['quality.jpeg_quality'], 55),
    fps: num(raw['quality.fps'], 30),
    audio: String(raw['quality.audio'] === undefined ? '1' : raw['quality.audio']).trim() !== '0',
  };
  cfg.instances = Math.max(1, Math.min(4, cfg.instances));
  cfg.quality = Math.max(1, Math.min(100, cfg.quality));
  cfg.fps = Math.max(10, Math.min(60, cfg.fps));
  return cfg;
}

module.exports = { loadConfig, parseIni };
