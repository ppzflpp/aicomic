'use strict';
/**
 * 系统监控采样（主进程）：CPU / 内存 / GPU。
 *
 * - CPU：os.cpus() 累计 tick 与上次做差 → 总体利用率（跨全核平均）
 * - 内存：os.totalmem() / os.freemem()
 * - GPU：nvidia-smi（异步 execFile，不阻塞主进程）
 *      utilization.gpu / memory.used / memory.total / temperature.gpu
 *   每 N 次采样附带一次「哪个进程在占显存」（llama-server / python），
 *   方便用户在标题栏直接看出「现在是 llama 在占卡还是 ComfyUI 在占卡」。
 *
 * 注意：Windows 任务管理器默认显示的是 3D 引擎利用率，而 CUDA 计算算在
 * Compute 引擎里 —— 即使满载任务管理器也可能显示很低。这里读的是
 * nvidia-smi 的真实数字，不会被这个现象误导。
 *
 * 没有 N 卡 / 驱动异常时优雅降级：gpu.ok = false，前端显示「—」，
 * 连续失败会退避，避免反复 spawn 一个卡住的进程。
 */
const os = require('os');
const { execFile } = require('child_process');

let db = null;
let getWin = null;
let timer = null;
let prevCpus = null;
let tick = 0;
let gpuFails = 0;
let lastProcs = [];
let sampling = false;

function init(dbRef, getWinRef) {
  db = dbRef || null;
  getWin = getWinRef || null;
}

/* ---------------- CPU ---------------- */

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

/** 与上次采样的差值算利用率；首次采样返回 0（没有参照） */
function cpuLoad() {
  const now = cpuTimes();
  if (!prevCpus) { prevCpus = now; return 0; }
  const dIdle = now.idle - prevCpus.idle;
  const dTotal = now.total - prevCpus.total;
  prevCpus = now;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
}

/* ---------------- GPU ---------------- */

/* 超时 10s：实测 ComfyUI/llama 持有 CUDA 上下文时 nvidia-smi 要 5s+ 才返回（2026-09-18，
 * RTX 5060 Ti + ComfyUI 常驻，稳定 5.1s）。4s 会让标题栏 GPU 芯片一直显示「—」，
 * 而那恰恰是用户最需要看显存的时候。sampling 互斥锁保证了慢查询不会堆积。 */
function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) resolve(null);
        else resolve(String(stdout || ''));
      });
    } catch (_) { resolve(null); }
  });
}

function num(v) { const n = Number(String(v).trim()); return Number.isFinite(n) ? n : null; }

async function gpuSample() {
  const out = await run('nvidia-smi', [
    '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
    '--format=csv,noheader,nounits'
  ]);
  if (out === null) return null;
  const line = out.trim().split(/\r?\n/)[0] || '';
  if (!line) return null;
  const parts = line.split(',').map(s => s.trim());
  if (parts.length < 5) return null;
  // 显卡名可能含逗号 → 取后 4 段当数值，其余拼回名字
  const tail = parts.slice(-4);
  const name = parts.slice(0, parts.length - 4).join(', ') || 'GPU';
  const g = {
    ok: true, name,
    util: num(tail[0]),
    usedMiB: num(tail[1]),
    totalMiB: num(tail[2]),
    tempC: num(tail[3]),
    procs: lastProcs
  };
  if (g.usedMiB != null && g.totalMiB) g.memPercent = Math.round(g.usedMiB / g.totalMiB * 100);
  return g;
}

async function gpuProcs() {
  const out = await run('nvidia-smi', [
    '--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'
  ]);
  if (!out) return [];
  return out.trim().split(/\r?\n/).filter(Boolean).map(l => {
    const p = l.split(',').map(s => s.trim());
    const exe = (p[1] || '').split(/[\\/]/).pop() || p[1] || '';
    return { pid: num(p[0]), name: exe, memMiB: num(p[2]) };
  }).filter(p => p.memMiB);
}

/* ---------------- 采样 / 推送 ---------------- */

async function sample() {
  const total = os.totalmem();
  const free = os.freemem();
  const snap = {
    t: Date.now(),
    cpu: { load: cpuLoad(), cores: os.cpus().length, model: (os.cpus()[0] || {}).model || '' },
    mem: {
      total, free, used: total - free,
      percent: total ? Math.round((total - free) / total * 100) : 0
    },
    gpu: null
  };

  // GPU 退避：连续失败 3 次后改成每 10 次采样才重试一次
  const shouldTryGpu = gpuFails < 3 || tick % 10 === 0;
  if (shouldTryGpu) {
    const g = await gpuSample();
    if (g) { gpuFails = 0; snap.gpu = g; } else { gpuFails++; snap.gpu = null; }
  } else {
    snap.gpu = null;
  }
  // 进程占用每 4 次采样刷新一次（6 秒左右）
  if (tick % 4 === 0 && snap.gpu) {
    try { lastProcs = await gpuProcs(); snap.gpu.procs = lastProcs; } catch (_) {}
  }
  tick++;
  return snap;
}

function push(snap) {
  try {
    const w = getWin ? getWin() : null;
    if (w && !w.isDestroyed() && w.webContents) w.webContents.send('metrics:tick', snap);
  } catch (_) {}
}

/** 采样一次并返回（供渲染层首帧 / 手动刷新用） */
async function once() {
  const s = await sample();
  return s;
}

function start(intervalMs = 1500) {
  stop();
  // 先采一次建立 CPU 基线（否则第一帧永远是 0）
  cpuTimes();
  prevCpus = cpuTimes();
  const loop = async () => {
    if (sampling) return;
    sampling = true;
    try { push(await sample()); } catch (_) {} finally { sampling = false; }
  };
  loop();
  timer = setInterval(loop, intervalMs);
  if (timer.unref) timer.unref();
  return true;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  return true;
}

module.exports = { init, start, stop, once, sample };
