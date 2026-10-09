'use strict';
/**
 * 真实推理网关：LLM(llama.cpp server) / ComfyUI / ffmpeg
 * - LLM：OpenAI 兼容 API（llama-server），端点可在设置中配置
 * - ComfyUI：/prompt 提交工作流 JSON + 轮询 /history + /view 拉取产物
 * - ffmpeg：workspace/tools/ffmpeg.exe 或 PATH 或设置中自定义路径
 * 全部为真实调用；服务不可达时抛出带指引的错误。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');
const { writeUnique, sanitize } = require('./assetStore.cjs');
const models = require('./models.cjs');
const videoTiers = require('./videoTiers.cjs');
const profiles = require('./profiles.cjs');
const projects = require('./projects.cjs');
const logger = require('./logger.cjs');

let db = null;
let workspace = null;
/* ffmpeg 路径缓存：undefined=还没解析 / null=确实没有 / string=解析到的路径。
   'where ffmpeg' 在这台机器上稳定要 5.1s（2026-09-18 实测），而健康检查每 5s 跑一次 ——
   同步 spawn 会让主进程 100% 被堵住，所有 IPC 都要排队 5s（UI 卡成 PPT）。 */
let ffmpegCache;
let ffmpegWarming = false;

function init(dbRef) {
  db = dbRef;
  profiles.init(dbRef);   // 模型方案就位后，工作流路径 / 节点锚点 / 帧参数才有得读
  warmFfmpeg();   // 异步预热：'where ffmpeg' 在某些机器上要 5s，绝不能卡在同步路径上
}

function ws() {
  if (!workspace) workspace = db.getSetting('workspace');
  return workspace;
}

/** 换工作区时必须清掉缓存，否则模板/ffmpeg 路径会继续认旧工作区 */
function forgetWorkspace() {
  workspace = null;
  ffmpegCache = undefined;   // tools/ffmpeg.exe 也跟着工作区走
}

function endpoint(key) {
  return db.getSetting('endpoint.' + key) || (key === 'llm' ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:8188');
}

function setEndpoint(key, url) {
  db.setSetting('endpoint.' + key, String(url || '').trim());
}

async function fetchJson(url, opts = {}, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
    return { status: r.status, ok: r.ok, json };
  } finally { clearTimeout(t); }
}

/* ---------------- 健康检查 ---------------- */

async function health() {
  const out = { llm: false, comfyui: false, ffmpeg: false };
  try {
    const r = await fetchJson(endpoint('llm') + '/v1/models', {}, 1500);
    out.llm = r.ok;
  } catch (_) { /* not running */ }
  try {
    const r = await fetchJson(endpoint('comfyui') + '/system_stats', {}, 1500);
    out.comfyui = r.ok;
  } catch (_) { /* not running */ }
  out.ffmpeg = !!findFfmpeg();
  out.endpoints = { llm: endpoint('llm'), comfyui: endpoint('comfyui') };
  return out;
}

/* ---------------- LLM ---------------- */

/**
 * LLM 对话（OpenAI 兼容，llama-server）。
 *
 * 两个必须的适配（2026-09 实测于 llama.cpp b11012 + Qwen3.5）：
 * 1) 走流式（stream:true）。非流式时 llama-server 要等整段生成完才发响应头，
 *    Node 内置 fetch(undici) 的 headersTimeout 是 300s，长文本必然被掐断（fetch failed）。
 *    流式下响应头 ~180ms 就返回，且能持续读增量。
 * 2) 默认关闭思考模式（chat_template_kwargs.enable_thinking=false）。Qwen3.5 默认先吐
 *    大段 reasoning_content，content 为空；9B 模型仅 ~9 tok/s，开着思考会白烧几分钟。
 */
async function llmChat(messages, { temperature = 0.7, maxTokens = 4096, json = false, thinking = false, timeoutMs = 900000, onDelta = null } = {}) {
  const t0 = Date.now();
  const userLen = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  logger.detail('LLM 请求：输入约 ' + userLen + ' 字，max_tokens=' + maxTokens + (json ? '，JSON 模式' : ''));
  // 软护栏（2026-09-27）：按本机 Qwen3.5 实测换算率（1 中文字 ≈ 0.64 token）估算总量，
  // 接近每槽 -c 32768 上限时提前警告（输出预算会被压缩）——只提示、不拦截。
  const estIn = Math.round(userLen * 0.64);
  if (estIn + maxTokens > 30000) {
    logger.warn('LLM 上下文吃紧：输入约 ' + userLen + ' 字（≈' + estIn + ' tok）+ max_tokens=' + maxTokens +
      ' ≈ ' + (estIn + maxTokens) + ' tok，已接近单槽 32768 上限，建议精简规范或章节原文');
  }
  // 先快速探活（1.5s），避免连接挂起时用户干等
  let alive = false;
  try { alive = (await fetchJson(endpoint('llm') + '/v1/models', {}, 1500)).ok; } catch (_) {}
  if (!alive) throw new Error('LLM 服务不可达（' + endpoint('llm') + '）。软件会自动拉起 llama-server；'
    + '若反复起不来，看右下角「运行日志」，或到 设置 → 高级设置 检查 llama.cpp 安装目录。');

  const body = {
    model: 'local',
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
    chat_template_kwargs: { enable_thinking: !!thinking }
  };
  if (json) body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(endpoint('llm') + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error('LLM 请求失败（连接中断或超时）：' + (e && e.message || e));
  }
  if (!res.ok) {
    clearTimeout(timer);
    let t = '';
    try { t = await res.text(); } catch (_) {}
    throw new Error('LLM 返回错误 ' + res.status + ': ' + t.slice(0, 300));
  }

  let content = '', reasoning = '', finishReason = '';
  try {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j = null;
        try { j = JSON.parse(payload); } catch (_) { continue; }
        const c0 = j.choices && j.choices[0];
        const d = c0 && c0.delta;
        if (c0 && c0.finish_reason) finishReason = c0.finish_reason;
        if (!d) continue;
        if (d.content) { content += d.content; if (onDelta) { try { onDelta(d.content, content); } catch (_) {} } }
        if (d.reasoning_content) reasoning += d.reasoning_content;
      }
    }
  } finally { clearTimeout(timer); }

  if (!content) {
    if (reasoning) throw new Error('模型只输出了思考内容、没有正文（max_tokens=' + maxTokens + ' 可能被思考耗尽）。请确认已关闭思考模式或增大 max_tokens。');
    throw new Error('LLM 返回内容为空');
  }
  // 输出被 max_tokens 掐断时明确报错（此前静默返回半截 JSON / 半篇改编稿，下游才爆错，难排查）
  if (finishReason === 'length') {
    throw new Error('LLM 输出被 max_tokens=' + maxTokens + ' 截断（finish_reason=length，已生成 ' +
      content.length + ' 字）。请到设置里调大输出上限，或精简规范 / 拆短章节。');
  }
  logger.done('LLM 返回 ' + content.length + ' 字' + (finishReason ? '（finish=' + finishReason + '）' : ''), Date.now() - t0);
  return content;
}

/** 提取 JSON（容忍 ```json 围栏与前后杂文本） */
function extractJson(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = m ? m[1] : text;
  const start = raw.search(/[[{]/);
  if (start < 0) throw new Error('LLM 输出中未找到 JSON');
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
  return JSON.parse(raw.slice(start, end > start ? end + 1 : undefined));
}

/** 从任意 JSON 值里取出数组：裸数组直接用；对象则找第一个数组字段（json_object 模式会包一层） */
function pickArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const k of ['shots', '镜头', '镜头列表', 'list', 'items', 'data', 'result', 'characters', 'prompts']) {
      if (Array.isArray(v[k])) return v[k];
    }
    for (const k of Object.keys(v)) if (Array.isArray(v[k])) return v[k];
  }
  return null;
}

/* ---------------- ffmpeg ---------------- */

/**
 * 定位 ffmpeg。
 * 性能要点（2026-09-18 修）：`where ffmpeg` 在本机稳定耗时 5.1s，
 * 而前端每 5s 轮询一次健康检查 —— 同步调用会把主进程堵死，整个 UI 每步操作都要等 5s。
 * 所以这里改成：启动时异步预热 + 结果缓存，健康检查永远不阻塞。
 *   - 自定义路径 / 工作区 tools/ 命中 → 立刻返回，且不受缓存影响（改了设置马上生效）
 *   - 缓存已解析 → 直接返回
 *   - 预热中 → 返回 null（这一轮健康检查先算「没找到」，下一轮就准了）
 *   - forceSync → 真的同步查一次（导出这种一次性长任务用，保证准确性）
 */
function findFfmpeg(opts) {
  const custom = db.getSetting('ffmpeg.path');
  if (custom && fs.existsSync(custom)) return custom;
  const wsTool = path.join(ws() || '', 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(wsTool)) return wsTool;
  if (opts && opts.forceSync) return resolveFfmpegSync();
  if (ffmpegCache !== undefined) return ffmpegCache;
  if (ffmpegWarming) return null;
  return resolveFfmpegSync();
}

function resolveFfmpegSync() {
  const bin = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(bin, ['ffmpeg']);
  let p = null;
  if (r.status === 0) {
    const line = String(r.stdout).split(/\r?\n/)[0].trim();
    if (line && fs.existsSync(line)) p = line;
  }
  ffmpegCache = p;
  return p;
}

/** 启动时异步解析 ffmpeg（非阻塞），之后所有查询走缓存 */
function warmFfmpeg() {
  if (ffmpegWarming || ffmpegCache !== undefined) return;
  ffmpegWarming = true;
  const bin = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFile(bin, ['ffmpeg'], { timeout: 20000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      const line = String(stdout || '').split(/\r?\n/)[0].trim();
      ffmpegCache = (!err && line && fs.existsSync(line)) ? line : null;
      ffmpegWarming = false;
    });
  } catch (_) { ffmpegCache = null; ffmpegWarming = false; }
}

/* ---------------- ComfyUI 工作流执行 ---------------- */

/** 生成入口 → 模型方案用途：生图（角色 / 场景）走 image，视频走 video */
const TEMPLATE_KIND = { character: 'image', video: 'video' };

/**
 * 工作流模板路径。
 * key = 'character'（生图）/ 'video'（视频）/ 方案 id（直接指定某套方案）。
 * 路径由「模型方案」的 workflow 字段给出（相对工作区，如 workflows/video_h3.json）——
 * 换模型时改的是方案 JSON，这里不用动。
 */
function workflowPath(key) {
  const kind = TEMPLATE_KIND[key];
  const p = kind ? profiles.active(kind) : profiles.get(key);
  if (p && p.workflow) return path.join(ws() || '', p.workflow);
  // 兜底：老的 workflows/<key>.json 约定（方案被删 / 配置写坏时不至于直接崩）
  return path.join(ws() || '', 'workflows/' + key + '.json');
}

/**
 * 首次运行把内置工作流模板补到工作区（electron/workflows/*.json → <工作区>/workflows/）。
 * 缺哪份补哪份；已存在的一律不动（用户可能自己改过参数）。
 *
 * 2026-10-09（Dragon）：删掉 SDXL（character.json）与 Z-Image Turbo
 *   （character_zimage_turbo.json）的专属播种 / 升级特例 —— 这两个方案已下线，
 *   上面的通用播种已覆盖全部内置模板 —— 角色模板生成 / 升级那两个函数
 *   与 LEGACY_CHAR_IDS 常量一并移除。
 */
function ensureDefaultTemplates() {
  const w = ws();
  if (!w) return;
  const dir = path.join(w, 'workflows');
  fs.mkdirSync(dir, { recursive: true });

  // —— 通用播种：内置 electron/workflows/ 里的模板，工作区缺哪份补哪份 ——
  // 每个「模型方案」的 workflow 字段都指向这里（如 workflows/video_h3.json）。
  // 用户改过的一律不动（存在即跳过），所以这里只负责「第一次运行把文件放到位」。
  const builtin = path.join(__dirname, 'workflows');
  let builtinNames = [];
  try { builtinNames = fs.readdirSync(builtin).filter(f => /\.json$/i.test(f)); } catch (_) { builtinNames = []; }
  for (const n of builtinNames) {
    const dst = path.join(dir, n);
    if (fs.existsSync(dst)) continue;
    try {
      fs.copyFileSync(path.join(builtin, n), dst);
      logger.info('工作流模板已就位：workflows/' + n);
    } catch (_) { /* 忽略 */ }
  }

  // —— H3 视频：2026-09 起改为 __H3_UNET__ + 运行时注入「首/尾帧、参考图、参考视频」——
  // 老内置模板用的是 __H3_FL2VA__ / __H3_TURBO_LORA__ 写法，遇到就自动换成新版。
  const bv = path.join(__dirname, 'workflows', 'video_h3.json');
  const tv = path.join(dir, 'video_h3.json');
  let needVideo = !fs.existsSync(tv);
  if (!needVideo) {
    try {
      const cur = fs.readFileSync(tv, 'utf-8');
      if (cur.includes('__H3_FL2VA__') || cur.includes('__H3_TURBO_LORA__')) needVideo = true;
    } catch (_) { /* 读不到就按不需要处理 */ }
  }
  if (needVideo && fs.existsSync(bv)) {
    try {
      fs.copyFileSync(bv, tv);
      if (fs.existsSync(tv)) logger.info('H3 视频工作流模板已更新：支持首帧/尾帧/参考图/参考视频');
    } catch (_) { /* 忽略 */ }
  }
}

/**
 * 把本地图片/视频喂给 ComfyUI 的 input 目录。
 * ComfyUI 的 LoadImage / LoadVideo 只认自己的 input 目录，所以每次用到的素材
 * 都要先送一份副本过去（只作引擎输入，不动用户的原文件、不复制进工作区）。
 * 文件名统一转成 ASCII，避免中文/空格在 multipart 与 ComfyUI 侧出现编码问题。
 */
async function uploadToComfy(absPath) {
  const buf = fs.readFileSync(absPath);
  const ext = path.extname(absPath).toLowerCase() || '.png';
  // 文件名转纯 ASCII：中文名在 multipart 头 + ComfyUI 侧的编码组合下偶发丢失/乱码
  const stem = String(path.basename(absPath, ext))
    .replace(/[^\x20-\x7E]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'ref';
  const name = stem + '-' + Date.now().toString(36) + ext;
  const fd = new FormData();
  fd.append('image', new Blob([buf]), name);
  fd.append('overwrite', 'true');
  const r = await fetchJson(endpoint('comfyui') + '/upload/image', { method: 'POST', body: fd }, 120000);
  if (!r.ok || !r.json || !r.json.name) throw new Error('素材上传 ComfyUI 失败：' + path.basename(absPath));
  return r.json.subfolder ? r.json.subfolder + '/' + r.json.name : r.json.name;
}

/**
 * 占位符替换。值为 null/undefined 的跳过（留给后面的未解析检查报错），
 * 避免把 "null" 字符串写进工作流导致 ComfyUI 报「模型不存在」。
 */
/**
 * 文本级占位符替换（必须在 JSON.parse 之前做，这样数值占位符可以裸露书写：
 *   "width": __WIDTH__   ← 替换成 864
 *   "text": "__PROMPT__" ← 替换成带引号的 JSON 字符串
 * 处于引号内的值按 JSON 字符串转义替换，因此提示词里的引号/换行不会破坏 JSON。
 */
function applyParams(tplText, params) {
  let s = String(tplText);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    const ph = '__' + k.toUpperCase() + '__';
    const sv = String(v);
    s = s.split('"' + ph + '"').join(JSON.stringify(sv));  // ① 引号内（字符串位置）
    s = s.split(ph).join(sv);                              // ② 裸露（数值/布尔位置）
  }
  return s;
}

/** 找残留的 __XXX__ 占位符，用于给出「缺哪个模型」的明确提示 */
function findPlaceholders(x) {
  const m = String(typeof x === 'string' ? x : JSON.stringify(x)).match(/__[A-Z0-9_]+__/g);
  return m ? [...new Set(m)] : [];
}

/**
 * 视频生成参数（设置键 h3.width / h3.height / h3.seconds 仍作高级覆盖）。
 * 帧率 / 帧网格 / 秒数范围 / 宽高对齐粒度 / 默认宽高全部由「模型方案的 frames 段」给出 ——
 * 换个视频模型（帧网格与 fps 都不一样）只改方案，这里一行不用动。
 * 当前方案（H3）的 16GB 显存甜点：864x480、5 秒。
 *
 * 视频档位（三档）是**项目级**设置，在「新建项目 / 项目配置」里和分辨率一起选，
 * 存 projects.res_tier；生成时按 projectId 实时读库 —— 所以改档位对本项目
 * 所有剧集立即生效（分辨率不同：那只影响之后新建的剧集）。
 * 用户只选「快慢质量」，模型 / 步数 / 调度全部由方案的 tiers 段 + videoTiers.cjs 解析。
 *
 * @param {number} [projectId]
 * @param {object} [profile] 指定方案（不传 = 当前激活的视频方案）
 */
function h3Params(projectId, profile) {
  const p = profile || profiles.active('video');
  const f = (p && p.frames) || {};
  const fps = Number(f.fps) > 0 ? Number(f.fps) : 24;
  const grid = (Array.isArray(f.grid) && f.grid.length === 2) ? f.grid : [17, 5];
  const snapTo = Number(f.snap) > 0 ? Number(f.snap) : 32;
  const defW = (Array.isArray(f.default) && Number(f.default[0])) || 864;
  const defH = (Array.isArray(f.default) && Number(f.default[1])) || 480;
  const defSec = Number(f.defaultSeconds) > 0 ? Number(f.defaultSeconds) : 5;

  const num = (k, d) => { const v = Number(db.getSetting(k)); return Number.isFinite(v) && v > 0 ? v : d; };
  const snap = v => Math.max(snapTo, Math.round(v / snapTo) * snapTo);
  const width = snap(num('h3.width', defW));
  const height = snap(num('h3.height', defH));
  let length = Math.max(5, Math.round(num('h3.seconds', defSec) * fps));
  // 对齐帧网格（恒向上取：+周期 防负数取模向下减，见 2026-09-23 修复）
  length = length + ((grid[1] - (length % grid[0])) + grid[0]) % grid[0];
  const tier = tierOfProject(projectId, p);
  // 参考图缩放固定 match（蒸馏模型训练用 match，max 会偏离训练分布）；
  // 设置键 h3.refImageSize 与方案里的 params.refImageSize 都只作高级覆盖。
  const refImageSize = String(db.getSetting('h3.refImageSize') || '').trim() ||
    String((p && p.params && p.params.refImageSize) || '').trim() || 'match';
  // 步数由档位表给出；h3.steps 仅作高级手动覆盖（设置里默认不写这个键）
  const rawSteps = Number(db.getSetting('h3.steps'));
  const stepsOverride = Number.isFinite(rawSteps) && rawSteps > 0 ? Math.round(rawSteps) : null;
  return { width, height, length, fps, tier, refImageSize, stepsOverride };
}

/**
 * 解析本次生成用哪个档位：项目级优先（权威值，实时读库），
 * 老库/无项目上下文时回退旧的全局设置键 h3.quality，再回方案声明的默认档。
 */
function tierOfProject(projectId, profile) {
  const pid = Number(projectId);
  if (Number.isFinite(pid) && pid > 0) {
    try {
      const r = projects.getProjectRes(db, pid);
      if (r && r.tier) return r.tier;
    } catch (_) { /* 读库失败不阻塞生成，走兜底 */ }
  }
  return String(db.getSetting('h3.quality') || '') || videoTiers.defaultTier(profile);
}

/* ---------------- 媒体支路（首帧/尾帧/参考图/参考视频） ---------------- */

/**
 * 把「首帧/尾帧/参考图/参考视频」注入已经占位符替换好的工作流。
 *
 * 全部由「模型方案」的 wiring / nodes / classes 段驱动 —— 节点 id、运行时注入段的起始编号、
 * 条件节点类名、参考媒体的输入键名、首尾帧锚定方式，都是方案里声明的，代码里没有模型名：
 *   有参考图或参考视频 → 主条件节点换成「参考支路」的类名（如 MiniMaxH3ReferenceToVideo），
 *                        首尾帧改用锚点节点（如 MiniMaxH3AddGuide）钉在开头 / 结尾；
 *   没有参考            → 沿用主条件节点，首帧/尾帧是它自身的可选输入。
 *
 * 🔴 media 里的值一律是「ComfyUI input 目录里的文件名」（LoadImage / LoadVideo 只认那里）。
 * 返回 { condId, latentId, mode }，调用方据此改写「引导器 / 采样器」的连线。
 *
 * @param {object} wf        已解析的工作流图
 * @param {object} media     { first, last, refImages[], refVideos[], refImageSize }
 * @param {object} [profile] 模型方案（不传 = 当前激活的视频方案）
 */
function injectMedia(wf, media, profile) {
  const p = profile || profiles.active('video');
  const N = (p && p.nodes) || {};
  const C = (p && p.classes) || {};
  const Wg = (p && p.wiring) || {};
  const ids0 = Wg.nodeIds || {};

  const condId0 = N.conditioning;
  const condNode = condId0 ? wf[condId0] : null;
  if (!condNode || !condNode.inputs) {
    throw new Error('工作流里找不到主条件节点（方案 nodes.conditioning = ' + condId0 +
      '）—— 模型方案与工作流模板对不上，请检查这份方案的配置');
  }
  // 画布尺寸默认读条件节点自己的 width/height；宽高挂在别的节点上时（如 LTX 的宽高在
  // 空潜变量节点上），方案用 wiring.sizeFrom 指名 —— 首帧/尾帧要按这个尺寸缩放。
  const sizeNode = (Wg.sizeFrom && wf[Wg.sizeFrom] && wf[Wg.sizeFrom].inputs) ? wf[Wg.sizeFrom] : condNode;
  const W = sizeNode.inputs.width;
  const H = sizeNode.inputs.height;

  const pick = (v, d) => (v === undefined || v === null ? d : v);
  const id = {
    firstImg: String(pick(ids0.firstImg, 200)), firstScale: String(pick(ids0.firstScale, 201)),
    lastImg: String(pick(ids0.lastImg, 202)), lastScale: String(pick(ids0.lastScale, 203)),
    refImg: i => String(pick(ids0.refImg, 220) + i),
    refVid: i => String(pick(ids0.refVid, 230) + i),
    refVidComp: i => String(pick(ids0.refVidComp, 240) + i),
    guide: i => String(pick(ids0.guide, 90) + i)
  };

  const crop = Wg.frameCrop || {};
  const firstKey = Wg.firstKey || 'first_frame';
  const lastKey = Wg.lastKey || 'last_frame';
  const latentOut = pick(Wg.latentOutput, 1);
  const condOut = pick(Wg.condOutput, 0);

  // 首帧/尾帧都要先缩放到画布尺寸（首帧拉伸铺满、尾帧居中裁剪，和官方模板一致）；
  // 方案还可以再声明一道「方案专属的图片预处理」节点（如 LTX 需要 LTXVPreprocess），
  // 接口不改：addFrame 统一返回「该帧图片最终喂给模型的节点 id」。
  const prep = Wg.imagePrep || null;
  const addFrame = (imgId, scaleId, name, c) => {
    wf[imgId] = { class_type: 'LoadImage', inputs: { image: name } };
    wf[scaleId] = {
      class_type: 'ImageScale',
      inputs: { image: [imgId, 0], upscale_method: Wg.scaleMethod || 'lanczos', width: W, height: H, crop: c }
    };
    if (!prep || !prep.class) return scaleId;
    const pid = String(Number(imgId) + Number(pick(prep.idOffset, 100)));
    wf[pid] = { class_type: prep.class, inputs: { image: [scaleId, 0], ...(prep.params || {}) } };
    return pid;
  };

  const hasRef = (media.refImages || []).length > 0 || (media.refVideos || []).length > 0;
  // 帧锚点链：方案声明 framesViaGuide 时，首尾帧一律用锚点节点表达，不依赖「条件节点自带的可选输入」。
  // LTX 这类模型的锚点会把引导帧追加进 latent、且引导本身要正负两条 conditioning，只有这条路能表达。
  const viaGuide = Wg.framesViaGuide === true;

  if (!hasRef && !viaGuide) {
    // 主条件节点自身的可选输入：不接首帧就是纯文字，不接尾帧就是单帧引导
    if (media.first) condNode.inputs[firstKey] = [addFrame(id.firstImg, id.firstScale, media.first, crop.first || 'disabled'), 0];
    if (media.last) condNode.inputs[lastKey] = [addFrame(id.lastImg, id.lastScale, media.last, crop.last || 'center'), 0];
    return { condId: condId0, latentId: condId0, mode: 'flf' };
  }

  // 参考支路：主条件节点整体换成「参考」类名，参考媒体按方案声明的键名挂上去
  // （autogrow 动态输入名的实际格式是「父键.子键」，下标从 0 起）
  if (hasRef && !C.conditioningRef) {
    throw new Error('当前视频模型方案不支持参考图 / 参考视频（方案未声明 classes.conditioningRef）。' +
      '请去掉本镜头的参考素材，或到「设置 → 生成模型方案」换一个支持它们的模型。');
  }
  if (hasRef) {
    const ex = Wg.refExtra || {};
    const ins = { clip: condNode.inputs.clip, vae: condNode.inputs.vae };
    for (const [key, spec] of Object.entries(ex.beforePrompt || {})) ins[key] = refExtraValue(spec, N, media);
    ins.prompt = condNode.inputs.prompt;
    ins.width = W;
    ins.height = H;
    ins.length = condNode.inputs.length;
    for (const [key, spec] of Object.entries(ex.afterLength || {})) ins[key] = refExtraValue(spec, N, media);

    (media.refImages || []).forEach((name, i) => {
      const nid = id.refImg(i);
      wf[nid] = { class_type: 'LoadImage', inputs: { image: name } };
      ins[String(Wg.refImageKey || 'ref_images.ref_image_{i}').replace('{i}', i)] = [nid, 0];
    });
    (media.refVideos || []).forEach((name, i) => {
      const nid = id.refVid(i), cid = id.refVidComp(i);
      wf[nid] = { class_type: 'LoadVideo', inputs: { file: name } };
      wf[cid] = { class_type: 'GetVideoComponents', inputs: { video: [nid, 0] } };
      // 参考视频要的是帧序列（IMAGE），所以中间过一道 GetVideoComponents
      ins[String(Wg.refVideoKey || 'ref_videos.ref_video_{i}').replace('{i}', i)] = [cid, 0];
    });
    wf[condId0] = { class_type: C.conditioningRef || condNode.class_type, inputs: ins };
  }

  // 首尾帧锚点：参考支路下首尾帧不是原生输入，用锚点节点钉在开头 / 结尾；
  // 方案声明 framesViaGuide 时（LTX）非参考支路也走这里，于是三种模式共用一条链：
  //   无帧 = 纯文字、只有首帧 = 图生视频、首+尾 = 首尾帧过渡。
  // 「正负两条 conditioning」「引导帧会追加进 latent 所以要逐级往下串」都由方案开关声明，
  // 代码不认识任何模型名：不声明就是 H3 的老行为（只接 positive、latent 恒取条件节点）。
  const g = Wg.guide || {};
  const anchorFrame = g.anchorFrame || {};
  const chain = g.latentChain === true;
  const hasNeg = g.negOut !== undefined && g.negOut !== null;
  let condId = condId0;
  let condIdx = pick(g.baseCondOut, condOut);
  let negId = condId0;
  let negIdx = pick(g.baseNegOut, 1);
  let latId = chain ? String(pick(g.latentBase, N.latent || condId0)) : condId0;
  let latIdx = chain ? pick(g.baseLatentOut, 0) : latentOut;
  let gi = 0;
  const anchor = (frameIdx, scaleId) => {
    const gid = id.guide(gi++);
    const inputs = {
      positive: [condId, condIdx],
      latent: [latId, latIdx],
      frame_idx: frameIdx,
      vae: [N[g.vaeRole || 'videoVae'], 0],
      image: [scaleId, 0]
    };
    if (hasNeg) inputs.negative = [negId, negIdx];
    if (g.strength !== undefined && g.strength !== null) inputs.strength = Number(g.strength);
    wf[gid] = { class_type: g.class || C.guide || 'MiniMaxH3AddGuide', inputs };
    condId = gid; condIdx = pick(g.condOut, 0);
    if (hasNeg) { negId = gid; negIdx = pick(g.negOut, 1); }
    if (chain) { latId = gid; latIdx = pick(g.latentOut, 2); }
  };
  if (media.first) anchor(pick(anchorFrame.first, 0), addFrame(id.firstImg, id.firstScale, media.first, crop.first || 'disabled'));
  if (media.last) anchor(pick(anchorFrame.last, -1), addFrame(id.lastImg, id.lastScale, media.last, crop.last || 'center'));

  // 链尾改写接线：方案声明「哪个节点的哪个输入该接最终的 conditioning / latent」。
  // 由方案声明而不是写死（H3 只有引导器 + 采样器；LTX 还要把裁剪节点的正负条件一起接过来）。
  for (const t of (Array.isArray(Wg.condTargets) ? Wg.condTargets : [])) {
    const n = wf[t.node];
    if (!n || !n.inputs) continue;
    const neg = t.src === 'negative';
    n.inputs[t.key] = [neg ? negId : condId, pick(t.out, neg ? negIdx : condIdx)];
  }
  for (const t of (Array.isArray(Wg.latentTargets) ? Wg.latentTargets : [])) {
    const n = wf[t.node];
    if (!n || !n.inputs) continue;
    n.inputs[t.key] = [latId, pick(t.out, latIdx)];
  }

  return { condId, latentId: latId, negId, mode: hasRef ? 'ref' : 'flf' };
}

/** 参考支路里方案补充的固定输入：要么接某个节点的输出，要么取本次参数 */
function refExtraValue(spec, nodes, media) {
  if (!spec) return null;
  if (spec.node) return [nodes[spec.node], spec.output || 0];
  if (spec.param) {
    const v = media[spec.param];
    return (v === undefined || v === null || v === '') ? spec.default : v;
  }
  return null;
}

/** 兼容旧签名：老调用 / 离线自测按「当前激活的视频方案」注入 */
function injectH3Media(wf, media) { return injectMedia(wf, media, null); }

/** 静态兜底提示（只留「不属于任何方案槽位」的那几个特殊占位符） */
const PH_TIP_FALLBACK = {
  image: '本地参考图（图生图时由软件自动注入，模板里无需手填）'
};

/**
 * 占位符 → 缺件提示：告诉用户「缺的这个东西该放到哪个目录」。
 * 从当前模型方案的 assets 实时生成（槽位名 = 占位符名），
 * 所以换模型 / 改槽位名后提示自动跟着变，不用改代码。
 */
function phTips() {
  const tips = { ...PH_TIP_FALLBACK };
  for (const kind of ['image', 'video']) {
    const p = profiles.active(kind);
    if (!p) continue;
    for (const a of p.assets) {
      const where = a.dir + '（' + (a.label || a.slot) + '）';
      tips[a.slot] = where;
      for (const alias of a.alsoAs) tips[alias] = where;
    }
  }
  return tips;
}

/**
 * 可以缺省、缺了就自动摘掉对应节点的占位符（不报错）。
 * = 方案里标了 optional 的槽位（如加速 LoRA）+ 图生图用的 __IMAGE__。
 */
function optionalPlaceholders() {
  const out = new Set(['__IMAGE__']);
  for (const kind of ['image', 'video']) {
    const p = profiles.active(kind);
    if (!p) continue;
    for (const a of p.assets) {
      if (!a.optional) continue;
      out.add('__' + a.slot.toUpperCase() + '__');
      for (const alias of a.alsoAs) out.add('__' + alias.toUpperCase() + '__');
    }
  }
  return out;
}

/**
 * 提交工作流并等待完成，产物保存到 dir（走 assetStore 永不覆盖）。
 *
 * 角色图 params: { prompt, negative, seed, ckpt }
 * H3 视频 params: { prompt, seed } +
 *   image     首帧（本地路径，老接口，等价 firstFrame）
 *   firstFrame / lastFrame      本地路径
 *   refImages [] / refVideos [] 本地路径数组（有值即自动切到 ref2va 那一套）
 * 模型文件名（ckpt / h3_*）自动从 ComfyUI 的模型目录里解析，无需手填。
 * 返回 { files, seed }。
 */
/* ---------------- 空闲自动释放显存 ---------------- */
// 需求：生图/生视频任务结束后，5s 内没有新任务跟上，就让 ComfyUI 卸载模型释放显存。
// 为什么：H3 / SDXL 权重常驻显存（H3 11G+），空闲时白占 —— 显卡还要跑别的就被逼进共享显存。
// 代价：释放后下一次生成要重新加载权重（SDXL 秒级，H3 十几秒）；批量任务间隙短，不会触发。
const VRAM_FREE_IDLE_MS = 5000;
let vramFreeTimer = null;
let vramFreeGen = 0;   // 代际计数：防「timer 恰好到点 vs 新任务恰好提交」竞态把新任务的模型卸掉

function disarmVramFree() {
  if (vramFreeTimer) { clearTimeout(vramFreeTimer); vramFreeTimer = null; }
  vramFreeGen++;   // 新任务跟上 → 已触发、还在路上的释放请求全部作废
}

function armVramFree() {
  disarmVramFree();
  const gen = ++vramFreeGen;
  vramFreeTimer = setTimeout(() => { vramFreeTimer = null; freeComfyVram(gen); }, VRAM_FREE_IDLE_MS);
}

async function freeComfyVram(gen) {
  if (gen !== vramFreeGen) return;   // 已有新任务跟上，放弃释放
  // 双保险：释放前再看一眼队列，有任务在跑/排队就绝不卸载（否则会把正在用的模型卸掉）
  try {
    const q = await fetchJson(endpoint('comfyui') + '/queue', {}, 3000);
    if (!q.ok || !q.json) return;
    if ((q.json.queue_running || []).length || (q.json.queue_pending || []).length) return;
  } catch (_) { return; }   // ComfyUI 不可达，无事可做
  if (gen !== vramFreeGen) return;   // queue 检查有耗时，检查期间新任务可能已跟上，再确认一次
  try {
    await fetchJson(endpoint('comfyui') + '/free', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true })
    }, 8000);
    logger.info('空闲 ' + Math.round(VRAM_FREE_IDLE_MS / 1000) + 's 无新任务，已让 ComfyUI 卸载模型释放显存（下次生成会先重新加载）');
  } catch (_) { /* 不可达就算了，下个任务自己会重试 */ }
}

/** 对外入口：进来取消挂起的释放（新任务跟上）；出去（成功/失败都算任务结束）开始空闲倒计时 */
async function comfyGenerate(args) {
  disarmVramFree();
  try {
    return await comfyGenerateInner(args);
  } finally {
    armVramFree();
  }
}

async function comfyGenerateInner({ templateKey, dir, baseName, params = {}, timeoutMs = 1800000 }) {
  const tplFile = workflowPath(templateKey);
  if (!fs.existsSync(tplFile)) {
    throw new Error('工作流模板缺失：' + tplFile + '。请先在 workspace/workflows/ 放置对应工作流 JSON（规范见 README）。');
  }
  const tplText = fs.readFileSync(tplFile, 'utf-8');

  const isVideo = templateKey === 'video';
  const refImages = Array.isArray(params.refImages) ? params.refImages.filter(Boolean) : [];
  const refVideos = Array.isArray(params.refVideos) ? params.refVideos.filter(Boolean) : [];
  const wantFirst = params.firstFrame || params.image || null;
  const wantLast = params.lastFrame || null;
  const refMode = refImages.length > 0 || refVideos.length > 0;

  // 本次生成用哪套模型方案 —— 代码不再认任何模型名，一切从方案里读
  const imgP = profiles.active('image');
  const vidP = profiles.active('video');
  const vidN = (vidP && vidP.nodes) || {};
  const vidC = (vidP && vidP.classes) || {};

  // 模型文件名：用户显式传入优先，其次从「模型方案」声明的槽位自动解析；
  // 视频模板额外注入分辨率 / 帧数 / 步数（设置可改，params 可覆盖）
  let realParams;
  if (isVideo) {
    const A = models.resolveAssets('video');
    const p = { ...models.workflowModels(), ...h3Params(params.projectId, vidP) };
    const f = (vidP && vidP.frames) || {};
    const fps = Number(f.fps) > 0 ? Number(f.fps) : 24;
    const grid = (Array.isArray(f.grid) && f.grid.length === 2) ? f.grid : [17, 5];
    const secRange = (Array.isArray(f.seconds) && f.seconds.length === 2) ? f.seconds : [4, 15];
    // 秒数按「分镜脚本该镜头的 dur」走（渲染端传 seconds，边界由方案声明）；
    // 没传才回退设置键 h3.seconds。两者都自动对齐到方案声明的帧网格。
    const sec = Number(params.seconds);
    if (Number.isFinite(sec) && sec > 0) {
      const sv = Math.max(secRange[0], Math.min(secRange[1], Math.round(sec)));
      const L = sv * fps;
      // 恒向上对齐网格（+周期 防负数取模向下减：4s 曾被砍成 3.75s，台词被截）
      p.length = L + ((grid[1] - (L % grid[0])) + grid[0]) % grid[0];
      p.seconds = sv;
    }
    // 权重与加速 LoRA 必须「档位 × 支路」成对解析（方案的 tiers 段 + videoTiers.cjs）：
    // 有参考媒体 → 参考支路，否则首尾帧支路；档位只决定「快慢质量」，模型细节用户不可见
    const family = videoTiers.branchKey(refMode, vidP);
    const loraFiles = (A.byRole.lora && A.byRole.lora.files) || [];
    const tierRes = videoTiers.resolve(vidP, p.tier, family, loraFiles);
    p.tierRes = tierRes;
    // 参考支路专用权重优先，没有就退回主线权重（角色名由方案声明，不是写死的键名）
    p.h3_unet = refMode
      ? ((A.byRole.unetRef && A.byRole.unetRef.name) || (A.byRole.unet && A.byRole.unet.name))
      : (A.byRole.unet && A.byRole.unet.name);
    p.h3_lora = tierRes.lora;                       // null = 基础模型直跑（摘 LoRA 节点）
    p.steps = p.stepsOverride || tierRes.steps;     // h3.steps 仅作高级手动覆盖
    p.h3_shift = tierRes.shift;                     // [v,a] 需注入 σ-shift 节点；null 不注入
    // 采样序列：蒸馏模型（LTX-2.5）的 sigma 网格是训练时定死的，由档位直接给字符串
    // （ManualSigmas 节点）。走 LoRA 步数派的模型（H3）不声明，模板里也没有这个占位符。
    p.sigmas = tierRes.sigmas || (vidP && vidP.params && vidP.params.sigmas) || null;
    p.tierLabel = videoTiers.labelOf(vidP)[tierRes.tier] || tierRes.tier;
    // conditioning / latent 的连接目标；注入媒体支路后会由 injectMedia 改写
    p.cond_id = vidN.conditioning || '16';
    p.latent_id = p.cond_id;
    realParams = { ...p, ...params };
  } else {
    realParams = { ...models.workflowModels(), ...params };
    const N = (imgP && imgP.nodes) || {};
    const i2i = (imgP && imgP.i2i) || {};
    const i2iOn = !!(i2i.enabled !== false && N.i2iImage && N.i2iEncode);
    // 角色图「图生图」：选了已生成的图 → 走参考图编码出的潜变量 + 较低 denoise；否则空潜变量 + denoise=1
    realParams.latent = (params.image && i2iOn) ? ('["' + N.i2iEncode + '", 0]') : ('["' + N.latent + '", 0]');
    realParams.denoise = (params.image && i2iOn) ? (Number(i2i.denoise) || 0.62) : 1;
    // 宽高：剧集分辨率配置传入；没传给默认值（模板占位符 __WIDTH__/__HEIGHT__ 必须有值；兜底同 RES_SDXL 默认档 1920x1080）
    realParams.width = Number(params.width) > 0 ? Math.round(params.width) : 1920;
    realParams.height = Number(params.height) > 0 ? Math.round(params.height) : 1080;
  }
  if (params.image) realParams.image = await uploadToComfy(params.image);
  if (realParams.seed === undefined || realParams.seed === null) realParams.seed = Math.floor(Math.random() * 1e9);

  const filled = applyParams(tplText, realParams);
  const optionalPH = optionalPlaceholders();
  const left = findPlaceholders(filled).filter(x => !optionalPH.has(x));
  if (left.length) {
    const TIPS = phTips();
    const tips = left.map(x => {
      const k = x.replace(/^__|__$/g, '').toLowerCase();
      return x + (TIPS[k] ? ' → 缺少 ' + TIPS[k] : '');
    });
    throw new Error('工作流占位符未解析：' + tips.join('；') +
      '。请到 设置 → 模型管家 看：模型目录对不对、缺哪个模型。');
  }
  let wf;
  try {
    wf = JSON.parse(filled);
  } catch (e) {
    throw new Error('工作流 JSON 解析失败（' + path.basename(tplFile) + '）：' + (e && e.message));
  }

  // 生图的「图生图」支路：节点 id 由方案声明（nodes.i2iImage / i2iEncode），代码不认数字
  const imgN = (imgP && imgP.nodes) || {};
  const imgI2i = (imgP && imgP.i2i) || {};
  const i2iNodes = imgI2i.enabled !== false && imgN.i2iImage && imgN.i2iEncode
    ? { img: imgN.i2iImage, enc: imgN.i2iEncode } : null;

  // 文生图：把模板里的「图生图」支路摘掉（否则 LoadImage 里的 __IMAGE__ 未填，ComfyUI 会直接报错）
  if (!isVideo && !realParams.image && i2iNodes) {
    if (wf[i2iNodes.img] && wf[i2iNodes.img].class_type === 'LoadImage') delete wf[i2iNodes.img];
    if (wf[i2iNodes.enc] && wf[i2iNodes.enc].class_type === 'VAEEncode') delete wf[i2iNodes.enc];
  }
  // 图生图：参考图先缩放到本次选定的分辨率再编码 —— 否则「参考图多大就出多大」，
  // 逐张分辨率选择在 i2i 下形同虚设（crop=center 保持比例不拉伸）
  if (!isVideo && realParams.image && i2iNodes && wf[i2iNodes.img] && wf[i2iNodes.enc]) {
    const scaleId = String(imgI2i.scaleId || '30');
    wf[scaleId] = {
      class_type: 'ImageScale',
      inputs: {
        image: [i2iNodes.img, 0], upscale_method: imgI2i.scaleMethod || 'lanczos',
        width: realParams.width, height: realParams.height, crop: imgI2i.scaleCrop || 'center'
      }
    };
    wf[i2iNodes.enc].inputs.pixels = [scaleId, 0];
  }

  if (isVideo) {
    const Wg = (vidP && vidP.wiring) || {};
    const nModel = vidN.model, nLora = vidN.lora, nShift = vidN.shift;
    const condOut = Wg.condOutput !== undefined ? Wg.condOutput : 0;
    const latentOut = Wg.latentOutput !== undefined ? Wg.latentOutput : 1;

    // σ-shift 注入：蒸馏 LoRA 的训练 shift ≠ 模型默认（12/3）时才需要（如 768p 系训练 6/3）。
    // 🔴 调度器节点也必须接 shift 后的模型 —— sigma 网格由 model_sampling 生成，
    //    接错会让「采样网格」和「DiT 内部换算」用两套 shift，画面直接毁。
    const shift = realParams.h3_shift;
    if (realParams.h3_lora && Array.isArray(shift) && shift.length === 2 && nShift) {
      wf[nShift] = {
        class_type: vidC.shift || 'MiniMaxH3SigmaShift',
        inputs: { model: [nLora, 0], shift_video: shift[0], shift_audio: shift[1] }
      };
      for (const n of [vidN.guider, vidN.scheduler]) {
        if (wf[n] && Array.isArray(wf[n].inputs.model) && wf[n].inputs.model[0] === nLora) {
          wf[n].inputs.model = [nShift, 0];
        }
      }
    }

    // 没有（或该档位不需要）加速 LoRA → 摘掉 LoRA / σ-shift 节点，基础模型直跑。
    // 步数已由档位表兜底为基础步数（基础模型上跑 4/8 步画面会崩），不报错。
    if (!realParams.h3_lora) {
      delete wf[nLora];
      if (nShift) delete wf[nShift];
      for (const n of [vidN.guider, vidN.scheduler]) {
        const m = wf[n] && wf[n].inputs.model;
        if (Array.isArray(m) && (m[0] === nLora || m[0] === nShift)) {
          wf[n].inputs.model = [nModel, 0];
        }
      }
      if (realParams.tierRes && realParams.tierRes.downgraded) {
        logger.detail('档位所需的加速 LoRA 缺文件，本次按基础模型 ' + realParams.steps + ' 步采样');
      }
    }

    // 媒体一律上传到 ComfyUI 的 input 目录 —— LoadImage / LoadVideo 只认那里
    const media = { refImages: [], refVideos: [], refImageSize: realParams.refImageSize };
    media.first = wantFirst ? await uploadToComfy(wantFirst) : null;
    media.last = wantLast ? await uploadToComfy(wantLast) : null;
    for (const p of refImages) media.refImages.push(await uploadToComfy(p));
    for (const p of refVideos) media.refVideos.push(await uploadToComfy(p));

    const inj = injectMedia(wf, media, vidP);
    // 方案自己声明了接线目标（condTargets / latentTargets）时，injectMedia 已经把引导器 /
    // 采样器（以及裁剪节点）接好了，这里不再按老约定覆盖它们。
    if (!Wg.condTargets && !Wg.latentTargets) {
      if (wf[vidN.guider]) wf[vidN.guider].inputs.conditioning = [inj.condId, condOut];
      if (wf[vidN.samplerAdv]) wf[vidN.samplerAdv].inputs.latent_image = [inj.latentId, latentOut];
    }
    const bits = [];
    // 日志里带上本地文件名（而不是只给 ×N）：用户核对「这版视频到底用的哪张图」就靠这行
    if (media.first) bits.push('首帧：' + path.basename(String(wantFirst)));
    if (media.last) bits.push('尾帧：' + path.basename(String(wantLast)));
    if (media.refImages.length) bits.push('参考图×' + media.refImages.length + '：' + refImages.map(p => path.basename(p)).join('、'));
    if (media.refVideos.length) bits.push('参考视频×' + media.refVideos.length + '：' + refVideos.map(p => path.basename(p)).join('、'));
    logger.info((vidP.label || '视频') + ' 工作流：' +
      videoTiers.branchLabel(videoTiers.branchKey(inj.mode === 'ref', vidP), vidP) +
      '（' + (inj.mode === 'ref' ? '参考模式' : '首尾帧模式') + '），' + realParams.steps + ' 步，' +
      realParams.width + 'x' + realParams.height +
      (bits.length ? '，输入：' + bits.join(' + ') : '，纯文字'));
  }

  const clientId = 'comic-studio-' + Date.now();
  const tSubmit = Date.now();
  // 生成配置一览（方便排查「分辨率/秒数不对」这类问题）
  if (isVideo) {
    logger.info('本次视频生成配置：' + realParams.width + 'x' + realParams.height +
      '，' + (realParams.seconds || Math.round(realParams.length / 24)) + 's（' + realParams.length + ' 帧）' +
      '，' + realParams.steps + ' 步，' + (realParams.tierLabel || '平衡') + '档');
    // 模型一览：排查「出的片不对」第一步就是确认这套组合是不是预期的那套。
    // 用户平时不需要看，但日志里必须留痕（档位 → 实际权重 / LoRA / 步数 / σ shift 全链路可见）。
    const tr = realParams.tierRes || {};
    logger.info('本次使用模型：' + (realParams.h3_unet || '(未解析到权重文件)') +
      '｜LoRA：' + (realParams.h3_lora || '无（基础模型直跑）') +
      '｜模型族：' + videoTiers.branchLabel(tr.family, vidP) + '（' + tr.family + '）' +
      '｜采样网格：' + (realParams.sigmas
        ? '方案自带 ' + realParams.steps + ' 步蒸馏序列（ManualSigmas）'
        : (realParams.h3_shift
          ? realParams.h3_shift[0] + '/' + realParams.h3_shift[1] + '（已注入 σ-shift 节点）'
          : '模型默认 12/3（不注入节点）')) +
      (tr.downgraded ? '｜⚠ 该档位 LoRA 文件缺失，本次已降级为基础模型 20 步' : ''));
  } else {
    logger.info('本次图片生成配置：' + realParams.width + 'x' + realParams.height +
      (realParams.image ? '，图生图（denoise ' + realParams.denoise + '）' : '，文生图') +
      '，工作流 ' + models.activeImageTemplate());
  }
  logger.info('提交 ComfyUI 工作流：' + (templateKey === 'video' ? ((vidP && vidP.label) || '视频') : '角色图') + ' → ' + baseName);
  let submit;
  try {
    submit = await fetchJson(endpoint('comfyui') + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: clientId })
    }, 15000);
  } catch (e) {
    throw new Error('ComfyUI 服务不可达（' + endpoint('comfyui') + '）。请先手动打开一次 ComfyUI Desktop'
      + '（之后软件会自己接管，不需要在本软件里配 ComfyUI 路径）。');
  }
  if (!submit.ok || !submit.json || !submit.json.prompt_id) {
    throw new Error('ComfyUI 拒绝工作流：' + JSON.stringify(submit.json).slice(0, 400));
  }
  const pid = submit.json.prompt_id;
  logger.detail('prompt_id=' + pid + (realParams.seed !== undefined ? '，seed=' + realParams.seed : ''));

  // 轮询直到完成。
  // ⚠️ 三种"end"都要立刻跳出，不能只等 completed：任务报错时 completed 永远是 false，
  //    以前只判断 completed → 报错也傻等到超时（1800s），界面看着像卡死。
  //    这里：①完成 ②出错 ③任务从队列里消失（连续 3 次看不到）→ 立即结束。
  const t0 = Date.now();
  let lastTick = t0;
  let history = null;
  let vanished = 0;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 1200));
    if (Date.now() - lastTick >= 30000) {
      lastTick = Date.now();
      logger.detail('执行中…已等待 ' + Math.round((Date.now() - t0) / 1000) + 's（' + baseName + '）');
    }
    let h;
    try { h = await fetchJson(endpoint('comfyui') + '/history/' + pid, {}, 8000); } catch (_) { continue; }
    if (h.ok && h.json && h.json[pid]) {
      history = h.json[pid];
      const st = history.status || {};
      if (st.completed) break;
      if (st.status_str === 'error') break;      // ② 出错：立刻跳出，下面统一报错
    } else if (Date.now() - t0 > 15000) {
      // ③ 既不在 history、也不在队列里 → 任务被中断/ComfyUI 重启过
      let q = null;
      try { q = await fetchJson(endpoint('comfyui') + '/queue', {}, 8000); } catch (_) { q = null; }
      if (q && q.ok && q.json) {
        const inQueue = ['queue_running', 'queue_pending'].some(k =>
          Array.isArray(q.json[k]) && q.json[k].some(it => (Array.isArray(it) ? it[1] : it && it.prompt_id) === pid));
        vanished = inQueue ? 0 : vanished + 1;
        if (vanished >= 3) throw new Error('任务已从 ComfyUI 队列消失（prompt_id=' + pid + '）：ComfyUI 可能被重启或任务被中断，请重试。');
      }
    }
  }
  if (!history) throw new Error('ComfyUI 任务超时未完成（prompt_id=' + pid + '）');
  if (history.status && history.status.status_str === 'error') {
    const errMsg = (history.status.messages || []).filter(m => m[0] === 'execution_error')[0];
    const e0 = errMsg ? errMsg[1] : null;
    const brief = e0
      ? ('节点 ' + e0.node_type + '[' + e0.node_id + ']：' + String(e0.exception_message || '').trim())
      : JSON.stringify(history.status.messages || {}).slice(0, 400);
    const raw = e0 ? String(e0.exception_message || '') : '';
    const tip = /HostBuffer|read_file_slice/i.test(raw)
      ? '（ComfyUI 流式加载权重失败，通常重启一次 ComfyUI 就能恢复）'
      : /out of memory|OutOfMemory|CUDA error/i.test(raw)
        ? '（显存/显卡出错：关掉其他占用显存的程序，或调低分辨率、时长后重试）'
        : '';
    throw new Error('ComfyUI 执行出错：' + brief + tip);
  }

  // 拉取产物
  const saved = [];
  const outputs = history.outputs || {};
  for (const nodeId of Object.keys(outputs)) {
    for (const key of ['images', 'videos', 'gifs']) {
      for (const item of (outputs[nodeId][key] || [])) {
        const q = new URLSearchParams({
          filename: item.filename, subfolder: item.subfolder || '',
          type: item.type || 'output'
        });
        const r = await fetch(endpoint('comfyui') + '/view?' + q);
        if (!r.ok) throw new Error('产物下载失败：' + item.filename);
        const buf = Buffer.from(await r.arrayBuffer());
        const ext = path.extname(item.filename).slice(1) || 'png';
        saved.push(writeUnique(dir, baseName, ext, buf));
      }
    }
  }
  if (!saved.length) throw new Error('ComfyUI 完成但没有产出文件');
  logger.done(saved.join('、') + ' 生成完成', Date.now() - tSubmit);
  return { files: saved, seed: realParams.seed };
}

/** 取一个可用的底模文件名（ComfyUI 的 checkpoints 目录，只认文件名） */
function firstCkpt() {
  return models.pick('checkpoints');
}

/* ---------------- ffmpeg 导出 ---------------- */

function srtTime(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor(sec % 3600 / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  const ms = String(Math.round((sec % 1) * 1000)).padStart(3, '0');
  return `${h}:${m}:${s},${ms}`;
}

/**
 * 真实拼接导出：concat + 统一输出分辨率 + 可选字幕烧录。
 * videos: [{file, dialogue, dur}]（绝对路径）
 * opts.width/height：输出分辨率（剧集「输出分辨率」配置），默认 1920x1080。
 */
async function exportVideo(outDir, outName, videos, { subtitles = true, width = 1920, height = 1080, scope = '' } = {}) {
  // 导出是一次性长任务：这里同步确认一次 ffmpeg（避免「预热没跑完」被误判成没装）
  const ffmpeg = findFfmpeg({ forceSync: true });
  if (!ffmpeg) throw new Error('未找到 ffmpeg。请将 ffmpeg.exe 放到 workspace/tools/，或到 设置 → 高级设置 指定路径。');
  fs.mkdirSync(outDir, { recursive: true });
  if (!videos.length) throw new Error('没有可拼接的视频片段');
  const W = Math.max(16, Math.round(Number(width) || 1920));
  const H = Math.max(16, Math.round(Number(height) || 1080));
  const tExport = Date.now();
  logger.info('ffmpeg 组装成片：' + videos.length + ' 个镜头，输出 ' + W + 'x' + H + (subtitles ? ' + 字幕烧录' : ''));

  const tmp = path.join(outDir, '_tmp_' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    // 字幕
    let subArg = [];
    const vfBase = 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2';
    if (subtitles) {
      let t = 0; const lines = [];
      videos.forEach((v, i) => {
        const dur = Number(v.dur) || 5;
        if (v.dialogue) lines.push(i + 1 + '\n' + srtTime(t) + ' --> ' + srtTime(t + Math.max(dur - 0.2, 1)) + '\n' + v.dialogue + '\n');
        t += dur;
      });
      if (lines.length) {
        // srt 必须 UTF-8 with BOM 才能被 ffmpeg libass 正确读中文。
        // ⚠️ subtitles 滤镜参数不要带绝对路径：Windows 盘符冒号要过「滤镜图解析→选项解析」
        // 两层转义，少一层就把路径后半段当成 original_size 选项（报 Invalid argument）。
        // 解法：spawn 的 cwd 设为临时目录，滤镜里只写裸文件名 subs.srt，无冒号无空格。
        fs.writeFileSync(path.join(tmp, 'subs.srt'), '\ufeff' + lines.join('\n'), 'utf-8');
        subArg = ['-vf', vfBase + ',subtitles=subs.srt'];
      }
    }
    if (!subArg.length) {
      subArg = ['-vf', vfBase];
    }

    // concat 列表（先统一转码为相同规格，避免拼接黑屏）
    const listFile = path.join(tmp, 'list.txt');
    fs.writeFileSync(listFile, videos.map(v => 'file \'' + v.file.replace(/\\/g, '/').replace(/'/g, "'\\''") + '\'').join('\n'), 'utf-8');

    const outBase = sanitize(outName);
    const outFile = path.join(outDir, outBase + '.mp4');
    // 走 assetStore 永不覆盖
    const finalName = (() => {
      let name = outBase + '.mp4', i = 2;
      while (fs.existsSync(path.join(outDir, name))) { name = outBase + '_' + String(i).padStart(2, '0') + '.mp4'; i++; }
      return name;
    })();
    const finalPath = path.join(outDir, finalName);

    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      ...subArg, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', finalPath];

    const res = await new Promise((resolve) => {
      // cwd=tmp：让 subtitles=subs.srt（相对路径）解析到临时目录，避开盘符冒号转义问题
      const p = spawn(ffmpeg, args, { windowsHide: true, cwd: tmp });
      let err = '';
      p.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-4000); });
      p.on('close', code => resolve({ code, err }));
      p.on('error', e => resolve({ code: -1, err: String(e) }));
    });
    if (res.code !== 0 || !fs.existsSync(finalPath)) {
      throw new Error('ffmpeg 导出失败：' + res.err.slice(-500));
    }
    const elapsedMs = Date.now() - tExport;
    logger.done('成片已导出：' + finalName, elapsedMs);
    // 把本次导出耗时写进目录元信息（.meta.json），「组装成片」卡片上要显示它；
    // listVideosWithMeta 会读同一份缓存，所以只补字段、不动其它键。
    try {
      const cachePath = path.join(outDir, '.meta.json');
      let cache = {};
      try { if (fs.existsSync(cachePath)) cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) || {}; } catch (_) { cache = {}; }
      const st = fs.statSync(finalPath);
      cache[finalName] = { ...(cache[finalName] || {}), mtimeMs: st.mtimeMs, elapsedMs };
      // 🔴 需求（Dragon 2026-09-22）：重复点击「组装成片」→ 旧成片被**替换**掉，不留历史版本。
      // 删除本次导出之外的其它成片 mp4，连同各自封面（.xxx.mp4.poster.jpg）与 meta 记录一并清理。
      // （成片是可随时重新组装的派生产物，不是原始素材；组装失败不会走到这里，旧成片仍保留。）
      // 🔴 2026-09-24 扁平化后「成片/」是全项目共用的目录：**只能删本集（scope 前缀）的旧成片**，
      //    否则导出第 2 集会顺手删掉第 1 集的成片。scope 为空（老调用/测试）时才按「删目录内全部」的旧行为。
      const scopePre = scope ? String(scope) + '_' : '';
      for (const f of fs.readdirSync(outDir)) {
        if (f === finalName) continue;
        if (scopePre && !f.startsWith(scopePre)) continue;
        if (/\.mp4$/i.test(f) || /\.webm$/i.test(f) || /\.mov$/i.test(f)) {
          try { fs.rmSync(path.join(outDir, f), { force: true }); } catch (_) {}
          try { fs.rmSync(path.join(outDir, '.' + f + '.poster.jpg'), { force: true }); } catch (_) {}
          delete cache[f];
        }
      }
      try { fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8'); } catch (_) { /* 元信息写失败不影响导出结果 */ }
    } catch (_) { /* 元信息写失败不影响导出结果 */ }
    return finalPath;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 列出一个目录下全部视频文件并附带元信息（生成时间 mtimeMs / 大小 / 分辨率）。
 * 用于「组装成片」模块：重启后也能完整显示本集生成过的所有视频。
 * 分辨率探测结果缓存在目录内 .meta.json（按 mtimeMs 失效），只对新增/变动的文件真正起探测进程。
 * 全程异步（execFile），绝不阻塞主进程。
 */
async function listVideosWithMeta(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => /\.(mp4|webm|mov)$/i.test(f))
    .map(f => {
      const p = path.join(dir, f);
      let st = null;
      try { st = fs.statSync(p); } catch (_) {}
      return st ? { file: f, path: p, mtimeMs: st.mtimeMs, size: st.size } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);   // 最新生成的排前面
  if (!files.length) return [];

  // 分辨率缓存：mtimeMs 没变就直接用
  const cachePath = path.join(dir, '.meta.json');
  let cache = {};
  try { if (fs.existsSync(cachePath)) cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) || {}; } catch (_) { cache = {}; }

  const todo = files.filter(f => !(cache[f.file] && cache[f.file].mtimeMs === f.mtimeMs && cache[f.file].width));
  if (todo.length) {
    await Promise.all(todo.map(async f => {
      const meta = await probeVideo(f.path);
      // 合并而不是覆盖：elapsedMs（导出耗时）等字段要保留下来
      cache[f.file] = { ...(cache[f.file] || {}), mtimeMs: f.mtimeMs, width: meta.width, height: meta.height, durationSec: meta.durationSec };
    }));
    try { fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8'); } catch (_) {}
  }
  for (const f of files) {
    const c = cache[f.file] || {};
    f.width = c.width || 0; f.height = c.height || 0; f.durationSec = c.durationSec || 0;
    f.elapsedMs = c.elapsedMs || 0;
  }

  // 封面图：与 .meta.json 同一套 mtimeMs 缓存逻辑；mtime 变了才重新抽帧。
  // 封面文件用隐藏式命名（.xxx.poster.jpg），不会被本函数的视频过滤误收。
  const ffmpeg = findFfmpeg();
  if (ffmpeg) {
    await Promise.all(files.map(async f => {
      const poster = path.join(dir, '.' + f.file + '.poster.jpg');
      if (cache[f.file] && cache[f.file].mtimeMs === f.mtimeMs && fs.existsSync(poster)) { f.poster = poster; return; }
      const ok = await extractPoster(ffmpeg, f.path, poster);
      if (ok) f.poster = poster;
    }));
  }
  return files;
}

/** ffmpeg 抽一帧做封面（先试 1s 处，超短视频回退到 0s）；成功返回 true */
async function extractPoster(ffmpeg, video, poster) {
  const run = (args) => new Promise((resolve) => {
    execFile(ffmpeg, args, { windowsHide: true, timeout: 30000 }, (err) => resolve(!err && fs.existsSync(poster)));
  });
  try {
    if (await run(['-y', '-ss', '1', '-i', video, '-frames:v', '1', '-q:v', '3', poster])) return true;
    return await run(['-y', '-i', video, '-frames:v', '1', '-q:v', '3', poster]);
  } catch (_) { return false; }
}

/** 用 ffprobe（优先）或 ffmpeg -i 解析视频分辨率与时长；失败返回 0 */
async function probeVideo(abs) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { width: 0, height: 0, durationSec: 0 };
  const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const run = (bin, args) => new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
  try {
    if (fs.existsSync(ffprobe)) {
      const r = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-show_entries', 'format=duration',
        '-of', 'json', abs]);
      if (!r.err && r.stdout) {
        const j = JSON.parse(r.stdout);
        const s = j.streams && j.streams[0];
        const dur = j.format && parseFloat(j.format.duration);
        if (s && s.width) return { width: s.width, height: s.height, durationSec: Number.isFinite(dur) ? dur : 0 };
      }
    }
    // 回退：ffmpeg -i 的 stderr 里找 "1920x1080"
    const r = await run(ffmpeg, ['-i', abs]);
    const m = r.stderr.match(/,\s(\d{2,5})x(\d{2,5})[\s,]/);
    if (m) return { width: +m[1], height: +m[2], durationSec: 0 };
  } catch (_) { /* 探测失败不致命，显示 0 */ }
  return { width: 0, height: 0, durationSec: 0 };
}

module.exports = {
  init, health, llmChat, extractJson, pickArray, endpoint, setEndpoint,
  comfyGenerate, workflowPath, ensureDefaultTemplates, findFfmpeg, exportVideo,
  applyParams, findPlaceholders, h3Params, forgetWorkspace, listVideosWithMeta,
  // 模型方案驱动的部分（换模型只改配置，下面是代码侧入口）
  injectMedia, phTips, optionalPlaceholders,
  // 导出仅为离线自测（test/h3-inject-check.cjs 直接验证连线，不需要显卡/ComfyUI）
  injectH3Media
};
