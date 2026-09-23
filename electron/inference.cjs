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
  // 先快速探活（1.5s），避免连接挂起时用户干等
  let alive = false;
  try { alive = (await fetchJson(endpoint('llm') + '/v1/models', {}, 1500)).ok; } catch (_) {}
  if (!alive) throw new Error('LLM 服务不可达（' + endpoint('llm') + '）。请先启动 llama-server，或到 设置→环境检测 修改地址。');

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

  let content = '', reasoning = '';
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
        const d = j.choices && j.choices[0] && j.choices[0].delta;
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
  logger.done('LLM 返回 ' + content.length + ' 字', Date.now() - t0);
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

const WORKFLOW_TEMPLATES = {
  video: 'workflows/video_h3.json'         // H3 视频（M0 spike 后落地）
};

function workflowPath(key) {
  // 角色图走「生图工作流模板注册表」：按 设置→生图工作流 激活的模板解析文件
  if (key === 'character') {
    const info = models.imageTemplateInfo();
    return path.join(ws() || '', info.file);
  }
  const p = path.join(ws() || '', WORKFLOW_TEMPLATES[key] || ('workflows/' + key + '.json'));
  return p;
}

/**
 * 内置默认「角色图」工作流（返回 JSON 文本）。
 * 节点 1/2 是「图生图」支路（LoadImage → VAEEncode），只在用户选了已生成的图重绘时启用：
 *   __LATENT__ / __DENOISE__ 由 comfyGenerate 按有无参考图写成 ["2",0]+0.62 或 ["5",0]+1。
 * 注意：这两个占位符必须「裸露」写进 JSON（不带引号），否则 applyParams 会把它当字符串值
 * 塞进去（变成 "[\"2\", 0]" 这种字符串），ComfyUI 会因为类型不对直接报错。
 */
function defaultCharacterTemplate() {
  const tpl = {
    "1": { "class_type": "LoadImage", "inputs": { "image": "__IMAGE__" } },
    "2": { "class_type": "VAEEncode", "inputs": { "pixels": ["1", 0], "vae": ["4", 2] } },
    "3": { "class_type": "KSampler", "inputs": { "seed": "__SEED__", "steps": 28, "cfg": 6, "sampler_name": "euler_ancestral", "scheduler": "normal", "denoise": "@@DENOISE@@", "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": "@@LATENT@@" } },
    "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "__CKPT__" } },
    "5": { "class_type": "EmptyLatentImage", "inputs": { "width": "__WIDTH__", "height": "__HEIGHT__", "batch_size": 1 } },
    "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "__PROMPT__", "clip": ["4", 1] } },
    "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "__NEGATIVE__", "clip": ["4", 1] } },
    "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
    "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "comic/char", "images": ["8", 0] } }
  };
  return JSON.stringify(tpl, null, 2)
    .replace(/"@@DENOISE@@"/g, '__DENOISE__')
    .replace(/"@@LATENT@@"/g, '__LATENT__');
}

/** 老版内置角色模板的节点集合（用来识别「还是我们生成的那份」→ 可安全升级） */
const LEGACY_CHAR_IDS = ['3', '4', '5', '6', '7', '8', '9'];

/**
 * 首次运行落默认工作流模板（角色图 + H3 视频）。
 * 已存在且是用户自己改过的模板一律不动；只升级「还是老内置版本」的那几种情况。
 */
function ensureDefaultTemplates() {
  const w = ws();
  if (!w) return;
  const dir = path.join(w, 'workflows');
  fs.mkdirSync(dir, { recursive: true });

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

  // —— Z-Image Turbo：官方三件套结构（UNETLoader + CLIPLoader lumina2 + VAELoader）。
  // 判定「还是我们内置的那份」：含 UNETLoader 就是 Z-Image 版（用户可自行改参数，不动）；
  // 缺失 / 是老 SDXL 结构 → 播种内置版（SDXL 版本仍保留在 character.json，可随时切回）。
  const bzi = path.join(__dirname, 'workflows', 'character_zimage_turbo.json');
  const tzi = path.join(dir, 'character_zimage_turbo.json');
  let needZi = !fs.existsSync(tzi);
  if (!needZi) {
    try {
      const cur = fs.readFileSync(tzi, 'utf-8');
      if (!cur.includes('"UNETLoader"')) needZi = true;
    } catch (_) { needZi = true; }
  }
  if (needZi && fs.existsSync(bzi)) {
    try {
      fs.copyFileSync(bzi, tzi);
      logger.info('Z-Image Turbo 工作流模板已就位（workflows/character_zimage_turbo.json）');
    } catch (_) { /* 忽略 */ }
  }

  // —— 角色图：老内置模板没有「图生图」支路，节点集合完全一致时升级 ——
  // ⚠️ 模板里含**裸占位符**（"denoise": __DENOISE__），整体不是合法 JSON，
  //    所以这里一律用文本匹配判断/改写，不能 JSON.parse（以前用 parse → 永远抛错 → 升级静默失效）。
  const charFile = path.join(dir, 'character.json');
  let upgradeChar = false;
  let charText = '';
  if (fs.existsSync(charFile)) {
    try { charText = fs.readFileSync(charFile, 'utf-8'); } catch (_) { charText = ''; }
    const hasLoad = /"class_type"\s*:\s*"LoadImage"/.test(charText);
    const hasEnc = /"class_type"\s*:\s*"VAEEncode"/.test(charText);
    const hasLat = /__LATENT__/.test(charText);
    upgradeChar = !(hasLoad && hasEnc && hasLat);   // 老版本没有「图生图」支路 → 整体升级
  }
  if (!charText || upgradeChar) {
    try {
      fs.writeFileSync(charFile, defaultCharacterTemplate(), 'utf-8');
      if (upgradeChar) logger.info('角色图工作流已升级：新增「图生图」（按已选图重绘）支持');
    } catch (_) { /* 忽略 */ }
  } else {
    // 2026-09-20：node5 宽高写死数字 → 改成 __WIDTH__/__HEIGHT__ 占位符（让每张图的分辨率真正生效）
    const fixed = upgradeCharTemplateText(charText);
    if (fixed !== charText) {
      try {
        fs.writeFileSync(charFile, fixed, 'utf-8');
        logger.info('角色图工作流已升级：宽高改为占位符（支持逐张/逐集分辨率配置）');
      } catch (_) { /* 忽略 */ }
    }
  }
}

/**
 * 角色模板升级：把 EmptyLatentImage 里写死的 width/height 改成占位符。
 * ⚠️ 纯文本改写 —— 模板含裸占位符（"denoise": __DENOISE__），整体不是合法 JSON，
 *    JSON.parse 会抛错（老实现就是这么静默失效的）。
 */
function upgradeCharTemplateText(text) {
  if (!text || /"width"\s*:\s*"__WIDTH__"/.test(text)) return text;
  const blk = text.match(/"class_type"\s*:\s*"EmptyLatentImage"[\s\S]{0,200}?\}/);
  if (!blk || !/"width"\s*:\s*\d+/.test(blk[0])) return text;
  const patched = blk[0]
    .replace(/"width"\s*:\s*\d+/, '"width": "__WIDTH__"')
    .replace(/"height"\s*:\s*\d+/, '"height": "__HEIGHT__"');
  return text.replace(blk[0], patched);
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
 * H3 视频参数（设置键 h3.width / h3.height / h3.seconds / h3.steps / h3.quality）。
 * 16GB 显存甜点：864x480、5 秒。
 * length 自动对齐到模型的 17k+5 帧网格（24fps）。
 *
 * 档位：
 *   fast（默认）＝ 4 步 Turbo LoRA + 参考图按生成面积缩放（ref_image_size=match）
 *   hq        ＝ 8 步 Turbo LoRA + 参考图 2048 短边（max，身份保真最好但慢数倍）
 */
function h3Params() {
  const num = (k, d) => { const v = Number(db.getSetting(k)); return Number.isFinite(v) && v > 0 ? v : d; };
  const snap = v => Math.max(32, Math.round(v / 32) * 32);
  const width = snap(num('h3.width', 864));
  const height = snap(num('h3.height', 480));
  let length = Math.max(5, Math.round(num('h3.seconds', 5) * 24));
  // 对齐 17k+5 帧网格：恒向上取（+17 防负数取模向下减，见 2026-09-23 修复）
  length = length + ((5 - (length % 17)) + 17) % 17;
  const quality = String(db.getSetting('h3.quality') || 'fast') === 'hq' ? 'hq' : 'fast';
  const steps = Math.max(1, Math.round(num('h3.steps', quality === 'hq' ? 8 : 4)));
  const refImageSize = String(db.getSetting('h3.refImageSize') || '') ||
    (quality === 'hq' ? 'max' : 'match');
  return { width, height, length, steps, quality, refImageSize };
}

/* ---------------- H3 媒体支路（首帧/尾帧/参考图/参考视频） ---------------- */

/**
 * 运行时注入到工作流里的节点 id 段（模板里不存在这些节点）：
 *   200/201 首帧 LoadImage + ImageScale   202/203 尾帧
 *   220+i   参考图 LoadImage
 *   230+i   参考视频 LoadVideo   240+i GetVideoComponents（VIDEO → IMAGE 帧）
 *   90+i    首/尾帧锚点 MiniMaxH3AddGuide
 */
const H3_NODE = {
  firstImg: '200', firstScale: '201',
  lastImg: '202', lastScale: '203',
  refImg: i => String(220 + i),
  refVid: i => String(230 + i),
  refVidComp: i => String(240 + i),
  guide: i => String(90 + i)
};

/**
 * 把「首帧/尾帧/参考图/参考视频」注入已经占位符替换好的 H3 工作流。
 *
 * 路由规则：
 *   有参考图或参考视频 → 换成 MiniMaxH3ReferenceToVideo（ref2va），首尾帧改用
 *                        MiniMaxH3AddGuide 锚在开头/结尾（与参考写的是不同的 conditioning 键，可共存）
 *   没有参考            → 沿用 MiniMaxH3ImageToVideo（fl2va），首帧/尾帧是它自身的可选输入
 *
 * media 里的值一律是「ComfyUI input 目录里的文件名」（LoadImage/LoadVideo 只认那里）。
 * 返回 { condId, latentId, mode }，调用方据此改写 BasicGuider / SamplerCustomAdvanced 的连线。
 */
function injectH3Media(wf, media) {
  const hasRef = (media.refImages || []).length > 0 || (media.refVideos || []).length > 0;
  const W = wf['16'].inputs.width;
  const H = wf['16'].inputs.height;

  // 首帧/尾帧都要先缩放到画布尺寸（首帧拉伸铺满，尾帧居中裁剪，和官方模板一致）
  const addFrame = (id, scaleId, name, crop) => {
    wf[id] = { class_type: 'LoadImage', inputs: { image: name } };
    wf[scaleId] = {
      class_type: 'ImageScale',
      inputs: { image: [id, 0], upscale_method: 'lanczos', width: W, height: H, crop }
    };
    return scaleId;
  };

  if (!hasRef) {
    // fl2va：不接首帧就是纯文字，不接尾帧就是单帧引导
    if (media.first) wf['16'].inputs.first_frame = [addFrame(H3_NODE.firstImg, H3_NODE.firstScale, media.first, 'disabled'), 0];
    if (media.last) wf['16'].inputs.last_frame = [addFrame(H3_NODE.lastImg, H3_NODE.lastScale, media.last, 'center'), 0];
    return { condId: '16', latentId: '16', mode: 'flf' };
  }

  // ref2va：参考图/参考视频走 autogrow 动态输入名（实测确认为「父键.子键」，下标从 0 起）
  const ins = {
    clip: wf['16'].inputs.clip,
    vae: wf['16'].inputs.vae,
    audio_vae: ['13', 0],
    prompt: wf['16'].inputs.prompt,
    width: W,
    height: H,
    length: wf['16'].inputs.length,
    ref_image_size: media.refImageSize || 'match'
  };
  (media.refImages || []).forEach((name, i) => {
    const id = H3_NODE.refImg(i);
    wf[id] = { class_type: 'LoadImage', inputs: { image: name } };
    ins['ref_images.ref_image_' + i] = [id, 0];
  });
  (media.refVideos || []).forEach((name, i) => {
    const id = H3_NODE.refVid(i), cid = H3_NODE.refVidComp(i);
    wf[id] = { class_type: 'LoadVideo', inputs: { file: name } };
    wf[cid] = { class_type: 'GetVideoComponents', inputs: { video: [id, 0] } };
    ins['ref_videos.ref_video_' + i] = [cid, 0];   // RefVideo 要的是帧序列（IMAGE）
  });
  wf['16'] = { class_type: 'MiniMaxH3ReferenceToVideo', inputs: ins };

  let condId = '16';
  let gi = 0;
  const anchor = (frameIdx, scaleId) => {
    const id = H3_NODE.guide(gi++);
    wf[id] = {
      class_type: 'MiniMaxH3AddGuide',
      inputs: {
        positive: [condId, 0],
        latent: ['16', 1],
        frame_idx: frameIdx,
        vae: ['12', 0],
        image: [scaleId, 0]
      }
    };
    condId = id;
  };
  if (media.first) anchor(0, addFrame(H3_NODE.firstImg, H3_NODE.firstScale, media.first, 'disabled'));
  if (media.last) anchor(-1, addFrame(H3_NODE.lastImg, H3_NODE.lastScale, media.last, 'center'));

  return { condId, latentId: '16', mode: 'ref' };
}

/** 占位符 → 模型目录（用于报错时提示用户去哪补） */
const PH_TIP = {
  ckpt: 'checkpoints（角色图 SDXL 底模）',
  z_unet: 'diffusion_models（Z-Image Turbo 主模型，如 z_image_turbo_bf16.safetensors）',
  z_clip: 'text_encoders（Z-Image 文本编码器 qwen_3_4b.safetensors）',
  z_vae: 'vae（Z-Image VAE ae.safetensors）',
  image: '本地参考图（图生图时由软件自动注入，模板里无需手填）',
  h3_model: 'diffusion_models（H3 主模型）',
  h3_unet: 'diffusion_models（H3 主模型 fl2va / ref2va）',
  h3_fl2va: 'diffusion_models（H3 fl2va）',
  h3_ref2va: 'diffusion_models（H3 ref2va，参考图/参考视频模式必需）',
  h3_text_encoder: 'text_encoders（H3 文本编码器）',
  h3_video_vae: 'vae（H3 video vae）',
  h3_audio_vae: 'vae（H3 audio vae）',
  h3_lora: 'loras（H3 Turbo LoRA，fl2va 需 fl2v 版、ref2va 需 ref2v 版）',
  h3_turbo_lora: 'loras（H3 Turbo LoRA）'
};

/** 可以缺省、缺了就自动摘掉对应节点的占位符（不报错） */
const OPTIONAL_PH = new Set(['__H3_LORA__', '__IMAGE__']);

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
async function comfyGenerate({ templateKey, dir, baseName, params = {}, timeoutMs = 1800000 }) {
  const tplFile = workflowPath(templateKey);
  if (!fs.existsSync(tplFile)) {
    throw new Error('工作流模板缺失：' + tplFile + '。请先在 workspace/workflows/ 放置对应工作流 JSON（设置→环境检测 有说明）。');
  }
  const tplText = fs.readFileSync(tplFile, 'utf-8');

  const isVideo = templateKey === 'video';
  const refImages = Array.isArray(params.refImages) ? params.refImages.filter(Boolean) : [];
  const refVideos = Array.isArray(params.refVideos) ? params.refVideos.filter(Boolean) : [];
  const wantFirst = params.firstFrame || params.image || null;
  const wantLast = params.lastFrame || null;
  const refMode = refImages.length > 0 || refVideos.length > 0;

  // 模型文件名：用户显式传入优先，其次从 ComfyUI 模型目录自动解析
  // 视频模板额外注入 H3 分辨率/帧数/步数（设置可改，params 可覆盖）
  let realParams;
  if (isVideo) {
    const wm = models.workflowModels();
    const p = { ...wm, ...h3Params() };
    // 秒数按「分镜脚本该镜头的 dur」走（渲染端传 seconds，4~15s 含边界）；
    // 没传才回退设置键 h3.seconds。都自动对齐到 17k+5 帧网格（24fps）。
    const sec = Number(params.seconds);
    if (Number.isFinite(sec) && sec > 0) {
      let L = Math.max(4, Math.min(15, Math.round(sec))) * 24;
      // 恒向上对齐 17k+5 网格（+17 防负数取模向下减：4s 曾被砍成 3.75s，台词被截）
      p.length = L + ((5 - (L % 17)) + 17) % 17;
      p.seconds = Math.max(4, Math.min(15, Math.round(sec)));
    }
    // 权重与加速 LoRA 必须成对：ref2va 只能配 ref2v 的 LoRA，fl2va 只能配 fl2v 的
    p.h3_unet = refMode ? (wm.h3_ref2va || wm.h3_fl2va || wm.h3_model) : (wm.h3_fl2va || wm.h3_model);
    p.h3_lora = refMode
      ? wm.h3_ref2v_lora
      : (p.quality === 'hq' ? wm.h3_fl2v_lora_hq : wm.h3_fl2v_lora_fast);
    // conditioning / latent 的连接目标；注入媒体支路后会由 injectH3Media 改写
    p.cond_id = '16';
    p.latent_id = '16';
    realParams = { ...p, ...params };
  } else {
    realParams = { ...models.workflowModels(), ...params };
    // 角色图「图生图」：选了已生成的图 → 走 VAEEncode 潜变量 + 0.62 denoise；否则空潜变量 + denoise=1
    realParams.latent = params.image ? '["2", 0]' : '["5", 0]';
    realParams.denoise = params.image ? 0.62 : 1;
    // 宽高：剧集分辨率配置传入；没传给默认值（模板占位符 __WIDTH__/__HEIGHT__ 必须有值）
    realParams.width = Number(params.width) > 0 ? Math.round(params.width) : 1216;
    realParams.height = Number(params.height) > 0 ? Math.round(params.height) : 832;
  }
  if (params.image) realParams.image = await uploadToComfy(params.image);
  if (realParams.seed === undefined || realParams.seed === null) realParams.seed = Math.floor(Math.random() * 1e9);

  const filled = applyParams(tplText, realParams);
  const left = findPlaceholders(filled).filter(p => !OPTIONAL_PH.has(p));
  if (left.length) {
    const tips = left.map(p => {
      const k = p.replace(/^__|__$/g, '').toLowerCase();
      return p + (PH_TIP[k] ? ' → 缺少 ' + PH_TIP[k] : '');
    });
    throw new Error('工作流占位符未解析：' + tips.join('；') +
      '。请到 设置 → 模型目录 检查 ComfyUI 模型根目录是否正确、模型是否已下载。');
  }
  let wf;
  try {
    wf = JSON.parse(filled);
  } catch (e) {
    throw new Error('工作流 JSON 解析失败（' + path.basename(tplFile) + '）：' + (e && e.message));
  }

  // 文生图：把模板里的「图生图」支路摘掉（否则 LoadImage 里的 __IMAGE__ 未填，ComfyUI 会直接报错）
  if (!isVideo && !realParams.image) {
    if (wf['1'] && wf['1'].class_type === 'LoadImage') delete wf['1'];
    if (wf['2'] && wf['2'].class_type === 'VAEEncode') delete wf['2'];
  }
  // 图生图：参考图先缩放到本次选定的分辨率再编码 —— 否则「参考图多大就出多大」，
  // 逐张分辨率选择在 i2i 下形同虚设（crop=center 保持比例不拉伸）
  if (!isVideo && realParams.image && wf['1'] && wf['2']) {
    wf['30'] = {
      class_type: 'ImageScale',
      inputs: {
        image: ['1', 0], upscale_method: 'lanczos',
        width: realParams.width, height: realParams.height, crop: 'center'
      }
    };
    wf['2'].inputs.pixels = ['30', 0];
  }

  if (isVideo) {
    // 没有 Turbo LoRA 就摘掉该节点，模型直接从 UNETLoader 取（质量略降但不报错）
    if (!realParams.h3_lora) {
      delete wf['14'];
      for (const n of ['18', '20']) {
        if (wf[n] && Array.isArray(wf[n].inputs.model) && wf[n].inputs.model[0] === '14') {
          wf[n].inputs.model = ['10', 0];
        }
      }
      logger.detail('未找到 Turbo LoRA，本次按原步数采样');
    }

    // 媒体一律上传到 ComfyUI 的 input 目录 —— LoadImage / LoadVideo 只认那里
    const media = { refImages: [], refVideos: [], refImageSize: realParams.refImageSize };
    media.first = wantFirst ? await uploadToComfy(wantFirst) : null;
    media.last = wantLast ? await uploadToComfy(wantLast) : null;
    for (const p of refImages) media.refImages.push(await uploadToComfy(p));
    for (const p of refVideos) media.refVideos.push(await uploadToComfy(p));

    const inj = injectH3Media(wf, media);
    wf['18'].inputs.conditioning = [inj.condId, 0];
    wf['21'].inputs.latent_image = [inj.latentId, 1];
    const bits = [];
    // 日志里带上本地文件名（而不是只给 ×N）：用户核对「这版视频到底用的哪张图」就靠这行
    if (media.first) bits.push('首帧：' + path.basename(String(wantFirst)));
    if (media.last) bits.push('尾帧：' + path.basename(String(wantLast)));
    if (media.refImages.length) bits.push('参考图×' + media.refImages.length + '：' + refImages.map(p => path.basename(p)).join('、'));
    if (media.refVideos.length) bits.push('参考视频×' + media.refVideos.length + '：' + refVideos.map(p => path.basename(p)).join('、'));
    logger.info('H3 工作流：' + (inj.mode === 'ref' ? '参考模式 ref2va' : '首尾帧模式 fl2va') +
      '，' + realParams.steps + ' 步，' + realParams.width + 'x' + realParams.height +
      (bits.length ? '，输入：' + bits.join(' + ') : '，纯文字'));
  }

  const clientId = 'comic-studio-' + Date.now();
  const tSubmit = Date.now();
  // 生成配置一览（方便排查「分辨率/秒数不对」这类问题）
  if (isVideo) {
    logger.info('本次视频生成配置：' + realParams.width + 'x' + realParams.height +
      '，' + (realParams.seconds || Math.round(realParams.length / 24)) + 's（' + realParams.length + ' 帧）' +
      '，' + realParams.steps + ' 步，档位 ' + (realParams.quality || 'fast'));
  } else {
    logger.info('本次图片生成配置：' + realParams.width + 'x' + realParams.height +
      (realParams.image ? '，图生图（denoise ' + realParams.denoise + '）' : '，文生图') +
      '，工作流 ' + models.activeImageTemplate());
  }
  logger.info('提交 ComfyUI 工作流：' + (templateKey === 'video' ? 'H3 视频' : '角色图') + ' → ' + baseName);
  let submit;
  try {
    submit = await fetchJson(endpoint('comfyui') + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: clientId })
    }, 15000);
  } catch (e) {
    throw new Error('ComfyUI 服务不可达（' + endpoint('comfyui') + '）。请先启动 ComfyUI，或到 设置→环境检测 修改地址。');
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
async function exportVideo(outDir, outName, videos, { subtitles = true, width = 1920, height = 1080 } = {}) {
  // 导出是一次性长任务：这里同步确认一次 ffmpeg（避免「预热没跑完」被误判成没装）
  const ffmpeg = findFfmpeg({ forceSync: true });
  if (!ffmpeg) throw new Error('未找到 ffmpeg。请将 ffmpeg.exe 放到 workspace/tools/，或到 设置→环境检测 指定路径。');
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
      for (const f of fs.readdirSync(outDir)) {
        if (f === finalName) continue;
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
  // 导出仅为离线自测（test/h3-inject-check.cjs 直接验证连线，不需要显卡/ComfyUI）
  injectH3Media, defaultCharacterTemplate, upgradeCharTemplateText
};
