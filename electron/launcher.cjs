'use strict';
/**
 * 本地服务启动器：一键启动 llama-server 与 ComfyUI，并提供显存编排原语。
 *
 * - llama.cpp：用户指定安装目录（含 llama-server.exe），软件自动补上模型路径与端口，
 *   **静默启动**（无控制台窗口），输出落盘到 软件目录\logs\llama-server.log。
 * - ComfyUI：用户指定安装目录，自动识别三种形态：
 *     ComfyUI Desktop（Comfy Desktop.exe） / 便携包（run_nvidia_gpu.bat） / 源码（main.py）
 *   同样静默启动，输出落盘到 软件目录\logs\comfyui.log。
 * 启动后轮询健康检查确认是否真的起来了；服务地址沿用设置里的 endpoint.*。
 *
 * 显存编排原语（16GB 卡上 llama / 生图模型 / H3 模型必须互斥）：
 *   vramUsed / waitVramBelow / stopLlama / unloadComfyModels / freeVramForComfy
 *   —— 全部异步（本机每次 spawn 约 5.1s，同步会把主进程堵死、界面卡住）
 * 编排「策略」在 orchestrator.cjs，这里只提供动作。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execFile } = require('child_process');
const models = require('./models.cjs');
const inference = require('./inference.cjs');
const logger = require('./logger.cjs');

let db = null;

const LLAMA_DIR_KEY = 'llama.installDir';
const LLAMA_AUTO_KEY = 'llama.installDirAuto';
const COMFY_DIR_KEY = 'comfyui.installDir';
const COMFY_AUTO_KEY = 'comfyui.installDirAuto';

/** 默认启动参数（模型/-m、地址、端口由软件自动补在前面）
 *  参数写法按 llama.cpp b11012 校准（与老文档不同）：
 *   - -fa 需要带值：-fa on（裸 -fa 会把下一个参数当它的值）
 *   - --no-mmap 已改名：-lm none（--load-mode，可选 auto|none|mmap|mlock|mmap+mlock|dio）
 */
const DEFAULT_LLAMA_ARGS = '-ngl 99 -c 32768 -fa on -lm none --jinja';

function init(dbRef) {
  db = dbRef;
}

function projectRoot() {
  const ws = db.getSetting('workspace') || '';
  return ws ? path.dirname(ws) : '';
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

/** 在 dir 及最大 depth 层子目录里按文件名查找，返回绝对路径 */
function findFile(dir, name, depth = 2) {
  if (!dir || !isDir(dir)) return null;
  const want = name.toLowerCase();
  const stack = [{ d: dir, lv: 0 }];
  while (stack.length) {
    const { d, lv } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (e.isFile()) { if (e.name.toLowerCase() === want) return path.join(d, e.name); }
      else if (e.isDirectory() && lv < depth) stack.push({ d: path.join(d, e.name), lv: lv + 1 });
    }
  }
  return null;
}

/** 目录解析：用户设置 > 上次探测缓存 > 现探（结果落库） */
function resolveInstDir(customKey, autoKey, detectFn, cache) {
  const custom = db.getSetting(customKey);
  if (custom && isDir(custom)) return custom;
  if (cache.get() !== undefined) return cache.get();
  const auto = db.getSetting(autoKey);
  if (auto && isDir(auto)) { cache.set(auto); return auto; }
  const found = detectFn();
  cache.set(found);
  if (found) db.setSetting(autoKey, found);
  return found;
}

const _llamaCache = { v: undefined, get() { return this.v; }, set(x) { this.v = x; } };
const _comfyCache = { v: undefined, get() { return this.v; }, set(x) { this.v = x; } };

/* ------------------------------------------------------------------ */
/* llama.cpp                                                          */
/* ------------------------------------------------------------------ */

const LLAMA_EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

function detectLlamaDir() {
  const cands = [];
  const pr = projectRoot();
  if (pr) cands.push(path.join(pr, 'runtime', 'llama'));
  const home = os.homedir();
  cands.push('C:\\llama.cpp', path.join(home, 'llama.cpp'), path.join(home, 'Downloads', 'llama.cpp'), path.join(home, 'Desktop', 'llama.cpp'));
  for (const d of models.drives()) {
    cands.push(path.join(d, 'llama.cpp'), path.join(d, 'llama'));
    let tops = [];
    try { tops = fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()); } catch (_) { continue; }
    for (const t of tops) if (/^llama/i.test(t.name)) cands.push(path.join(d, t.name));
  }
  for (const c of cands) if (findFile(c, LLAMA_EXE, 2)) return c;
  return '';
}

function llamaDir() {
  return resolveInstDir(LLAMA_DIR_KEY, LLAMA_AUTO_KEY, detectLlamaDir, _llamaCache);
}

/**
 * 检查 CUDA 后端是否真的可用。
 * 关键坑：llama.cpp 的 cuda 包只带 ggml-cuda.dll，**不带** CUDA 运行时（cudart/cublas）。
 * 缺运行时 DLL 时 Windows 加载 ggml-cuda.dll 失败，llama.cpp 会**静默回退到 CPU**——
 * 服务能起来、日志也不报错，只是慢 5-7 倍（生成 ~9 tok/s 而不是 ~60 tok/s）。
 * 所以必须显式检查，并在界面上提示。
 */
function cudaCheck(dir) {
  const res = { backend: false, runtime: false, ok: false, hint: '' };
  if (!dir || !isDir(dir)) { res.hint = '未找到 llama.cpp 目录'; return res; }
  const walk = (d, depth) => {
    if (depth > 2) return [];
    let out = [];
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return []; }
    for (const e of ents) {
      if (e.isFile()) out.push(path.join(d, e.name));
      else if (e.isDirectory()) out.push(...walk(path.join(d, e.name), depth + 1));
    }
    return out;
  };
  const files = walk(dir, 0).map(f => path.basename(f).toLowerCase());
  res.backend = files.some(f => /^ggml-cuda.*\.dll$/.test(f));
  res.runtime = files.some(f => /^cudart.*\.dll$/.test(f)) && files.some(f => /^cublas.*\.dll$/.test(f));

  if (!res.backend) {
    res.hint = '当前 llama.cpp 是不含 CUDA 的构建（缺 ggml-cuda.dll），只能用 CPU 推理。'
      + '请到 llama.cpp Releases 下载 llama-bXXXXX-bin-win-cuda-13.4-x64.zip 并解压到本目录。';
  } else if (!res.runtime) {
    res.hint = '检测到 ggml-cuda.dll，但缺少 CUDA 运行时（cudart64_*.dll / cublas*_*.dll），'
      + 'llama.cpp 会静默回退到 CPU，推理会慢 5-7 倍。'
      + '修复：下载同一 Release 的 cudart-llama-bin-win-cuda-13.4-x64.zip，把里面的 3 个 DLL 解压到本目录（与 llama-server.exe 同级）。';
  } else {
    res.ok = true;
  }
  return res;
}

function llamaInfo() {
  const dir = llamaDir();
  const exe = dir ? findFile(dir, LLAMA_EXE, 2) : null;
  const modelDir = models.resolveDir('llm') || '';
  const modelFile = models.pick('llm');
  const modelPath = (modelFile && modelDir) ? path.join(modelDir, modelFile) : '';
  return {
    installDir: dir || '',
    isCustom: !!db.getSetting(LLAMA_DIR_KEY),
    detected: db.getSetting(LLAMA_AUTO_KEY) || (db.getSetting(LLAMA_DIR_KEY) ? '' : (dir || '')),
    exe: exe || '',
    exeOk: !!exe,
    cuda: cudaCheck(dir),
    modelDir,
    modelFile: modelFile || '',
    modelPath,
    modelOk: !!modelPath && isFile(modelPath),
    args: db.getSetting('llama.args') || DEFAULT_LLAMA_ARGS,
    endpoint: inference.endpoint('llm')
  };
}

function llamaDirWritable() {
  const w = db.getSetting('workspace');
  if (!w) return null;
  try {
    const t = path.join(w, 'tools');
    fs.mkdirSync(t, { recursive: true });
    return t;
  } catch (_) { return null; }
}

/**
 * 生成 start-llm.bat（纯 ASCII 内容，避免 cmd 中文乱码）。
 * 仅供「手动排查」使用：双击它会开一个控制台窗口、能看到实时输出、关窗即停。
 * 软件自身的启动按钮**不再用它**，走静默 spawnSilent（无窗口 + 日志落盘）。
 */
function writeLlamaBat(exe, modelPath, port, args) {
  const tools = llamaDirWritable();
  if (!tools) return '';
  const file = path.join(tools, 'start-llm.bat');
  const body = [
    '@echo off',
    'chcp 65001 >nul',
    'echo Starting llama-server ...',
    'echo   model : ' + modelPath,
    'echo   endpoint: http://127.0.0.1:' + port,
    'echo   (close this window to stop the service)',
    'echo.',
    '"' + exe + '" -m "' + modelPath + '" --host 127.0.0.1 --port ' + port + ' ' + args,
    'echo.',
    'echo llama-server exited.'
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

/* ------------------------------------------------------------------ */
/* 静默后台启动：不弹任何控制台窗口，输出落盘到 软件目录\logs\          */
/* ------------------------------------------------------------------ */

/** 日志目录：固定在软件目录 logs\ 下（与工作区设置无关，随软件走） */
function logDirOf() {
  try { const d = path.join(__dirname, '..', 'logs'); fs.mkdirSync(d, { recursive: true }); return d; } catch (_) { return ''; }
}

/** 服务日志文件：软件目录\logs\<name>.log（追加写） */
function serviceLogPath(name) {
  const d = logDirOf();
  return d ? path.join(d, name + '.log') : '';
}

/** 读文件尾部 n 行（启动失败时把关键报错带进运行日志，替代以前"看控制台窗口"） */
function tailFile(p, n = 8) {
  try {
    if (!p || !isFile(p)) return [];
    const txt = fs.readFileSync(p, 'utf-8');
    return txt.split(/\r?\n/).filter(s => s.trim()).slice(-n);
  } catch (_) { return []; }
}

/** 把 "-ngl 99 -c 32768" 这类参数串切成数组（支持引号包裹的参数） */
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || '')))) {
    out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }
  return out;
}

/**
 * 静默启动后台服务（llama-server / ComfyUI）——**不弹控制台窗口**。
 *  - detached + windowsHide：Windows 下等价 DETACHED_PROCESS，既无窗口也无控制台；
 *    GUI 程序（Comfy Desktop）不受影响，仍会正常显示自己的界面。
 *  - stdout/stderr 直接重定向到 软件目录\logs\<logName>.log（追加），
 *    子进程独立于本软件，关掉软件也不影响它继续写日志。
 *
 * 早期实现是 `cmd /c start "" cmd /k <bat>` 弹一个控制台窗口（看得见日志、关窗即停），
 * 现在改为静默 + 落盘 + 设置页「停止」按钮；排错请看服务日志文件。
 */
function spawnSilent(exe, args, opts = {}) {
  const logFile = opts.logName ? serviceLogPath(opts.logName) : '';
  let fd = null;
  if (logFile) {
    try {
      fd = fs.openSync(logFile, 'a');
      fs.writeSync(fd, '\n===== ' + new Date().toLocaleString('sv-SE') + ' 启动 '
        + path.basename(exe) + (args.length ? ' ' + args.join(' ') : '') + ' =====\n');
    } catch (_) { fd = null; }
  }
  let child = null;
  let error = '';
  try {
    child = spawn(exe, args, {
      cwd: opts.cwd && isDir(opts.cwd) ? opts.cwd : undefined,
      detached: true,
      windowsHide: true,
      stdio: fd === null ? 'ignore' : ['ignore', fd, fd]
    });
    child.on('error', (e) => {
      try { logger.error('后台进程启动失败（' + path.basename(exe) + '）：' + ((e && e.message) || e)); } catch (_) {}
    });
    child.unref();
  } catch (e) {
    error = (e && e.message) || String(e);
  }
  // 子进程已持有自己的句柄副本，父进程不再需要
  if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  return { pid: (child && child.pid) || 0, logFile, error };
}

/** 用 cmd 跑一个 .bat（同样静默，不弹窗） */
function spawnBatSilent(bat, cwd, logName) {
  return spawnSilent('cmd.exe', ['/c', bat], { cwd, logName });
}

function portOf(url, def) {
  try { const u = new URL(url); return u.port || String(def); } catch (_) { return String(def); }
}

async function startLlama() {
  const info = llamaInfo();
  const h = await inference.health();
  if (h.llm) return { ok: true, already: true, message: 'LLM 服务已在运行（' + info.endpoint + '）' };
  if (!info.exeOk) {
    return {
      ok: false,
      message: '没找到 llama-server.exe。请把 llama.cpp（cuda-13.4 双包解压到同一个文件夹）放到 '
        + (info.installDir || (projectRoot() ? path.join(projectRoot(), 'runtime', 'llama') : 'runtime\\llama'))
        + '，或在上面的「安装目录」里指定它所在目录。'
    };
  }
  if (!info.modelOk) {
    return {
      ok: false,
      message: '没找到 GGUF 模型。请把 *.gguf 放到 ' + (info.modelDir || 'runtime\\models\\llm') + ' 后重试。'
    };
  }

  const port = portOf(info.endpoint, 8080);
  // 顺手更新一份 bat（只在用户手动双击排错时用；软件自身走静默启动，不弹窗）
  writeLlamaBat(info.exe, info.modelPath, port, info.args);

  const args = ['-m', info.modelPath, '--host', '127.0.0.1', '--port', String(port)].concat(splitArgs(info.args));
  const sp = spawnSilent(info.exe, args, { cwd: path.dirname(info.exe), logName: 'llama-server' });
  if (sp.error || !sp.pid) {
    const m = '无法启动 llama-server：' + (sp.error || '进程创建失败')
      + (sp.logFile ? '（日志：' + sp.logFile + '）' : '');
    logger.error(m);
    return { ok: false, message: m };
  }
  logger.info('llama-server 已静默启动（PID ' + sp.pid + '，无窗口；日志 ' + (sp.logFile || '—') + '）');

  const t0 = Date.now();
  const ok = await waitHealth('llm', 60000);
  const ms = Date.now() - t0;
  const cudaOk = !!(info.cuda && info.cuda.ok);
  if (ok) logger.ok('llama-server 已启动（' + info.modelFile + '，' + (ms / 1000).toFixed(1) + 's 就绪）');
  else {
    logger.warn('llama-server 已拉起但健康检查还没通过（首次加载大模型可能要 30-60 秒）');
    const tail = tailFile(sp.logFile, 6);
    if (tail.length) {
      logger.warn('llama-server 日志尾部（完整日志：' + sp.logFile + '）：');
      for (const l of tail) logger.warn('  ' + String(l).slice(0, 240));
    }
  }
  if (!cudaOk) logger.warn('CUDA 未就绪 → llama 将用 CPU 推理：' + (info.cuda ? info.cuda.hint : ''));

  const cpuWarn = cudaOk ? '' : '  ⚠ 但检测到 CUDA 未就绪（' + (info.cuda ? info.cuda.hint : '') + '）→ 将用 CPU 推理，速度约慢 6 倍。';
  return {
    ok: true, pid: sp.pid, log: sp.logFile,
    cudaOk,
    message: (ok
      ? 'LLM 服务已启动：' + info.endpoint + '（模型 ' + info.modelFile + '，' + (ms / 1000).toFixed(1) + 's）'
      : '已静默启动 llama-server，模型正在加载（大模型首次加载需 30–60 秒）。稍后点「重新检测」查看状态。')
      + '　日志：' + (sp.logFile || '—') + cpuWarn
  };
}

/* ------------------------------------------------------------------ */
/* ComfyUI                                                            */
/* ------------------------------------------------------------------ */

/** ComfyUI Desktop 内置的核心副本（是它自己用的，不是给用户启动的安装目录） */
function isInternalComfyDir(dir) {
  return /\\resources\\ComfyUI$/i.test(dir) || /@comfyorgcomfyui-electron/i.test(dir);
}

/**
 * 判断目录是不是 ComfyUI 安装目录，并解析启动方式。
 * 返回带 score 的描述：Desktop(100) > 便携包 bat(80) > 便携包 python(60)；
 * 只有 main.py 但没有本地解释器的源码目录视为「启不起来」，返回 null。
 */
function resolveComfyLaunch(dir) {
  if (!dir || !isDir(dir) || isInternalComfyDir(dir)) return null;

  const desktop = findFile(dir, 'Comfy Desktop.exe', 1);
  if (desktop) return { kind: 'desktop', score: 100, exe: desktop, cwd: path.dirname(desktop), label: 'ComfyUI Desktop' };

  const rungpu = findFile(dir, 'run_nvidia_gpu.bat', 1) || findFile(dir, 'run_cpu.bat', 1);
  if (rungpu) return { kind: 'portable-bat', score: 80, exe: rungpu, cwd: path.dirname(rungpu), label: 'ComfyUI 便携包' };

  const mainPy = findFile(dir, 'main.py', 3);
  if (mainPy) {
    const comfyDir = path.dirname(mainPy);          // ...\ComfyUI
    const root = path.dirname(comfyDir);            // 便携包根
    const py = [
      path.join(root, 'python_embeded', 'python.exe'),
      path.join(comfyDir, '.venv', 'Scripts', 'python.exe'),
      path.join(comfyDir, 'venv', 'Scripts', 'python.exe'),
      path.join(root, 'venv', 'Scripts', 'python.exe')
    ].find(isFile);
    if (py) return { kind: 'portable-py', score: 60, exe: py, script: mainPy, cwd: root, label: 'ComfyUI 便携包（python）' };
    return null;
  }
  return null;
}

function detectComfyDir() {
  const cands = [];
  const pr = projectRoot();
  if (pr) cands.push(path.join(pr, 'ComfyUI'));
  const home = os.homedir();
  cands.push(path.join(home, 'ComfyUI'), path.join(home, 'Documents', 'ComfyUI'));
  for (const d of models.drives()) {
    let tops = [];
    try { tops = fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()); } catch (_) { continue; }
    for (const t of tops) if (/^comfy/i.test(t.name)) cands.push(path.join(d, t.name));
  }
  // 多个候选都存在时取「最像真安装目录」的那个（Desktop 优先），避免误选 Desktop 的内置副本
  let best = '', bestScore = 0;
  for (const c of cands) {
    const r = resolveComfyLaunch(c);
    if (r && r.score > bestScore) { bestScore = r.score; best = r.cwd; }
  }
  return best;
}

function comfyDir() {
  return resolveInstDir(COMFY_DIR_KEY, COMFY_AUTO_KEY, detectComfyDir, _comfyCache);
}

function comfyInfo() {
  const dir = comfyDir();
  const launch = resolveComfyLaunch(dir);
  return {
    installDir: dir || '',
    isCustom: !!db.getSetting(COMFY_DIR_KEY),
    detected: db.getSetting(COMFY_AUTO_KEY) || (db.getSetting(COMFY_DIR_KEY) ? '' : (dir || '')),
    kind: launch ? launch.kind : 'unknown',
    label: launch ? launch.label : '',
    exe: launch ? launch.exe : '',
    launcherOk: !!launch,
    endpoint: inference.endpoint('comfyui')
  };
}

/** 单飞锁：并发调用（预热+IPC 守卫同时进来）共享同一次启动，避免重复拉进程/重复打日志 */
let _comfyStart = null;
let _comfyStartT0 = 0;
function comfyStartElapsedMs() { return _comfyStartT0 ? Date.now() - _comfyStartT0 : 0; }
function startComfy() {
  if (_comfyStart) return _comfyStart;
  _comfyStart = _startComfy().finally(() => { _comfyStart = null; });
  return _comfyStart;
}

async function _startComfy() {
  const info = comfyInfo();
  const h = await inference.health();
  if (h.comfyui) return { ok: true, already: true, message: 'ComfyUI 已在运行（' + info.endpoint + '）' };
  _comfyStartT0 = Date.now();
  if (!info.launcherOk) {
    return {
      ok: false,
      message: '没找到 ComfyUI 启动程序。请指定 ComfyUI 安装目录：Desktop 版选「Comfy Desktop.exe 所在目录」，便携版选含 run_nvidia_gpu.bat 的目录。'
    };
  }

  let sp = null;
  if (info.kind === 'portable-bat') {
    sp = spawnBatSilent(info.exe, '', 'comfyui');
  } else if (info.kind === 'desktop') {
    // Desktop 版是 GUI 程序：直接拉起进程即可（等价于双击图标），不会出现黑窗，且独立于本软件
    sp = spawnSilent(info.exe, [], { cwd: info.installDir, logName: 'comfyui' });
  } else {
    sp = spawnSilent(info.exe, [info.script, '--windows-standalone-build'], { cwd: info.installDir, logName: 'comfyui' });
  }
  const pid = sp.pid;
  if (!pid) {
    const m = '无法启动 ' + (info.label || 'ComfyUI') + '：' + (sp.error || '进程创建失败')
      + (sp.logFile ? '（日志：' + sp.logFile + '）' : '');
    logger.error(m);
    return { ok: false, message: m };
  }

  logger.info('正在启动 ' + info.label + '…（静默启动，无控制台窗口；日志 ' + (sp.logFile || '—') + '）');
  const t0 = Date.now();
  // Desktop 冷启动要等界面出来才起 8188，实测可超 60s → 给足 150s，期间每 15s 打一条进度
  const ok = await waitHealth('comfyui', 150000, { label: 'ComfyUI', stepMs: 15000 });
  const ms = Date.now() - t0;
  if (ok) logger.ok('ComfyUI 已就绪（' + (ms / 1000).toFixed(1) + 's）');
  else logger.warn('ComfyUI 还没起来（已等 ' + (ms / 1000).toFixed(0) + 's）');
  return {
    ok: true, pid, kind: info.kind, ready: ok, log: sp.logFile,
    message: (ok
      ? 'ComfyUI 已启动：' + info.endpoint + '（' + info.label + '，' + (ms / 1000).toFixed(1) + 's）'
      : '已拉起 ' + info.label + '（静默启动，无窗口）。ComfyUI Desktop 首次启动较慢（要等界面出来才会起 8188 服务），'
        + '稍后点「重新检测」查看状态。')
      + '　日志：' + (sp.logFile || '—')
  };
}

/* ------------------------------------------------------------------ */

/** 轮询健康检查，最多等 timeoutMs；opts.label/opts.stepMs 用于周期性打进度日志 */
async function waitHealth(key, timeoutMs, opts = {}) {
  const label = opts.label || '';
  const stepMs = opts.stepMs || 0;
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const h = await inference.health();
      if (h[key]) return true;
    } catch (_) { /* 继续等 */ }
    if (label && stepMs && Date.now() - lastLog >= stepMs) {
      lastLog = Date.now();
      logger.info('仍在等待 ' + label + ' 就绪…（已等 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's，服务起来后会自动确认）');
    }
  }
  return false;
}

function setDir(key, dir) {
  const v = dir ? String(dir).trim() : null;
  if (key === 'llama') {
    db.setSetting(LLAMA_DIR_KEY, v);
    _llamaCache.set(undefined);
    return llamaInfo();
  }
  db.setSetting(COMFY_DIR_KEY, v);
  _comfyCache.set(undefined);
  return comfyInfo();
}

/** 查看/修改 llama 启动参数 */
function getLlamaArgs() { return db.getSetting('llama.args') || DEFAULT_LLAMA_ARGS; }
function setLlamaArgs(s) { db.setSetting('llama.args', String(s || '').trim() || DEFAULT_LLAMA_ARGS); return getLlamaArgs(); }

/* ------------------------------------------------------------------ */
/* 显存编排原语：16GB 卡上 llama / 生图模型 / H3 视频模型必须互斥       */
/* ------------------------------------------------------------------ */

/**
 * 异步跑一个外部命令。
 *
 * ⚠️ 铁律：本机实测**任何进程 spawn 固定耗时约 5.1s**（杀软/Defender 扫描所致，
 * `where ffmpeg`、`nvidia-smi`、`tasklist` 都是 5.1s）。所以主进程里**绝不能**用
 * spawnSync —— 编排路径（进第 6 块时 ensureComfy → freeVramForComfy）会在几十秒里
 * 连续同步 spawn 好几次，主进程被堵到 100%，界面表现就是「点完下一步整个页面卡死」。
 * 一律走这里（异步 + 超时兜底），失败返回 ok:false，由调用方降级。
 */
function runCmd(exe, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const finish = (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : (err ? -1 : 0);
      resolve({ ok: !err, code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    };
    const opts = { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf-8' };
    try {
      execFile(exe, args, opts, (err, stdout, stderr) => {
        // PATH 偶发解析不到（环境差异）→ 用 shell 再兜一次；异步，不会阻塞 UI
        if (err && err.code === 'ENOENT') {
          try { execFile(exe, args, { ...opts, shell: true }, (e2, o2, s2) => finish(e2, o2, s2)); return; }
          catch (_) { /* 落到下面 */ }
        }
        finish(err, stdout, stderr);
      });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String((e && e.message) || e) });
    }
  });
}

/** 显存查询结果的短缓存（1.2s）：轮询路径别把 nvidia-smi 打爆 */
let _vramCache = { at: 0, v: -1 };
const VRAM_TTL = 1200;

/** 当前 GPU 显存占用（MiB），拿不到返回 -1。**异步**，绝不阻塞主进程 */
async function vramUsed() {
  if (Date.now() - _vramCache.at < VRAM_TTL) return _vramCache.v;
  const r = await runCmd('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], 12000);
  let v = -1;
  if (r.ok) {
    const parts = String(r.stdout || '').trim().split(',');
    const n = Number((parts[0] || '').trim());
    if (Number.isFinite(n)) v = n;
  }
  _vramCache = { at: Date.now(), v };
  return v;
}

/** llama-server 是否在运行（tasklist 查进程，比 HTTP 更可靠——服务卡死时也算在跑） */
async function llamaRunning() {
  const r = await runCmd('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe', '/NH'], 15000);
  return r.stdout.includes('llama-server');
}

/** 停止 llama-server，释放它常驻的约 10.6GB 显存 */
async function stopLlama() {
  if (!(await llamaRunning())) return { ok: true, already: true, message: 'llama-server 未在运行' };
  const r = await runCmd('taskkill', ['/IM', 'llama-server.exe', '/F'], 15000);
  return {
    ok: r.ok,
    message: r.ok ? 'llama-server 已停止（已让出显存）' : '停止 llama-server 失败：' + String(r.stderr || '').trim()
  };
}

/**
 * 同步版 stopLlama：**只给「软件退出」这种一次性路径用**。
 * 退出时进程马上要没了，必须保证 taskkill 真的执行完，这时卡一下无所谓；
 * 界面运行路径一律用上面的异步 stopLlama。
 */
function stopLlamaSync() {
  try {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe', '/NH'], { encoding: 'utf-8', windowsHide: true }).stdout || '';
    if (!out.includes('llama-server')) return { ok: true, already: true, message: 'llama-server 未在运行' };
    const r = spawnSync('taskkill', ['/IM', 'llama-server.exe', '/F'], { encoding: 'utf-8', windowsHide: true });
    return r.status === 0
      ? { ok: true, message: 'llama-server 已停止（已让出显存）' }
      : { ok: false, message: '停止 llama-server 失败：' + String(r.stderr || '').trim() };
  } catch (e) {
    return { ok: false, message: '停止 llama-server 异常：' + ((e && e.message) || e) };
  }
}

/** 等显存回落到阈值以下（返回实际值）；超时也返回，由调用方决定 */
async function waitVramBelow(thresholdMiB, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const now = await vramUsed();
    if (now >= 0 && now < thresholdMiB) return { ok: true, vram: now, waited: Date.now() - t0 };
    if (Date.now() - t0 >= timeoutMs) return { ok: false, vram: now, waited: Date.now() - t0 };
    await new Promise(r => setTimeout(r, 1000));
  }
}

/**
 * 让 ComfyUI 卸载显存里的模型（SDXL / H3），进程留着。
 * ComfyUI 的 /free 是秒级操作，比杀掉 Desktop 再冷启动（30-60s）划算得多。
 */
async function unloadComfyModels() {
  const h = await inference.health();
  if (!h.comfyui) return { ok: true, already: true, message: 'ComfyUI 未在运行，无需卸载模型' };
  const before = await vramUsed();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(inference.endpoint('comfyui') + '/free', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: ctrl.signal
    }).finally(() => clearTimeout(t));
    if (!r.ok) return { ok: false, message: 'ComfyUI 卸载模型返回 ' + r.status };
    return { ok: true, message: 'ComfyUI 已卸载模型（释放显存）', before };
  } catch (e) {
    return { ok: false, message: 'ComfyUI 卸载模型失败：' + ((e && e.message) || e) };
  }
}

/**
 * 进入 ComfyUI 重负载阶段（出图 / 出视频）前的显存编排：
 * 停掉 llama-server 并等显存真正回落到阈值以下。
 * @param {string} label 阶段名，用于日志
 * @param {number} thresholdMiB 认为「显存已够用」的阈值
 */
async function freeVramForComfy(label, thresholdMiB = 9000) {
  const before = await vramUsed();
  const res = await stopLlama();
  const lines = [res.message + (res.already ? '（当前 ' + before + ' MiB）' : '（原 ' + before + ' MiB）')];
  if (res.already) return { ok: true, freed: false, lines, vram: before };
  if (!res.ok) return { ok: false, freed: false, lines: lines.concat(res.message), vram: before };

  const w = await waitVramBelow(thresholdMiB, 20_000);
  if (w.ok) {
    lines.push('显存已回落到 ' + w.vram + ' MiB，可以开始');
    return { ok: true, freed: true, lines, vram: w.vram };
  }
  lines.push('显存当前 ' + w.vram + ' MiB（未达 ' + thresholdMiB + ' MiB，仍继续）');
  return { ok: true, freed: true, lines, vram: w.vram };
}

/** 后台服务的日志文件路径（设置页/排错用） */
function serviceLogs() {
  const out = {};
  for (const n of ['llama-server', 'comfyui']) {
    const p = serviceLogPath(n);
    let size = 0, mtime = '';
    try { if (p && isFile(p)) { size = fs.statSync(p).size; mtime = fs.statSync(p).mtime.toISOString(); } } catch (_) {}
    out[n] = { path: p, exists: !!size, size, mtime, tail: tailFile(p, 3) };
  }
  return out;
}

module.exports = {
  init, llamaInfo, comfyInfo, startLlama, startComfy, comfyStartElapsedMs, setDir,
  getLlamaArgs, setLlamaArgs, findFile, DEFAULT_LLAMA_ARGS,
  vramUsed, waitVramBelow, stopLlama, stopLlamaSync, llamaRunning, unloadComfyModels, freeVramForComfy,
  waitHealth, spawnSilent, serviceLogPath, serviceLogs, tailFile, splitArgs, runCmd
};
