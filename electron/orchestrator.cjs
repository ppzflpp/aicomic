'use strict';
/**
 * 阶段引擎编排（16GB 显存的硬约束）。
 *
 * 背景（实测）：llama-server 常驻约 10.6GB，SDXL 出图峰值到 15.2GB，
 * H3 主模型 int8 近 20GB 靠动态换页 —— 三者不可能同时住在 16GB 卡上。
 * 所以「哪个阶段就启哪个引擎，用完就让出显存」是必须的，不是优化。
 *
 * 阶段 → 引擎 映射：
 *   1 章节输入   ：无引擎（纯文本）
 *   2 漫剧化改编 ：llama（ComfyUI 模型卸载）
 *   3 分镜脚本   ：llama
 *   4 角色出图   ：ComfyUI + SDXL  ← 先停 llama
 *   5 H3 提示词  ：llama           ← 先让 ComfyUI 卸载 SDXL（腾显存给 llama）
 *   6 视频生成   ：ComfyUI + H3    ← 先停 llama
 *   7 组装成片   ：ffmpeg（纯 CPU）← 两个引擎都关掉
 *
 * ComfyUI 的「关闭」采用**进程常驻 + 模型按需装卸**（POST /free，秒级）；
 * 杀进程要冷启动 30-60 秒，得不偿失。
 *
 * 双保险：这里既提供 ensure(phase)（阶段进入时预热），
 * 也被 ipc.cjs 的 infer:llm / comfy:generate 当作守卫调用 ——
 * 无论用户点哪个按钮，都会自动落到正确的引擎状态。
 */
const launcher = require('./launcher.cjs');
const inference = require('./inference.cjs');
const logger = require('./logger.cjs');

let db = null;

const AUTO_KEY = 'engine.autoOrchestrate';

/** 阶段表：序号与界面上的 1-7 块一一对应 */
const PHASES = [
  { key: 'chapter', name: '阶段1 章节输入', engines: [] },
  { key: 'adapt', name: '阶段2 漫剧化改编', engines: ['llm'] },
  { key: 'shots', name: '阶段3 分镜脚本', engines: ['llm'] },
  { key: 'chars', name: '阶段4 角色出图', engines: ['comfy'] },
  { key: 'prompts', name: '阶段5 H3提示词', engines: ['llm'] },
  { key: 'videos', name: '阶段6 H3视频', engines: ['comfy'] },
  { key: 'export', name: '阶段7 组装成片', engines: [] }
];

/** llama 进 GPU 前需要约 10.6GB → 先等显存占用降到 7GB 以下 */
const VRAM_FOR_LLM = 7000;
/** 出图/出视频前等显存降到 9GB 以下 */
const VRAM_FOR_COMFY = 9000;

/** 「已经就绪」的短期缓存，避免每个请求都做一遍健康检查/显存轮询 */
const readyAt = { llm: 0, comfy: 0 };
const READY_TTL = 8000;

/** 单飞锁：App 预热与 IPC 守卫可能同一瞬间并发调用 ensure*，共享同一次执行 */
const inflight = {};
function singleFlight(key, fn) {
  if (inflight[key]) return inflight[key];
  inflight[key] = fn().finally(() => { inflight[key] = null; });
  return inflight[key];
}

function init(dbRef) { db = dbRef; }

function phaseName(i) {
  const p = PHASES[i];
  return p ? p.name : '阶段' + (Number(i) + 1);
}

/** 编排总开关（设置页可关；冒烟/离线调试时会关掉，避免测试时真的去拉引擎） */
function auto() { return !db || db.getSetting(AUTO_KEY) !== '0'; }
function setAuto(v) {
  if (db) db.setSetting(AUTO_KEY, v ? '1' : '0');
  return auto();
}

function invalidate(kind) {
  if (kind) readyAt[kind] = 0; else { readyAt.llm = 0; readyAt.comfy = 0; }
}

/* ------------------------------------------------------------------ */

/** 确保 llama（LLM）就绪：必要时先让 ComfyUI 卸载模型腾显存，再拉起 llama */
function ensureLlm(label) {
  return singleFlight('llm', () => _ensureLlm(label));
}

async function _ensureLlm(label) {
  const tag = label || logger.tag();
  logger.setTag(tag);
  if (!auto()) return { ok: true, skipped: true };
  if (Date.now() - readyAt.llm < READY_TTL) return { ok: true, cached: true };

  const h = await inference.health();
  if (h.llm) {
    readyAt.llm = Date.now();
    logger.detail('LLM 服务在线：' + inference.endpoint('llm'));
    return { ok: true, already: true };
  }

  logger.info('LLM 服务未运行 → 准备启动（需约 10.6GB 显存）');
  if (h.comfyui) {
    const u = await launcher.unloadComfyModels();
    logger[u.ok ? 'info' : 'warn'](u.message);
    if (u.ok) {
      const w = await launcher.waitVramBelow(VRAM_FOR_LLM, 30000);
      logger.info(w.ok ? '显存已回落到 ' + w.vram + ' MiB' : '显存当前 ' + w.vram + ' MiB（偏高，仍尝试启动）');
    }
  }

  const r = await launcher.startLlama();
  if (!r.ok) { logger.error('llama 启动失败：' + r.message); throw new Error(r.message); }
  if (!r.already) invalidate('llm');
  readyAt.llm = Date.now();
  return { ok: true, message: r.message };
}

/** 确保 ComfyUI 就绪：先停 llama 把显存全让出来，再确认 ComfyUI 在线 */
function ensureComfy(label) {
  return singleFlight('comfy', () => _ensureComfy(label));
}

async function _ensureComfy(label) {
  const tag = label || logger.tag();
  logger.setTag(tag);
  if (!auto()) return { ok: true, skipped: true };
  if (Date.now() - readyAt.comfy < READY_TTL) return { ok: true, cached: true };

  const h0 = await inference.health();
  if (h0.llm || (await launcher.llamaRunning())) {
    logger.info('ComfyUI 阶段需要全部显存 → 停止 llama-server');
    const res = await launcher.freeVramForComfy(tag, VRAM_FOR_COMFY);
    for (const l of res.lines) logger.info(l);
    invalidate('llm');
  }

  const h = await inference.health();
  if (!h.comfyui) {
    logger.info('ComfyUI 未运行 → 正在启动…');
    const r = await launcher.startComfy();
    if (!r.ok) { logger.error('ComfyUI 启动失败：' + r.message); throw new Error(r.message); }
    if (!r.ready && !r.already) {
      // startComfy 内部已等 150s，这里再兜底 120s（Desktop 偶发更慢）
      const ok = await launcher.waitHealth('comfyui', 120000, { label: 'ComfyUI', stepMs: 15000 });
      if (!ok) {
        const m = 'ComfyUI 启动超时（共约 270 秒）。请检查 ComfyUI 窗口是否有报错，或到 设置 → 环境检测 重新检测。';
        logger.error(m);
        throw new Error(m);
      }
      const total = launcher.comfyStartElapsedMs();
      logger.ok('ComfyUI 已就绪（冷启动较慢，延迟确认' + (total ? '，共 ' + (total / 1000).toFixed(1) + 's' : '') + '）');
    }
  } else {
    logger.detail('ComfyUI 服务在线：' + inference.endpoint('comfyui'));
  }
  readyAt.comfy = Date.now();
  return { ok: true };
}

/** 阶段 7 / 收尾：两个引擎都让出资源（ffmpeg 只用 CPU） */
async function shutdownAll(label) {
  const tag = label || logger.tag();
  logger.setTag(tag);
  const l = await launcher.stopLlama();
  if (!l.already) logger.info(l.message);
  const u = await launcher.unloadComfyModels();
  if (!u.already) logger[u.ok ? 'info' : 'warn'](u.message);
  invalidate();
  return { ok: true };
}

/** 进入某阶段时预热/让位（阶段序号与界面 1-7 块一致，传 0 基下标） */
async function ensure(phaseIndex) {
  const p = PHASES[phaseIndex];
  if (!p) return { ok: true };
  logger.setTag(p.name);
  if (!auto()) { logger.detail('（编排已关闭，跳过节启动）'); return { ok: true, skipped: true }; }
  if (!p.engines.length) {
    logger.info('本阶段不需要 GPU 引擎 → 释放显存（停 llama + 卸载 ComfyUI 模型）');
    return shutdownAll(p.name);
  }
  if (p.engines.includes('comfy')) return ensureComfy(p.name);
  return ensureLlm(p.name);
}

module.exports = {
  init, ensure, ensureLlm, ensureComfy, shutdownAll,
  phaseName, PHASES, auto, setAuto, invalidate, AUTO_KEY
};
