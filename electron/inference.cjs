'use strict';
/**
 * 真实推理网关：LLM(llama.cpp server) / ComfyUI / ffmpeg
 * - LLM：OpenAI 兼容 API（llama-server），端点可在设置中配置
 * - ComfyUI：/prompt 提交工作流 JSON + 轮询 /history + /view 拉取产物
 * - ffmpeg：软件自带的 tools/ffmpeg/bin/ffmpeg.exe（见 tools.cjs），PATH 仅作最后兜底
 * 全部为真实调用；服务不可达时抛出带指引的错误。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');
const { writeUnique, sanitize } = require('./assetStore.cjs');
const tools = require('./tools.cjs');
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

/* 烧录字幕的字号（libass 的 FontSize，按视频高度等比缩放 → 一个值横竖版通用）。
   不指定时用 libass 默认值：1080×1920 竖版上单行字高 79px（占高 4.1%），16 字台词
   还要折成两行、整块高达 184px —— 观感过大。2026-10-15 用真实镜头做过 6 档对比实验，
   定为 7（单行字高约 34px / 占高 1.8%，且常见台词不再折行）。 */
const SUBTITLE_FONT_SIZE = 7;

function init(dbRef) {
  db = dbRef;
  profiles.init(dbRef);   // 模型方案就位后，工作流路径 / 节点锚点 / 帧参数才有得读
  // 内置 ffmpeg 命中时这一步直接空转；只有内置缺失才真去查 PATH（那一步慢，必须异步）
  warmFfmpeg();
}

function ws() {
  if (!workspace) workspace = db.getSetting('workspace');
  return workspace;
}

/** 换工作区时必须清掉缓存，否则工作流模板会继续认旧工作区 */
function forgetWorkspace() {
  workspace = null;
  ffmpegCache = undefined;   // 内置 ffmpeg 与工作区无关，这里只清 PATH 兜底的缓存
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

/** 单条消息的「文字长度」：content 可能是字符串，也可能是 OpenAI 多模态数组（只数 text 段） */
function contentLen(c) {
  if (Array.isArray(c)) return c.reduce((n, p) => n + (p && p.type === 'text' ? String(p.text || '').length : 0), 0);
  return String(c || '').length;
}

/** 图片扩展名 → MIME（llama-server 的 image_url 只认 data URL / http URL，不认本地路径） */
const IMG_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
};
/** 一次请求最多带几张图（H3 的参考图上限 4 张；再多对 9B 模型也只是浪费上下文） */
const MAX_LLM_IMAGES = 4;
/** 单张图上限 8MB（base64 后约 +33%；4K PNG 通常 3–6MB，够用） */
const MAX_LLM_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 把「本地图片绝对路径」读成 data URL，挂到最后一条 user 消息上（OpenAI 多模态格式）。
 *
 * 为什么在这里做、而不是在 UI 侧读好再传：base64 体积是原图的 1.33 倍，走 IPC 传进主进程
 * 等于白搬一趟；而主进程本来就要把整个 body 序列化给 llama-server。传路径 → 这里读 → 直接进 body。
 * 读不到 / 超大 / 非图片一律**跳过**（不能因为一张坏图把整次请求废掉）。
 * 注意：只有 llama-server 带了 `--mmproj`（见 launcher.cjs 的 mmprojOf）才认得多模态 content，
 * 否则会直接报错 —— 所以 UI 侧只在引擎报告 vision=true 时才允许勾选。
 */
function attachImages(messages, images) {
  const list = (Array.isArray(images) ? images : [])
    .filter(p => typeof p === 'string' && p && (() => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } })());
  if (!list.length) return { messages, used: [] };
  const parts = [], used = [];
  for (const p of list.slice(0, MAX_LLM_IMAGES)) {
    let buf = null;
    try { buf = fs.readFileSync(p); } catch (_) { continue; }
    if (!buf.length || buf.length > MAX_LLM_IMAGE_BYTES) continue;
    const mime = IMG_MIME[path.extname(p).toLowerCase()] || 'image/png';
    parts.push({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } });
    used.push(path.basename(p));
  }
  if (!parts.length) return { messages, used: [] };
  const out = messages.map(m => ({ ...m }));
  let idx = -1;
  for (let i = out.length - 1; i >= 0; i--) { if (out[i].role === 'user') { idx = i; break; } }
  if (idx < 0) return { messages, used: [] };
  const text = Array.isArray(out[idx].content)
    ? out[idx].content.filter(p => p && p.type === 'text').map(p => String(p.text || '')).join('\n')
    : String(out[idx].content || '');
  out[idx].content = [{ type: 'text', text }].concat(parts);
  return { messages: out, used };
}

/**
 * LLM 对话（OpenAI 兼容，llama-server）。
 *
 * 两个必须的适配（2026-09 实测于 llama.cpp b11012 + Qwen3.5）：
 * 1) 走流式（stream:true）。非流式时 llama-server 要等整段生成完才发响应头，
 *    Node 内置 fetch(undici) 的 headersTimeout 是 300s，长文本必然被掐断（fetch failed）。
 *    流式下响应头 ~180ms 就返回，且能持续读增量。
 * 2) 默认关闭思考模式（chat_template_kwargs.enable_thinking=false）。Qwen3.5 默认先吐
 *    大段 reasoning_content，content 为空；9B 模型仅 ~9 tok/s，开着思考会白烧几分钟。
 *
 * 多模态（2026-10-13）：opts.images = 本地图片绝对路径数组 → 自动挂到最后一条 user 消息上。
 * 需要 llama-server 启动时带了 --mmproj（launcher.cjs 自动探测），否则模型不认。
 */
async function llmChat(messages, { temperature = 0.7, maxTokens = 4096, json = false, thinking = false, timeoutMs = 900000, onDelta = null, images = null } = {}) {
  const t0 = Date.now();
  const att = images ? attachImages(messages, images) : { messages, used: [] };
  const msgs = att.messages;
  const userLen = msgs.reduce((n, m) => n + contentLen(m.content), 0);
  logger.detail('LLM 请求：输入约 ' + userLen + ' 字，max_tokens=' + maxTokens + (json ? '，JSON 模式' : '')
    + (att.used.length ? '，附图 ' + att.used.length + ' 张（' + att.used.join('、') + '）' : ''));
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
  if (!alive) throw new Error('LLM 服务不可达（' + endpoint('llm') + '）。软件会自动拉起 llama-server'
    + '（引擎随软件内置，无需安装）；若反复起不来，看右下角「运行日志」里的服务日志。');

  const body = {
    model: 'local',
    messages: msgs,
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
 *
 * 首选**软件自带**的 tools/ffmpeg/bin/ffmpeg.exe（随包分发，用户零安装，见 tools.cjs）——
 * 这条路径只是几次 fs.existsSync，毫秒级，永远不阻塞。
 *
 * 性能要点（2026-09-18 修）：`where ffmpeg` 在本机稳定耗时 5.1s，而前端每 5s 轮询一次
 * 健康检查 —— 同步 spawn 会把主进程堵死（UI 卡成 PPT）。所以「PATH 兜底」这一支
 * 仍然走「启动时异步预热 + 结果缓存」：
 *   - 内置命中 / 旧的自定义路径命中 → 立刻返回，不受缓存影响
 *   - 缓存已解析 → 直接返回
 *   - 预热中 → 返回 null（这一轮健康检查先算「没找到」，下一轮就准了）
 *   - forceSync → 真的同步查一次（导出这种一次性长任务用，保证准确性）
 */
function findFfmpeg(opts) {
  const builtin = tools.ffmpeg();          // 软件自带，开箱即用
  if (builtin) return builtin;
  // 兼容极老配置（设置页已移除该项）：只在内置缺失时生效
  const custom = db && db.getSetting('ffmpeg.path');
  if (custom && fs.existsSync(custom)) return custom;
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
  if (tools.ffmpeg()) return;   // 软件自带已命中，PATH 兜底永远用不上，不必去 spawn
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

/**
 * 抽取视频末帧 → 图片（首帧接力用，2026-10-09）。
 *
 * 「上一镜的最后一帧 = 本镜首帧」是唯一能让相邻镜头画面真正接上的做法：
 * H3 逐镜独立生成，不给它一个真实的起始画面，接缝处只能靠模型自己猜（漂移最大来源）。
 *
 * 实现要点：
 *   - `-sseof -<offset>` 从「距结尾 offset 秒」处 seek：对 mp4 走 moov 索引，快且稳（实测 ~130ms）；
 *     不用 `-ss <dur-offset>` 是因为那要先额外 ffprobe 一次拿时长，多一次进程开销。
 *   - offset 默认 0.1s：直接取绝对最后一帧有时会碰到淡出黑场 / 编码尾包，
 *     可调大（帧率 24fps 时 0.1s ≈ 倒数第 3 帧）。
 *   - `-q:v 2` 是 mjpeg 质量档（这里配 .png 输出时 ffmpeg 会忽略，保留无害）。
 *
 * 返回 { ok:true, out } 或 { ok:false, error }；ffmpeg 缺失时 error === 'NOPATH'，
 * 交给调用方给出「软件自带的 ffmpeg 没找到」的具体指引，而不是一句看不懂的报错。
 */
function extractLastFrame(video, out, offsetSec) {
  return new Promise((resolve) => {
    if (!video) return resolve({ ok: false, error: '没有指定源视频' });
    if (!fs.existsSync(video)) return resolve({ ok: false, error: '上一镜的视频文件不存在：' + video });
    const ff = findFfmpeg({ forceSync: true });
    if (!ff) return resolve({ ok: false, error: 'NOPATH' });
    const off = Number(offsetSec) > 0 ? Number(offsetSec) : 0.1;
    try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch (_) { /* 已存在 */ }
    const args = ['-y', '-hide_banner', '-loglevel', 'error',
      '-sseof', '-' + off, '-i', video, '-frames:v', '1', out];
    try {
      execFile(ff, args, { timeout: 60000, windowsHide: true, maxBuffer: 1 << 22 }, (err, _stdout, stderr) => {
        if (err) {
          const msg = String((stderr || '') || err.message || '').trim().split(/\r?\n/).slice(-3).join(' / ');
          return resolve({ ok: false, error: msg.slice(0, 300) || 'ffmpeg 执行失败' });
        }
        if (!fs.existsSync(out)) return resolve({ ok: false, error: 'ffmpeg 执行完成但没有产出图片' });
        resolve({ ok: true, out });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
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
    refImgScale: i => String(pick(ids0.refImgScale, 250) + i),
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
      const nid = id.refImg(i), sid = id.refImgScale(i);
      wf[nid] = { class_type: 'LoadImage', inputs: { image: name } };
      // 🔴 2026-10-14：参考图先缩放到**画布尺寸**再喂给条件节点（与首帧/尾帧同一套口径）。
      //    模型节点内部虽然也会缩放参考图（H3 的 ref_image_size='match' 是「按像素面积等比、
      //    只缩不放」），但那是「面积对齐」不是「尺寸对齐」—— 参考图与画布的长宽并不相同。
      //    裁剪方式由方案声明（wiring.frameCrop.ref），默认 center：等比缩放后裁掉超出部分，
      //    人物比例不变形（比例不一致的图会裁掉边缘，这是明确接受的取舍）。
      wf[sid] = {
        class_type: 'ImageScale',
        inputs: {
          image: [nid, 0], upscale_method: Wg.scaleMethod || 'lanczos',
          width: W, height: H, crop: crop.ref || 'center'
        }
      };
      ins[String(Wg.refImageKey || 'ref_images.ref_image_{i}').replace('{i}', i)] = [sid, 0];
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

// 🔴 强制停止生成（2026-10-09）：登记「当前活动任务」与「被请求中断的任务」。
// 为什么要：H3 一个 20 步高分辨率任务能跑 30 分钟以上，App 原来只能干等——用户既停不了、
// 也不能改配置重跑，只能重启 ComfyUI。现在 UI 上「停止生成」按钮走 cancelComfy()，
// 靠这两个变量让正在轮询的 comfyGenerateInner 立刻退出，而不是等它自然结束。
// 串行使用（渲染层 vBusy 保证同一时刻只有一个生成在跑），所以一对模块级变量就够。
let _activePid = null;   // 正在等待结果的 prompt_id（没有任务时为 null）
let _cancelPid = null;   // 被用户请求中断的 prompt_id：轮询循环见到即立刻退出

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

/** 用户主动停止生成（不是失败）：调用方据此走「已停止」而不是「生成失败」的提示路径 */
class CancelledError extends Error {
  constructor(pid) {
    super('用户已停止生成（prompt_id=' + pid + '）');
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
  }
}

/**
 * 强制停止生成（2026-10-09）：立刻中断 ComfyUI 正在执行的任务 + 清掉还在排队的本任务 + 释放显存。
 *
 * 顺序有讲究，不能颠倒：
 *   ① /interrupt  —— 把正在跑的那个任务断掉（这一步才是"停"的关键）
 *   ② /queue delete —— 清掉还没轮到执行的排队任务（批量场景下可能已排了好几个）
 *   ③ 等队列真正空下来 —— ComfyUI 收到 interrupt 后要过一会儿才回到 idle
 *   ④ /free —— 卸载模型、释放显存
 * 为什么不先 /free：任务还在跑的时候卸载模型会把它直接搞崩，必须等它停下来。
 *
 * 注意 /interrupt 是 ComfyUI 的**全局**中断（它没有"只中断某个 prompt"的接口）。
 * 本软件串行生成，所以只会中断我们自己的任务。
 */
async function cancelComfy() {
  const ep = endpoint('comfyui');
  const out = { ok: false, pid: _activePid, interrupted: false, cleared: 0, freed: false, stillRunning: false, errors: [] };
  // 先打取消标记：正在轮询的 comfyGenerateInner 见到就立刻退出，不等这些 HTTP 请求的结果
  if (_activePid) _cancelPid = _activePid;

  const post = (p, body, ms) => fetchJson(ep + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }, ms || 8000);

  // ① 中断正在执行的任务
  try {
    await post('/interrupt', {}, 8000);
    out.interrupted = true;
  } catch (e) {
    out.errors.push('中断当前任务失败：' + e.message);
  }

  // ② 清掉还在排队的任务（已经开跑的那个靠 ①）
  try {
    const q = await fetchJson(ep + '/queue', {}, 5000);
    const pend = (q.ok && q.json && Array.isArray(q.json.queue_pending)) ? q.json.queue_pending : [];
    const ids = pend.map(it => (Array.isArray(it) ? it[1] : (it && it.prompt_id))).filter(Boolean);
    if (ids.length) {
      await post('/queue', { delete: ids }, 8000);
      out.cleared = ids.length;
    }
  } catch (e) {
    out.errors.push('清理排队任务失败：' + e.message);
  }

  // ③ 等 ComfyUI 真正回到空闲（最多约 7.5s），否则下一步会把还在用的模型卸掉
  let idle = false;
  for (let i = 0; i < 25; i++) {
    try {
      const q = await fetchJson(ep + '/queue', {}, 4000);
      if (q.ok && q.json && !(q.json.queue_running || []).length) { idle = true; break; }
    } catch (_) { break; }   // 查不通就别硬等，直接试最后一步
    await new Promise(r => setTimeout(r, 300));
  }
  out.stillRunning = !idle;

  // ④ 释放显存（下次生成会重新加载权重，H3 约十几秒）
  try {
    await post('/free', { unload_models: true, free_memory: true }, 8000);
    out.freed = true;
  } catch (e) {
    out.errors.push('释放显存失败：' + e.message);
  }

  out.ok = out.interrupted || out.cleared > 0 || out.freed;
  logger.info('停止生成：' + (out.interrupted ? '已中断当前任务' : '未中断到执行中的任务')
    + (out.cleared ? '，已清掉 ' + out.cleared + ' 个排队任务' : '')
    + (out.freed ? '，已释放显存' : '，显存释放失败')
    + (out.errors.length ? '（' + out.errors.join('；') + '）' : ''));
  return out;
}

/** 对外入口：进来取消挂起的释放（新任务跟上）；出去（成功/失败都算任务结束）开始空闲倒计时 */
async function comfyGenerate(args) {
  disarmVramFree();
  try {
    return await comfyGenerateInner(args);
  } finally {
    armVramFree();
    // 任务彻底结束（成功 / 失败 / 被停止都一样）→ 注销活动任务，别让「停止生成」打到已结束的任务上
    _activePid = null;
    _cancelPid = null;
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
  // 登记为「当前活动任务」：用户点「停止生成」时靠它定位要中断谁（见 cancelComfy）。
  // 新任务一开始就把上一轮可能残留的取消标记清掉，否则会一上来就被误判成"已取消"。
  _activePid = pid;
  _cancelPid = null;

  // 轮询直到完成。
  // ⚠️ 三种"end"都要立刻跳出，不能只等 completed：任务报错时 completed 永远是 false，
  //    以前只判断 completed → 报错也傻等到超时（1800s），界面看着像卡死。
  //    这里：①完成 ②出错 ③任务从队列里消失（连续 3 次看不到）→ 立即结束。
  // 🔴 2026-10-09「稳妥超时」：timeoutMs 由「硬上限」改成「软上限」——
  //    到点后不再一律放弃，先看 /queue：只要这条任务仍在 queue_running / queue_pending，
  //    就说明它是在正常跑、只是慢（例如 20 步 + 高分辨率 + 多参考图，实测 1344×768 约需
  //    1900～2200s，越过 1800s 仅百余秒），于是继续等下去，不误杀慢任务。
  //    真卡死时（ComfyUI 崩溃 / 被重启 / 任务被人为中断）队列里查不到它 → 仍走 ③ 立刻报错。
  //    hardMs 是兜底硬上限，防止任务因故永远挂在队列里导致无限等待。
  const t0 = Date.now();
  const softMs = timeoutMs;                                     // 软上限：默认 1800s（30 分钟）
  const hardMs = Math.max(timeoutMs * 3, timeoutMs + 3600000);  // 硬上限：默认 5400s（90 分钟）
  let lastTick = t0;
  let history = null;
  let vanished = 0;
  let renewed = 0;                                              // 因「仍在队列中」而跨过软上限继续等
  let unreachable = 0;                                          // ComfyUI 连续无响应次数
  while (Date.now() - t0 < hardMs) {
    // 用户点了「停止生成」→ 立刻退出，不再等 ComfyUI（interrupt 已由 cancelComfy 发出）
    if (_cancelPid === pid) throw new CancelledError(pid);
    await new Promise(r => setTimeout(r, 1200));
    if (Date.now() - lastTick >= 30000) {
      lastTick = Date.now();
      logger.detail('执行中…已等待 ' + Math.round((Date.now() - t0) / 1000) + 's（' + baseName + '）');
    }
    let h;
    try {
      h = await fetchJson(endpoint('comfyui') + '/history/' + pid, {}, 8000);
      unreachable = 0;
    } catch (_) {
      // ComfyUI 整个不可达（进程退出 / 端口断了）：连续拿不到响应就报错。
      // 双条件（次数 + 至少 2 分钟）避免 ComfyUI 重启中的短暂断连被误判；
      // 没有这道门的话，进程挂掉会一路等到硬上限（默认 90 分钟）才给用户反馈。
      if (++unreachable >= 30 && Date.now() - t0 > 120000) {
        throw new Error('ComfyUI 连续 ' + unreachable + ' 次无响应（prompt_id=' + pid
          + '）：ComfyUI 可能已退出或端口不通，请检查 ComfyUI 状态后重试。');
      }
      continue;
    }
    if (h.ok && h.json && h.json[pid]) {
      history = h.json[pid];
      const st = history.status || {};
      if (st.completed) break;
      if (st.status_str === 'error') break;      // ② 出错：立刻跳出，下面统一报错
    } else if (Date.now() - t0 > 15000) {
      // ③ 既不在 history、也不在队列里 → 任务被中断 / ComfyUI 重启过
      let q = null;
      try { q = await fetchJson(endpoint('comfyui') + '/queue', {}, 8000); } catch (_) { q = null; }
      if (q && q.ok && q.json) {
        const inQueue = ['queue_running', 'queue_pending'].some(k =>
          Array.isArray(q.json[k]) && q.json[k].some(it => (Array.isArray(it) ? it[1] : it && it.prompt_id) === pid));
        if (inQueue) {
          vanished = 0;
          // 软超时已过但任务确实还在队列里跑 → 续期继续等（只在跨过软上限的第一次记一条日志）
          if (Date.now() - t0 > softMs && renewed === 0) {
            logger.info('任务已超过 ' + Math.round(softMs / 60000) + ' 分钟等待上限，但它在 ComfyUI 队列中仍在运行，继续等待：'
              + baseName + '（prompt_id=' + pid + '）');
          }
          if (Date.now() - t0 > softMs) renewed++;
        } else {
          vanished++;
          if (vanished >= 3) throw new Error('任务已从 ComfyUI 队列消失（prompt_id=' + pid + '）：ComfyUI 可能被重启或任务被中断，请重试。');
        }
      }
    }
  }
  // 到达硬上限退出前再确认一次：任务可能刚好在这一刻完成（避免差一两秒误报超时）
  if (!history) {
    try {
      const h2 = await fetchJson(endpoint('comfyui') + '/history/' + pid, {}, 8000);
      if (h2.ok && h2.json && h2.json[pid]) history = h2.json[pid];
    } catch (_) { /* 查不到就按超时处理 */ }
  }
  if (!history) {
    const waited = Math.round((Date.now() - t0) / 1000);
    throw new Error('ComfyUI 任务超时未完成（prompt_id=' + pid + '，已等待 ' + waited + 's）'
      + (renewed > 0
        ? '：该任务一直在 ComfyUI 队列里运行（属慢任务），但已超过最长等待上限。'
          + '可稍后到 ComfyUI 界面确认它是否已完成（产物会留在 ComfyUI 的 output 目录）。'
        : '：ComfyUI 长时间没有返回结果，请到 ComfyUI 界面确认任务状态后重试。'));
  }
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

/**
 * 秒 → SRT 时间戳 HH:MM:SS,mmm。
 * ⚠️ 必须先整体 round 到毫秒再拆分：旧写法对「秒的小数部分」单独 round，
 *    遇到 1.9996 这类会算出 1000 → "00:00:01,1000"（非法 SRT，libass 直接报错）。
 */
function srtTime(sec) {
  let ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
}

/* -------- 字幕时间轴（Dragon 2026-10-12：文本忠于分镜脚本，只把时间轴做实） --------
 *
 * 旧实现的时间轴 = 「分镜计划时长」累加。但视频是 H3 按 17k+5 帧网格生成的，
 * 实际时长必然对不上（H10 四镜整体漂 1.75s）→ 字幕越往后越不贴画面。
 *
 * 现在分两层修正，全程不需要任何 AI 模型：
 *   A. 逐镜实测时长：对每个分镜跑一次 ebur128（`-vn` 只解音频，很快），
 *      同一次进程里既拿到 Duration 又拿到响度曲线 → 时间轴以真实时长为准；
 *      再用母片的实际总时长按比例校正一次，消除累加误差。
 *   B. 镜内人声定位：H3 的音频是「人声 + 背景音乐」混音，几乎没有真正的静音，
 *      silencedetect 切不出说话段（H10 实测四镜全部 0 段，字幕退化成整镜铺满）。
 *      改用响度窗：人声段能量显著高于纯音乐段 → 按台词朗读时长估一个窗口长度，
 *      在响度曲线里滑窗取「平均响度最高」的区间放字幕，边缘再按响度修剪。
 * 逐级降级（无 ffmpeg / 无音轨 / 曲线解析不到）一路退到「计划时长 + 整镜均分」，
 * 保证导出永远能出片。
 */

/** 中文旁白/对白的朗读速度估算（字/秒）。只用来定字幕该占多长，误差由「响度窗」吸收 */
const SPEECH_CPS = 4.2;
/** 说话段 / 字幕条的最小时长，低于此值视为噪声碎片丢弃 */
const MIN_CUE_SEC = 0.3;
/** 相邻字幕之间留的间隙，避免两条紧贴显示 */
const CUE_GAP_SEC = 0.05;
/** ebur128 对纯静音输出 -120.7 LUFS，参与均值前压到这个地板，避免一条静音把均值拖成负无穷 */
const LEVEL_FLOOR = -60;
/** 窗口边缘修剪：边缘响度低于「窗内均值 - 此值」就往里收（估计时长偏长时贴回人声边界） */
const TRIM_MARGIN_DB = 9;

/** 并发跑异步任务（逐镜探测要起进程，限并发，避免一次轰出几十个） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(new Array(n).fill(0).map(async () => {
    for (;;) {
      const k = next++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

/** 从 ffmpeg stderr 解析 "Duration: 00:00:12.34" → 秒（拿不到返回 0） */
function parseDurationLine(txt) {
  const m = String(txt || '').match(/Duration:\s*(\d+):(\d{2}):(\d{2}\.\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * 解析 ebur128 输出的瞬时响度曲线（每 100ms 一点）→ [{t, db}]。
 * H3 生成的是「人声 + 背景音乐」混音，几乎没有真正的静音，silencedetect 切不出来；
 * 但人声段能量显著高于纯音乐段，所以用响度曲线找「最响的窗口」定位人声。
 */
function parseLevelCurve(txt) {
  const out = [];
  const re = /t:\s*([\d.]+)\s+TARGET:[^\n]*?M:\s*(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(String(txt || '')))) {
    const t = parseFloat(m[1]), db = parseFloat(m[2]);
    if (Number.isFinite(t) && Number.isFinite(db)) out.push({ t, db: Math.max(db, LEVEL_FLOOR) });
  }
  return out;
}

/**
 * 在响度曲线里找长度 estSec、平均响度最高的连续窗口（人声最集中的区间）。
 * 纯函数：level 已按时间升序；span 限制搜索范围；找不到（曲线为空/窗口装不下）返回 span。
 */
function bestSpeechSpan(level, estSec, span) {
  const pts = (level || []).filter(p => Number.isFinite(p.t) && p.t >= span.t0 - 0.1 && p.t <= span.t1 + 0.1);
  const est = Math.max(0.3, estSec);
  if (pts.length < 3 || est >= span.t1 - span.t0 - 0.2) return { t0: span.t0, t1: span.t1 };
  const step = pts.length > 1 ? Math.max(0.05, (pts[pts.length - 1].t - pts[0].t) / (pts.length - 1)) : 0.1;
  const k = Math.max(1, Math.round(est / step));
  let best = null;
  for (let i = 0; i + k <= pts.length; i++) {
    let sum = 0;
    for (let j = i; j < i + k; j++) sum += pts[j].db;
    const mean = sum / k;
    if (!best || mean > best.mean + 1e-9) best = { i, mean };
  }
  if (!best) return { t0: span.t0, t1: span.t1 };
  return { t0: Math.max(span.t0, pts[best.i].t - step / 2), t1: Math.min(span.t1, pts[best.i].t - step / 2 + est) };
}

/** 窗口边缘修剪：首/尾响度明显低于窗内均值时往里收，贴回真实人声边界（估计时长偏长时用） */
function trimSpeechSpan(level, win) {
  let pts = (level || []).filter(p => p.t >= win.t0 - 0.1 && p.t <= win.t1 + 0.1);
  if (pts.length < 3) return win;
  const mean = pts.reduce((a, b) => a + b.db, 0) / pts.length;
  const cut = mean - TRIM_MARGIN_DB;
  let i = 0, j = pts.length - 1;
  while (i < j && pts[i].db < cut) i++;
  while (j > i && pts[j].db < cut) j--;
  if (j - i < 1) return win;
  return { t0: Math.max(win.t0, pts[i].t), t1: Math.min(win.t1, pts[j].t) };
}

/** 成对引号表：字幕连包裹引号一起剥掉（'「A」和「B」' 这种两段的不是一对，不动） */
const CUE_QUOTE_PAIRS = { '“': '”', '「': '」', '『': '』', '‘': '’', '"': '"', "'": "'" };

/** 剥掉整体包裹的引号（最多两层，容「“…”」这种双层套写） */
function stripCueQuotes(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 2; i++) {
    const a = t.charAt(0), b = t.charAt(t.length - 1);
    if (t.length < 2 || CUE_QUOTE_PAIRS[a] !== b) break;
    const body = t.slice(1, -1).trim();
    if (body.includes(b)) break;   // 中间还有同类引号 → 是两段并列，不是整体包裹
    t = body;
  }
  return t;
}

/**
 * 字幕正文：剥掉行首的「说话人：」前缀，再剥掉整体包裹的引号。
 * 分镜台词写成「林澈：「那就进去看看。」」，但影视字幕惯例既不带说话人、也不带引号。
 * 只认 1~8 字的短前缀，长句子里的冒号（「这是一句很长的旁白文字：内容」）原样保留。
 */
function cueText(line) {
  const s = String(line || '').trim().replace(/^[^：:]{1,8}[：:]\s*/, '');
  return stripCueQuotes(s);
}

/** 台词权重：去「说话人：」前缀后的可见字符数（决定多句各占多长时间） */
function cueWeight(line) {
  return Math.max(1, cueText(line).replace(/\s/g, '').length);
}

/** 多句但说话段数与行数不等时：按字数权重把台词铺满 [t0,t1]（近似，不跨镜）；ws 为调用方已算好的权重 */
function spreadByWeight(lines, t0, t1, ws) {
  ws = ws || lines.map(cueWeight);
  const sum = ws.reduce((a, b) => a + b, 0) || 1;
  const span = Math.max(0, t1 - t0);
  const cues = [];
  let acc = 0;
  lines.forEach((text, i) => {
    const a = t0 + span * (acc / sum);
    acc += ws[i];
    const b = t0 + span * (acc / sum);
    let end = b;
    if (i < lines.length - 1 && b - a > MIN_CUE_SEC + CUE_GAP_SEC) end = b - CUE_GAP_SEC;
    cues.push({ t0: a, t1: Math.max(end, a + 0.1), text });
  });
  return cues;
}

/**
 * 单镜台词 → 字幕条（**镜内坐标**：span 以 0 起算，调用方负责平移到全片时间轴）。
 * @param lines 该镜台词行（已 trim、去空行）；行首「说话人：」前缀在此统一剥掉
 * @param level 该镜的 ebur128 响度曲线 [{t,db}]（镜内坐标），可为空
 * @param span  该镜区间 {t0,t1}，响度曲线缺失时兜底
 */
function buildCues(lines, level, span) {
  // 字幕只烧正文：剥完前缀为空的行走不进候选（否则它会白占一段时长，把后面的句子挤错位）
  const ls = (lines || []).map(cueText).filter(Boolean);
  const n = ls.length;
  if (!n) return [];
  const usable = span.t1 - span.t0;
  if (!(usable > 0)) return [];
  const ws = ls.map(s => Math.max(1, s.replace(/\s/g, '').length));
  // 每句朗读时长 ≈ 正文字数 / SPEECH_CPS（下限 1.2s，一句话总得闪一瞬）
  const estTotal = ws.reduce((a, w) => a + Math.max(1.2, w / SPEECH_CPS), 0) + (n - 1) * CUE_GAP_SEC;
  // 曲线缺失（无音轨 / 解析失败），或台词本来就要念满整镜 → 退回整镜按字数铺开
  const lv = (level || []).filter(p => Number.isFinite(p.t) && Number.isFinite(p.db));
  if (lv.length < 3 || estTotal >= usable - 0.2) {
    return spreadByWeight(ls, span.t0, span.t1, ws);
  }
  // 人声最响的窗口放字幕；估长了再按边缘响度贴回人声边界
  const win = trimSpeechSpan(lv, bestSpeechSpan(lv, estTotal, span));
  return spreadByWeight(ls, win.t0, win.t1, ws);
}

/** 全片字幕条：按实测时长逐镜定位边界；镜内用响度窗把台词放到人声最集中的区间 */
function buildFilmCues(videos, durs, levels) {
  const cues = [];
  let t = 0;
  videos.forEach((v, i) => {
    const d = Number(durs[i]) || 0;
    const S = t, E = t + d; t = E;
    const lines = String(v.dialogue || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return;
    const local = buildCues(lines, (levels || [])[i] || [], { t0: 0, t1: d });
    local.forEach(c => { c.t0 += S; c.t1 += S; cues.push(c); });
  });
  return cues;
}

/** 字幕条 → SRT 文本（带 BOM：libass 读中文必需；无字幕时返回空串） */
function cuesToSrt(cues) {
  const blocks = (cues || [])
    .filter(c => c && c.text && c.t1 > c.t0)
    .map((c, i) => (i + 1) + '\n' + srtTime(c.t0) + ' --> ' + srtTime(c.t1) + '\n' + c.text);
  return blocks.length ? '\ufeff' + blocks.join('\n\n') + '\n' : '';
}

/** 逐镜分析：一次 ffmpeg 进程同时拿到实测时长与镜内响度曲线（ebur128 每 100ms 一点，-vn 只解音频，很快） */
function analyzeShot(ffmpeg, file) {
  return new Promise(resolve => {
    // ⚠️ 不能加 -nostats：ebur128 的响度行会跟着一起被吞掉
    const args = ['-hide_banner', '-loglevel', 'info', '-i', file, '-vn',
      '-af', 'ebur128=peak=none', '-f', 'null', '-'];
    try {
      execFile(ffmpeg, args, { windowsHide: true, timeout: 180000, maxBuffer: 1 << 24 }, (err, _stdout, stderr) => {
        const txt = String(stderr || '');
        resolve({ dur: parseDurationLine(txt), level: parseLevelCurve(txt) });
      });
    } catch (_) { resolve({ dur: 0, level: [] }); }
  });
}

/** ffprobe 读单个文件的时长（母片真实总时长，用来校正按镜累加的误差） */
function probeDuration(ffmpeg, file) {
  return new Promise(resolve => {
    const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (!fs.existsSync(ffprobe)) return resolve(0);
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file];
    try {
      execFile(ffprobe, args, { windowsHide: true, timeout: 30000, maxBuffer: 1 << 20 }, (err, stdout) => {
        const d = parseFloat(String(stdout || '').trim());
        resolve(!err && Number.isFinite(d) && d > 0 ? d : 0);
      });
    } catch (_) { resolve(0); }
  });
}

/** 跑一次 ffmpeg，收集 stderr（失败时给上层拼错误信息） */
function runFfmpeg(ffmpeg, args, cwd) {
  return new Promise(resolve => {
    const p = spawn(ffmpeg, args, { windowsHide: true, cwd });
    let err = '';
    p.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-4000); });
    p.on('close', code => resolve({ code, err }));
    p.on('error', e => resolve({ code: -1, err: String(e) }));
  });
}

/**
 * 真实拼接导出：concat + 统一输出分辨率 + 可选字幕烧录。
 * videos: [{file, dialogue, dur}]（绝对路径）
 * opts.width/height：输出分辨率（剧集「输出分辨率」配置），默认 1920x1080。
 */
async function exportVideo(outDir, outName, videos, { subtitles = true, width = 1920, height = 1080, scope = '' } = {}) {
  // 导出是一次性长任务：这里同步确认一次 ffmpeg（避免「预热没跑完」被误判成没装）
  const ffmpeg = findFfmpeg({ forceSync: true });
  if (!ffmpeg) throw new Error('未找到 ffmpeg。软件自带的 tools/ffmpeg/bin/ffmpeg.exe 不见了，'
    + '请重新安装，或把 ffmpeg 放进系统 PATH。');
  fs.mkdirSync(outDir, { recursive: true });
  if (!videos.length) throw new Error('没有可拼接的视频片段');
  const W = Math.max(16, Math.round(Number(width) || 1920));
  const H = Math.max(16, Math.round(Number(height) || 1080));
  const tExport = Date.now();
  logger.info('ffmpeg 组装成片：' + videos.length + ' 个镜头，输出 ' + W + 'x' + H + (subtitles ? ' + 字幕烧录' : ''));

  const tmp = path.join(outDir, '_tmp_' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const vfBase = 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2';

    // concat 列表（先统一转码为相同规格，避免拼接黑屏）
    const listFile = path.join(tmp, 'list.txt');
    fs.writeFileSync(listFile, videos.map(v => 'file \'' + v.file.replace(/\\/g, '/').replace(/'/g, "'\\''") + '\'').join('\n'), 'utf-8');

    const outBase = sanitize(outName);
    // 走 assetStore 永不覆盖
    const finalName = (() => {
      let name = outBase + '.mp4', i = 2;
      while (fs.existsSync(path.join(outDir, name))) { name = outBase + '_' + String(i).padStart(2, '0') + '.mp4'; i++; }
      return name;
    })();
    const finalPath = path.join(outDir, finalName);
    const concatArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];

    if (!subtitles) {
      const res = await runFfmpeg(ffmpeg, [...concatArgs, '-vf', vfBase, '-c:v', 'libx264', '-preset', 'medium',
        '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', finalPath], tmp);
      if (res.code !== 0 || !fs.existsSync(finalPath)) throw new Error('ffmpeg 导出失败：' + res.err.slice(-500));
    } else {
      // ---- pass1：先拼出无字幕母片（CRF 16，中间产物尽量少掉一代画质）----
      const mutePath = path.join(tmp, 'mute.mp4');
      const r1 = await runFfmpeg(ffmpeg, [...concatArgs, '-vf', vfBase, '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '16', '-c:a', 'aac', '-b:a', '160k', mutePath], tmp);
      if (r1.code !== 0 || !fs.existsSync(mutePath)) throw new Error('ffmpeg 拼接母片失败：' + r1.err.slice(-500));

      // ---- A + B：逐镜实测时长（A）+ 镜内响度窗定位人声（B）----
      const shots = await mapLimit(videos, 4, v => analyzeShot(ffmpeg, v.file));
      const dursRaw = shots.map((s, i) => s.dur || Number(videos[i].dur) || 5);
      const sumRaw = dursRaw.reduce((a, b) => a + b, 0) || 1;
      // 母片真实总时长 ÷ 按镜累加 → 校正系数（concat 帧对齐会有毫秒级出入）
      const realTotal = await probeDuration(ffmpeg, mutePath);
      const k = realTotal > 0 ? realTotal / sumRaw : 1;
      const durs = dursRaw.map(d => d * k);
      // 响度曲线是「镜内坐标」，时间轴同样按 k 缩放后交给 buildFilmCues
      const levels = shots.map(s => (s.level || []).map(p => ({ t: p.t * k, db: p.db })));
      const cues = buildFilmCues(videos, durs, levels);
      const srt = cuesToSrt(cues);

      if (srt) {
        // srt 必须 UTF-8 with BOM 才能被 ffmpeg libass 正确读中文。
        // ⚠️ subtitles 滤镜参数不要带绝对路径：Windows 盘符冒号要过「滤镜图解析→选项解析」
        // 两层转义，少一层就把路径后半段当成 original_size 选项（报 Invalid argument）。
        // 解法：spawn 的 cwd 设为临时目录，滤镜里只写裸文件名 subs.srt，无冒号无空格。
        fs.writeFileSync(path.join(tmp, 'subs.srt'), srt, 'utf-8');
        // ---- pass2：把字幕烧到母片上（母片已是目标分辨率，不再 scale/pad）----
        const r2 = await runFfmpeg(ffmpeg, ['-y', '-i', 'mute.mp4', '-vf',
          `subtitles=subs.srt:force_style='FontSize=${SUBTITLE_FONT_SIZE}'`,
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'copy',
          '-movflags', '+faststart', finalPath], tmp);
        if (r2.code !== 0 || !fs.existsSync(finalPath)) throw new Error('ffmpeg 烧录字幕失败：' + r2.err.slice(-500));
        logger.info('字幕 ' + cues.length + ' 条 / ' + videos.length + ' 镜（实测时长 + 响度窗定位）');
      } else {
        // 没有台词 → 母片就是成品，直接搬，省一遍转码
        fs.copyFileSync(mutePath, finalPath);
        logger.info('本片没有需要烧录的台词，直接输出母片');
      }
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
      // 🔴 需求（Dragon 2026-10-09，**反转** 2026-09-22 的旧需求「重复导出 = 替换旧成片」）：
      //    多次导出**各自留档**，旧成片一律保留。成片格只显示最新一版（渲染层按 mtime 倒序取
      //    films[0]），历史版本留在 成片/ 里随时可翻、可对比。
      //    ⚠️ 不要再按 scope 前缀删「本集的旧成片 mp4 + 封面 .xxx.mp4.poster.jpg + meta 记录」——
      //    那等于把前几次导出直接覆盖掉（就是这次要修的 bug）。
      //    scope 参数保留：调用方仍按集传前缀（目前只作语义标识，不参与删文件）。
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
  comfyGenerate, cancelComfy, workflowPath, ensureDefaultTemplates, findFfmpeg, exportVideo,
  extractLastFrame,
  applyParams, findPlaceholders, h3Params, forgetWorkspace, listVideosWithMeta,
  // 模型方案驱动的部分（换模型只改配置，下面是代码侧入口）
  injectMedia, phTips, optionalPlaceholders,
  // 字幕时间轴纯函数（离线自测用，不需要显卡/ffmpeg/Electron）
  srtTime, parseDurationLine, parseLevelCurve, bestSpeechSpan, trimSpeechSpan, cueText, cueWeight, spreadByWeight, buildCues, buildFilmCues, cuesToSrt,
  analyzeShot, probeDuration,
  // 导出仅为离线自测（test/h3-inject-check.cjs 直接验证连线，不需要显卡/ComfyUI）
  injectH3Media,
  // 多模态纯函数（离线自测：把本地图读成 data URL 挂到 user 消息上）
  attachImages, contentLen, IMG_MIME, MAX_LLM_IMAGES, MAX_LLM_IMAGE_BYTES
};
