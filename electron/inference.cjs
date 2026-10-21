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
const llmProvider = require('./llmProvider.cjs');
const comfyProbe = require('./comfyProbe.cjs');
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

/* 云端大模型的 max_tokens 上限兜底（超出会被判 400）。
   ⚠️ 各家云厂商上限不同：DeepSeek V4.1 Flash / V4 Pro 是 384K（1M 上下文），这里取一个保守大值。
   原值 8192 是 V3 时代的限制、已过时 —— 它会把各环节原本 12288 的输出预算硬压到 8192
   （adapt / shots 首当其冲）。2026-10-15 由 8192 上调至 65536。
   🔴 这里只是**上限兜底**，实际下发的仍是各调用点自己的 maxTokens（改上限 ≠ 改配额）。
   本地不走这个限制 —— 每槽 32768 是 llama-server 的 -c。 */
const CLOUD_MAX_TOKENS = 65536;

/* 云端**思考模式**的最小输出预算（2026-10-15 实测）。
   V4 系 thinking 默认 enabled，而思考链先于正文生成：配额不够时 reasoning_tokens 会把
   max_tokens 100% 吃光 —— 正文 0 字、finish_reason=length（实测 8192/12288 配额下 6 环节 5 个失败）。
   所以「开思考」的环节必须**同时给足预算**，否则等于白开。实测 32768 即可跑通，这里留足余量取 48K。 */
const THINK_MIN_TOKENS = 49152;

function init(dbRef) {
  db = dbRef;
  profiles.init(dbRef);   // 模型方案就位后，工作流路径 / 节点锚点 / 帧参数才有得读
  llmProvider.init(dbRef);   // 大模型来源（本地 / 云端）配置；加解密由 ipc 层注入
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

/** 单条消息的文字长度 */
/**
 * 消息内容长度（用于日志与上下文预算估算）。
 * 2026-10-17：兼容 OpenAI 多模态 content 数组 —— 图片 base64 是几百万字符，
 * 直接 String(数组) 会得出荒谬的数字；图片按 Qwen-VL 的固定视觉开销折算（≈1024 image token）。
 */
function contentLen(c) {
  if (Array.isArray(c)) {
    let n = 0;
    for (const p of c) {
      if (!p) continue;
      if (p.type === 'image_url') n += 1600;
      else if (p.type === 'text') n += String(p.text || '').length;
      else if (typeof p === 'string') n += p.length;
    }
    return n;
  }
  return String(c || '').length;
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
 */
async function llmChat(messages, { temperature = 0.7, maxTokens = 4096, json = false, thinking = false, timeoutMs = 900000, onDelta = null, stage = '', providerOverride = '' } = {}) {
  const t0 = Date.now();
  // 本环节走本地还是云端：设置页是**唯一持久入口**（见 llmProvider.cjs 顶部约定）；
  // providerOverride 是阶段页上的「本次运行」覆盖（纯内存，见 src/llmSource.js）。
  const prov = llmProvider.resolve(stage, providerOverride);
  const cloud = prov.kind === 'cloud';
  const msgs = messages;
  const userLen = msgs.reduce((n, m) => n + contentLen(m.content), 0);
  logger.detail('LLM 请求（' + (cloud ? '云端 ' + prov.model : '本地') + '）：输入约 ' + userLen
    + ' 字，max_tokens=' + maxTokens + (json ? '，JSON 模式' : ''));
  // 软护栏（2026-09-27）：按本机 Qwen3.5 实测换算率（1 中文字 ≈ 0.64 token）估算总量，
  // 接近每槽 -c 32768 上限时提前警告（输出预算会被压缩）——只提示、不拦截。
  // 🔴 只对**本地**成立：云端上下文与计费口径不同，套这个换算没有意义。
  if (!cloud) {
    const estIn = Math.round(userLen * 0.64);
    if (estIn + maxTokens > 30000) {
      logger.warn('LLM 上下文吃紧：输入约 ' + userLen + ' 字（≈' + estIn + ' tok）+ max_tokens=' + maxTokens +
        ' ≈ ' + (estIn + maxTokens) + ' tok，已接近单槽 32768 上限，建议精简规范或章节原文');
    }
  }
  const base = cloud ? prov.baseUrl : endpoint('llm');
  if (cloud) {
    // 云端只校验「配没配密钥」——本地引擎起没起与它无关（也**不该**去拉起 llama-server）
    if (!prov.apiKey) {
      throw new Error('云端大模型未配置 API Key（环节：' + prov.stage + '）。'
        + '请到「设置 → 大模型来源」填入密钥，或把该环节改回本地。');
    }
    // 思考模式要额外预算：思考链会先把配额吃光（见 THINK_MIN_TOKENS 注释）
    if (thinking && maxTokens < THINK_MIN_TOKENS) {
      logger.detail('云端思考模式：max_tokens 从 ' + maxTokens + ' 抬到 ' + THINK_MIN_TOKENS + '（思考链先吃配额）');
      maxTokens = THINK_MIN_TOKENS;
    }
    // 各家云模型的 max_tokens 上限不同，超了直接 400
    if (maxTokens > CLOUD_MAX_TOKENS) {
      logger.detail('云端 max_tokens 从 ' + maxTokens + ' 压到 ' + CLOUD_MAX_TOKENS + '（云模型上限兜底）');
      maxTokens = CLOUD_MAX_TOKENS;
    }
  } else {
    // 先快速探活（1.5s），避免连接挂起时用户干等
    let alive = false;
    try { alive = (await fetchJson(base + '/v1/models', {}, 1500)).ok; } catch (_) {}
    if (!alive) throw new Error('LLM 服务不可达（' + base + '）。软件会自动拉起 llama-server'
      + '（引擎随软件内置，无需安装）；若反复起不来，看右下角「运行日志」里的服务日志。');
  }

  const body = {
    messages: msgs,
    temperature,
    max_tokens: maxTokens,
    stream: true
  };
  if (cloud) {
    body.model = prov.model;
    // 思考模式开关（2026-10-15 实测）：DeepSeek V4 系 thinking **默认 enabled**，产品不显式
    // 声明的话配额会被思考链吃光、正文 0 字（见 THINK_MIN_TOKENS 注释）。三种取值：
    //   thinking 假            → 显式关（type:'disabled'）
    //   thinking === true      → 开，强度吃官方默认（high）
    //   'low' / 'high' / 'max' → 开 + 指定 reasoning_effort
    if (thinking) {
      body.thinking = { type: 'enabled' };
      if (typeof thinking === 'string') body.reasoning_effort = thinking;
    } else {
      body.thinking = { type: 'disabled' };
    }
  } else {
    // chat_template_kwargs 是 llama.cpp 专属（Qwen 的思考开关），云端不认识 → 只在本地路径下发。
    // 🔴 只认**严格布尔** true：字符串强度（如 'low'，用于云端）不会误开本地思考 ——
    //    实测 9B 本地开思考会白烧几分钟且交不出正文（思考吃光 32768 配额）。
    //    产品各调用点恒定不传（= 关）；`true` 仅留给实验对照。
    body.model = 'local';
    body.chat_template_kwargs = { enable_thinking: thinking === true };
  }
  if (json) body.response_format = { type: 'json_object' };

  const headers = { 'Content-Type': 'application/json' };
  if (cloud) headers.Authorization = 'Bearer ' + prov.apiKey;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // 🔴 超时文案按环节分（2026-10-19）：分镜是最容易「剧本一长就等不完」的环节，
  //    用户口径是「分镜最长等 10 分钟，超时直接告诉他剧本太长、建议分集」——
  //    统一报「请求超时」会让人以为是网络问题，白等一轮。
  const timeoutMins = Math.max(1, Math.round(timeoutMs / 60000));
  const timeoutError = () => new Error(
    stage === 'shots'
      ? '剧本太长，建议分集后重试（分镜生成超过 ' + timeoutMins + ' 分钟仍未完成）'
      : (cloud ? '云端大模型' : 'LLM') + '请求超时（已等待 ' + timeoutMins + ' 分钟）'
  );
  let res;
  try {
    res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (ctrl.signal.aborted) throw timeoutError();
    throw new Error((cloud ? '云端大模型' : 'LLM') + '请求失败（连接中断或超时）：' + (e && e.message || e));
  }
  if (!res.ok) {
    clearTimeout(timer);
    let t = '';
    try { t = await res.text(); } catch (_) {}
    // 🔴 云端失败**不回退本地**（用户口径 2026-10-15）：宁可停在原地让人看清原因，也不偷偷换模型。
    throw new Error((cloud ? '云端大模型返回错误 ' : 'LLM 返回错误 ') + res.status
      + (cloud ? '（本次不会自动改走本地：请检查密钥 / 余额 / 网络后重试，或把该环节改回本地）' : '')
      + ': ' + t.slice(0, 300));
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
  } catch (e) {
    // 流式读到一半被超时 abort：同样走「剧本太长」那条文案，不要漏成裸的 AbortError
    if (ctrl.signal.aborted) throw timeoutError();
    throw new Error((cloud ? '云端大模型' : 'LLM') + '流式读取中断：' + (e && e.message || e));
  } finally { clearTimeout(timer); }

  if (!content) {
    if (reasoning) throw new Error('模型只输出了思考内容、没有正文（max_tokens=' + maxTokens + ' 可能被思考耗尽）。请确认已关闭思考模式或增大 max_tokens。');
    throw new Error('LLM 返回内容为空');
  }
  // 输出被 max_tokens 掐断时明确报错（此前静默返回半截 JSON / 半篇改编稿，下游才爆错，难排查）
  if (finishReason === 'length') {
    throw new Error('LLM 输出被 max_tokens=' + maxTokens + ' 截断（finish_reason=length，已生成 ' +
      content.length + ' 字）。' + (stage === 'shots'
        ? '剧本太长，建议分集后重试；也可以到设置里调大输出上限。'
        : '请到设置里调大输出上限，或精简规范 / 拆短章节。'));
  }
  logger.done('LLM 返回 ' + content.length + ' 字' + (finishReason ? '（finish=' + finishReason + '）' : ''), Date.now() - t0);
  return content;
}

/* ------------------------------------------------------------------ */
/* 提示词反推（图片 → 正向提示词）                                      */
/* ------------------------------------------------------------------ */

/** 图片反推的系统提示词：约束成「可直接喂给文生图」的一段短语式描述 */
const REVERSE_SYSTEM = [
  '你是资深 AI 绘画提示词工程师。用户会给你一张图片，你要把它反推成一条可直接用于文生图 / 图生图的中文正向提示词。',
  '',
  '输出要求：',
  '1. 只输出提示词正文：不要解释、不要前缀、不要编号、不要 Markdown、不要引号。',
  '2. 单段，60~140 字。',
  '3. 按「主体 → 外观与服饰细节 → 场景 → 光线 → 镜头与构图 → 材质与画风」的顺序写，用逗号分隔的短语，不要写成散文长句。',
  '4. 写得具体可执行：给出颜色、材质、款式、数量、相对位置；避免「美丽」「好看」「精致」这类空泛形容词。',
  '5. 不要写负面词；不要出现「这张图」「画面中」「如图所示」这类元叙述。',
  '6. 不要输出思考过程。'
].join('\n');

const IMG_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.bmp': 'image/bmp'
};

/** 剥掉思考块与常见包装（模型偶尔会套代码围栏 / 「好的，」开头 / 整段引号） */
function cleanPromptText(text) {
  let s = String(text || '');
  s = s.replace(/<think[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<\|think\|>[\s\S]*?<\|\/think\|>/gi, '');
  s = s.replace(/^[\s\S]*?<\/think>/i, '');          // 未闭合的思考块残尾
  s = s.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '');
  s = s.replace(/^(好的|当然|以下是|这是)[^\n]{0,24}[:：]\s*/, '');
  s = s.replace(/^[\s"'“”『』「」]+/, '').replace(/[\s"'“”『』「」]+$/, '');
  s = s.split(/\r?\n/).map(x => x.trim()).filter(Boolean).join('\n');
  return s.trim();
}

/**
 * 反推一张图的提示词。
 * @param {string} file 图片绝对路径
 * @param {{ providerOverride?: string }} [opts]
 * @returns {Promise<{ text: string, ms: number }>}
 */
async function reversePrompt(file, opts = {}) {
  const abs = String(file || '');
  if (!abs || !fs.existsSync(abs)) throw new Error('找不到参考图文件：' + abs);
  let st = null;
  try { st = fs.statSync(abs); } catch (_) {}
  if (!st || !st.size) throw new Error('参考图无法读取或为空：' + abs);
  if (st.size > 24 * 1024 * 1024) {
    throw new Error('参考图太大（' + (st.size / 1048576).toFixed(1) + 'MB），请先压缩到 24MB 以内再反推');
  }

  const mime = IMG_MIME[path.extname(abs).toLowerCase()] || 'image/png';
  const b64 = fs.readFileSync(abs).toString('base64');
  const messages = [
    { role: 'system', content: REVERSE_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请反推这张图片的生成提示词。' },
        { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } }
      ]
    }
  ];

  const t0 = Date.now();
  const raw = await llmChat(messages, {
    stage: 'reverse',
    providerOverride: opts.providerOverride || '',
    temperature: 0.3,
    maxTokens: 640,
    timeoutMs: 600000
  });
  const text = cleanPromptText(raw);
  if (!text) throw new Error('模型没有返回可用的提示词内容');
  return { text, ms: Date.now() - t0 };
}

/**
 * 括号配平扫描：从 i0（必须指向 `{` 或 `[`）开始，返回与之匹配的闭合下标；扫到结尾仍未闭合返回 -1。
 * 🔴 必须字符串感知 —— 台词里常有 `}` `]` 与 `\"`，纯数括号会把范围切错。
 */
function matchBracket(s, i0) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = i0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { depth++; continue; }
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 扫描 start 之后的全部顶层 JSON 值（值之间允许夹杂说明文字 / 逗号 / 换行） */
function scanJsonValues(raw, start) {
  const parts = [];
  let truncated = false;
  let i = start;
  while (i < raw.length) {
    if (raw[i] !== '{' && raw[i] !== '[') { i++; continue; }
    const end = matchBracket(raw, i);
    if (end < 0) { truncated = true; break; }   // 最后一段没闭合 = 输出被截断
    parts.push(raw.slice(i, end + 1));
    i = end + 1;
  }
  return { parts, truncated };
}

/** 多段 JSON 合并：对象按键合并（数组拼接、标量以先出现的为准），纯数组直接拼接 */
function mergeJsonValues(vals) {
  const objs = vals.filter(v => v && typeof v === 'object' && !Array.isArray(v));
  const arrs = vals.filter(Array.isArray);
  if (!objs.length) return arrs.length === 1 ? arrs[0] : [].concat(...arrs);
  const out = {};
  for (const o of objs) {
    for (const k of Object.keys(o)) {
      const cur = out[k];
      const next = o[k];
      if (cur === undefined) { out[k] = next; continue; }
      if (Array.isArray(cur) && Array.isArray(next)) { out[k] = cur.concat(next); continue; }
      // 同名标量 / 对象冲突：保留**先出现**的那份（前半段是主结构，后半段多为重复输出）
    }
  }
  // 独立的裸数组（模型把某一类数据另起一段输出）+ 对象里没有任何数组 → 挂到 data，pickArray 认得这个键
  if (arrs.length && !Object.keys(out).some(k => Array.isArray(out[k]))) {
    out.data = arrs.length === 1 ? arrs[0] : [].concat(...arrs);
  }
  return out;
}

/**
 * 提取 JSON（容忍 ```json 围栏、前后杂文本、以及「吐完一个 JSON 又续写一段」）。
 * 🔴 2026-10-19 修：旧实现用 `lastIndexOf('}')` 切片，只要 JSON 后面还有别的 `}`（重复输出、
 *    第二段对象、解释里的示例），就会把第二段一起包进来，报
 *    `Unexpected non-whitespace character after JSON at position N`。
 *    现在改成**括号配平**逐段扫描：先试整段，失败再取所有完整顶层值并合并。
 */
function extractJson(text) {
  const src = String(text == null ? '' : text);
  const m = src.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = m ? m[1] : src;
  const start = raw.search(/[[{]/);
  if (start < 0) throw new Error('LLM 输出中未找到 JSON');

  // ① 最快路径：整段就是一个 JSON（绝大多数情况）
  try { return JSON.parse(raw.slice(start)); } catch (_) {}

  // ② 逐段扫描：模型有时「输出完整 JSON 后再续写一段」，或把 shots / characters 分成两个对象发
  const { parts, truncated } = scanJsonValues(raw, start);
  const vals = [];
  let lastErr = null;
  for (const p of parts) {
    try { vals.push(JSON.parse(p)); } catch (e) { lastErr = e; }
  }
  if (vals.length) return vals.length === 1 ? vals[0] : mergeJsonValues(vals);
  if (truncated) {
    throw new Error('LLM 输出的 JSON 在结尾处不完整（多半被 max_tokens 截断，已生成 ' +
      src.length + ' 字）：请调大输出上限，或把剧本拆成多集后重试。');
  }
  throw new Error('LLM 输出不是合法 JSON：' + ((lastErr && lastErr.message) || '解析失败'));
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

/** 生成入口 → 模型方案用途：生图（角色 / 场景）走 image，视频走 video，成片超分走 upscale */
const TEMPLATE_KIND = { character: 'image', video: 'video', upscale: 'upscale' };

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

  // —— 图片模板升级：上面「存在即跳过」是为了不覆盖用户手改，但内置模板自己修 bug 时
  //    老工作区就永远拿不到新版 —— 于是补一张「老版指纹表」：命中指纹才替换（精确匹配旧写法，
  //    用户正常手改不会命中），替换前留 .bak 兜底。
  //    2026-10-17 两条都是用户能直接感觉到的毛病：
  //      character_edit：latent 直连 TextEncodeQwenImage21 → 输出尺寸跟参考图比例走，所选分辨率无效
  //      character_qwen_image：steps/cfg/sampler 写死 → 页面上的采样方案下拉框点了没反应
  const LEGACY_TPL = {
    'character_edit.json': ['"latent_image": ["56", 2]'],
    'character_qwen_image.json': ['"steps": 25, "cfg": 2.5, "sampler_name": "euler"']
  };
  for (const [name, marks] of Object.entries(LEGACY_TPL)) {
    const src = path.join(builtin, name);
    const dst = path.join(dir, name);
    if (!fs.existsSync(src) || !fs.existsSync(dst)) continue;
    let cur = '';
    try { cur = fs.readFileSync(dst, 'utf-8'); } catch (_) { continue; }
    if (!marks.some(m => cur.includes(m))) continue;
    try {
      fs.copyFileSync(dst, dst + '.bak');
      fs.copyFileSync(src, dst);
      logger.info('工作流模板已升级：workflows/' + name + '（旧版备份为 ' + name + '.bak）');
    } catch (_) { /* 忽略 */ }
  }

  // —— H3 视频：2026-09 起改为 __H3_UNET__ + 运行时注入「首/尾帧、参考图、参考视频」——
  // 老内置模板用的是 __H3_FL2VA__ / __H3_TURBO_LORA__ 写法，遇到就自动换成新版。
  // 2026-10-18 起内置模板多了「放大二采」段（质量最优档用），老模板（没有 __SEED2__）同样自动升级。
  const bv = path.join(__dirname, 'workflows', 'video_h3.json');
  const tv = path.join(dir, 'video_h3.json');
  let needVideo = !fs.existsSync(tv);
  if (!needVideo) {
    try {
      const cur = fs.readFileSync(tv, 'utf-8');
      if (cur.includes('__H3_FL2VA__') || cur.includes('__H3_TURBO_LORA__') || !cur.includes('__SEED2__')) needVideo = true;
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

/* ---------------- 放大二采（quality 档的「先小后大」策略） ---------------- */

/**
 * 解析本档的二采声明（方案 wiring.twoPass + tiers 里该档的 twoPass:true）。
 * 不启用 → null（生成链路与前二采时代完全一致）。
 *
 * 🔴 参数全部来自方案，代码不认任何模型名 / 分辨率 / σ 数值：
 *    · steps  —— 第二遍步数（必须与第二遍挂的蒸馏 LoRA 训练步数一致）
 *    · lora   —— 第二遍 LoRA 文件名正则（第一遍仍用档位自己的 LoRA）
 *    · shift  —— 第二遍 σ-shift；null = 不注入
 *    · sigmas —— 第二遍 σ 序列（起点决定「保留多少第一遍内容」，越低越像原片）
 *    · canvas —— 第二遍画布（比例 → 宽x高）
 *
 * 为什么要有二采：整段直接上大画布要 20 步 + 大 latent，单镜十几分钟；
 * 「小画布 4 步出构图 → 放大 latent → 8 步补细节」实测画质基本持平、耗时省四成
 * （2026-10-18 真镜消融：S 组 838s vs R 组 1017s）。
 */
function twoPassOf(vidP, tierRes, loraFiles, aspect) {
  const T = (vidP && vidP.wiring && vidP.wiring.twoPass) || null;
  if (!T || T.enabled === false) return null;
  if (!tierRes || !tierRes.twoPass) return null;
  // 🔴 tierRes.twoPass 可以是「对象」覆盖 wiring.twoPass 的字段（lora/loraKind/steps/shift/sigmas/canvas），
  //    让「同档位不同候选走不同第二遍」成为可能 —— 例如 hq-A 第二遍普通 ref2v 8step、hq-B 第二遍 PDD。
  //    布尔 true 则沿用 wiring.twoPass 的全局默认（历史行为不变）。
  const ov = (tierRes.twoPass && typeof tierRes.twoPass === 'object') ? tierRes.twoPass : {};
  const loraRe = ov.lora != null ? ov.lora : T.lora;
  const files = Array.isArray(loraFiles) ? loraFiles : [];
  const re = loraRe ? safeRegex(loraRe) : null;
  const hit = re ? files.find(f => re.test(String(f).split(/[\\/]/).pop())) : null;
  // 第二遍的 LoRA 没装 → 这一档退化成「照常出一版」，绝不拿 4 步蒸馏硬跑 8 步（那样画面会崩）
  if (!hit) return null;
  const canvas = (ov.canvas != null ? ov.canvas : T.canvas) || {};
  const want = String(canvas[aspect] || canvas['16:9'] || '').trim();
  const m = /^(\d+)x(\d+)$/.exec(want);
  if (!m) return null;
  const sigmas = String(ov.sigmas != null ? ov.sigmas : T.sigmas || '').trim();
  if (!sigmas) return null;
  const loraKindSrc = ov.loraKind != null ? ov.loraKind : T.loraKind;
  const shiftSrc = ov.shift != null ? ov.shift : T.shift;
  const isPddKind = String(loraKindSrc || '').toLowerCase() === 'pdd';
  return {
    steps: Number(ov.steps != null ? ov.steps : T.steps) || 8,
    lora: hit,
    // 'pdd' = 第二遍用 MiniMaxH3PDDLoRA 节点（内部出 σ + sigmas）；否则普通 LoraLoaderModelOnly
    loraKind: isPddKind ? 'pdd' : null,
    // PDD 内部处理 σ-shift，第二遍不注入 MiniMaxH3SigmaShift（与第一遍 PDD 装配口径一致）
    shift: isPddKind ? null : (Array.isArray(shiftSrc) && shiftSrc.length === 2 ? shiftSrc.slice() : null),
    sigmas,
    width: Number(m[1]),
    height: Number(m[2]),
    seedOffset: Number.isFinite(Number(ov.noiseSeedOffset != null ? ov.noiseSeedOffset : T.noiseSeedOffset)) ? Number(ov.noiseSeedOffset != null ? ov.noiseSeedOffset : T.noiseSeedOffset) : 1,
    nodes: (ov.nodes != null ? ov.nodes : T.nodes) || {}
  };
}

/** 安全编译正则（方案里的正则写错了不能让整个生成挂掉） */
function safeRegex(src) {
  try { return new RegExp(src, 'i'); } catch (_) { return null; }
}

/** 分辨率字符串 → [w, h]；解析不出来返回 null */
function parseResStr(s) {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * 二采的第一遍画布：按第二遍画布的 ≈50% 像素量，保持比例，并向上对齐方案的帧网格粒度。
 *
 * 为什么第一遍不直接上大画布：
 *   · 第一遍挂的是 4 步蒸馏 LoRA（544p 训练）—— 它在小画布上最稳、最省时；
 *   · 构图本来就该在第一遍定下来，第二遍只补细节，所以第一遍不需要大画布；
 *   · 实测 4 步 864×480 ≈2.5 分钟，直接 1344×768 要十几分钟。
 * 对齐粒度取方案 frames.snap（H3 是 32）：H3 画布必须能被 32 整除。
 */
function firstPassCanvas(cur, tp) {
  const sx = Number(tp && tp.width) || 1344;
  const sy = Number(tp && tp.height) || 768;
  const snap = 32;
  const up = v => Math.max(snap, Math.round(v / snap) * snap);
  // 一半**像素量**（不是一半边长 —— 边长砍半 = 像素只剩 25%，第一遍的构图信息会不够用）
  const k = Math.sqrt(0.5);
  const w = up(sx * k);
  const h = up(sy * k);
  // 已经比第一遍还小的画布（用户手选了更小尺寸）就别再缩了
  if (cur && cur[0] * cur[1] <= w * h) return cur;
  return [w, h];
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

/**
 * 摘掉模板里的「放大二采」段，并把输出接回第一遍。
 *
 * 为什么要主动摘（而不是让 ComfyUI 自己判定）：
 *   SaveVideo ← CreateVideo ← VAEDecode(22)。只要 22 的输入还指向二采采样器，
 *   ComfyUI 就会把整条二采链（含第二遍 8 步全画布采样）跑完 —— 快 / 平衡两档会被
 *   悄悄变成最慢的那一档，耗时翻倍且用户毫不知情。
 *
 * 只删「本方案声明的二采节点」，模板里没声明过（老模板）就什么都不做。
 */
function dropTwoPass(wf, profile) {
  const T = (profile && profile.wiring && profile.wiring.twoPass) || null;
  if (!T || !T.nodes) return;
  const id = T.nodes;
  for (const k of ['noise', 'splitAv', 'decode', 'scale', 'encode', 'concatAv',
    'conditioning', 'lora', 'shift', 'guider', 'sigmas', 'sampler']) {
    if (id[k] && wf[id[k]]) delete wf[id[k]];
  }
  // 5xx 段是二采装配时按需生成的「参考图重缩放」节点
  for (const k of Object.keys(wf)) {
    if (/^5\d{2}$/.test(k)) delete wf[k];
  }
  // 输出接回第一遍（第一遍采样器由方案 nodes.samplerAdv 声明）
  const n1 = (profile && profile.nodes) || {};
  if (n1.samplerAdv && wf[n1.decodeVideo]) wf[n1.decodeVideo].inputs.samples = [n1.samplerAdv, 0];
  if (n1.samplerAdv && wf[n1.decodeAudio]) wf[n1.decodeAudio].inputs.samples = [n1.samplerAdv, 0];
}

/* ---------------- 放大二采：第二遍采样段装配 ---------------- */

/**
 * 在第一遍采样结果之后接一段「放大 → 再采」，并让输出改读第二遍。
 *
 * 数据流（H3 的 latent 是「视频 + 音频」拼在一起的 AV 格式，不能只拿半边去放大）：
 *   21(第一遍) → LTXVSeparateAVLatent ─┬─ 视频半边 → VAEDecode → ImageScale(大画布) → VAEEncode ─┐
 *                                      └─ 音频半边 ─────────────────────────────────────────────┤
 *                                              LTXVConcatAVLatent(视频=放大后, 音频=第一遍原样) ←──┘
 *   → 第二遍条件节点（大画布，媒体与第一遍同一套）
 *   → 第二遍 LoRA（768p 训练的 8 步蒸馏）+ σ-shift
 *   → ManualSigmas（σ 序列，起点决定保留多少第一遍内容）
 *   → SamplerCustomAdvanced → 22/VAEDecode 改读它
 *
 * 🔴 音频必须钉回第一遍：第二遍只对画面做细节补充，音频再采一次会让音色/口型轻微漂移
 *    （2026-10-18 实测：接第二遍后音轨 MD5 变化、局部 RMS 差 5dB）。所以 23/VAEDecodeAudio
 *    的输入在模板里就写死指向第一遍（21），这里也主动再钉一次。
 *
 * @param {object} wf        工作流图（已注入媒体）
 * @param {object} tp        twoPassOf() 的结果
 * @param {object} ctx       { inj, profile, params, seed }
 */
function applyTwoPass(wf, tp, ctx) {
  const { inj, profile, params, seed } = ctx || {};
  const N = (profile && profile.nodes) || {};
  const C = (profile && profile.classes) || {};
  const id = tp.nodes || {};
  const n1 = {
    sampler: N.samplerAdv, decodeVideo: N.decodeVideo, decodeAudio: N.decodeAudio,
    videoVae: N.videoVae, textEncoder: N.textEncoder, cond: N.conditioning
  };
  for (const k of Object.keys(id)) {
    if (!wf[id[k]]) logger.warn('二采节点缺失（方案声明 ' + id[k] + ' / ' + k + '），这一段跳过');
  }
  const W = tp.width, H = tp.height;

  // ① 拆 AV → 只放大视频半边 → 拼回（音频半边原样保留）
  wf[id.splitAv] = { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: [n1.sampler, 0] } };
  wf[id.decode] = { class_type: 'VAEDecode', inputs: { samples: [id.splitAv, 0], vae: [n1.videoVae, 0] } };
  wf[id.scale] = {
    class_type: 'ImageScale',
    inputs: {
      image: [id.decode, 0], upscale_method: 'lanczos',
      width: W, height: H, crop: 'center'
    }
  };
  wf[id.encode] = { class_type: 'VAEEncode', inputs: { pixels: [id.scale, 0], vae: [n1.videoVae, 0] } };
  wf[id.concatAv] = {
    class_type: 'LTXVConcatAVLatent',
    inputs: { video_latent: [id.encode, 0], audio_latent: [id.splitAv, 1] }
  };

  // ② 第二遍的条件节点：画布换成大画布，其余输入（clip / vae / prompt / 参考媒体）沿用第一遍。
  //    🔴 参考图也得按大画布重缩一遍 —— 参考图喂进模型前是「画布尺寸」的，沿用第一遍的小图会让
  //       第二遍按小图理解主体比例（实测：直接复用会让人物在画面里变小）。
  const cond = wf[inj.condId];
  if (!cond || !cond.inputs) throw new Error('二采：找不到第一遍的条件节点 ' + inj.condId);
  const ins2 = JSON.parse(JSON.stringify(cond.inputs));
  ins2.width = W;
  ins2.height = H;
  if (ins2.clip) ins2.clip = [n1.textEncoder, 0];
  if (ins2.vae) ins2.vae = [n1.videoVae, 0];
  // 参考图 / 首尾帧的 ImageScale：按大画布重缩（节点 id 从原有 scale 节点派生，各自独立）
  const rescale = {};
  const walk = (v, keyPath) => {
    if (!Array.isArray(v) || v.length !== 2) return v;
    const srcId = String(v[0]);
    const src = wf[srcId];
    if (!src) return v;
    // 只处理「某张图的缩放节点」：它的入参是一个 LoadImage
    const imgRef = src.class_type === 'ImageScale' && Array.isArray(src.inputs.image) ? String(src.inputs.image[0]) : null;
    if (!imgRef || !wf[imgRef]) return v;
    if (rescale[srcId]) return [rescale[srcId], 0];
    // 5xx 段：二采专用的参考图缩放节点。避开模板（10-41）、媒体注入段（90/200-259）、
    // 多图注入段（990+），以及图片 i2i 的 30 —— 互不覆盖。
    const nid = String(500 + Object.keys(rescale).length);
    wf[nid] = {
      class_type: 'ImageScale',
      inputs: {
        image: [imgRef, 0], upscale_method: src.inputs.upscale_method || 'lanczos',
        width: W, height: H, crop: src.inputs.crop || 'center'
      }
    };
    rescale[srcId] = nid;
    return [nid, 0];
  };
  for (const k of Object.keys(ins2)) {
    if (/^ref_(images|videos)\./.test(k) || k === 'first_frame' || k === 'last_frame' || k === 'image') {
      ins2[k] = walk(ins2[k], k);
    }
  }
  wf[id.conditioning] = { class_type: cond.class_type, inputs: ins2 };

  // ③ 第二遍模型：同底模 + 第二遍 LoRA（+ 可选的 σ-shift）。
  //    🔴 PDD 二采：第二遍 LoRA 是 PDD 时走 MiniMaxH3PDDLoRA 节点（内部处理 σ-shift + 输出 sigmas），
  //       不能走 LoraLoaderModelOnly（会静默丢掉 32 输出头库）。sigmas 改接 PDD 输出 [lora,1]。
  const isPdd = tp.loraKind === 'pdd';
  let pddSigmas = null;
  if (isPdd) {
    wf[id.lora] = {
      class_type: 'MiniMaxH3PDDLoRA',
      inputs: { model: [N.model, 0], lora_name: tp.lora, strength: 1.0, steps: Number(tp.steps) || 8 }
    };
    pddSigmas = [id.lora, 1];
    // PDD 内部已处理 σ-shift，不再注入 MiniMaxH3SigmaShift 节点
    if (wf[id.shift]) delete wf[id.shift];
  } else {
    wf[id.lora] = { class_type: 'LoraLoaderModelOnly', inputs: { model: [N.model, 0], lora_name: tp.lora, strength_model: 1 } };
    if (tp.shift) {
      wf[id.shift] = {
        class_type: (C.shift || 'MiniMaxH3SigmaShift'),
        inputs: { model: [id.lora, 0], shift_video: tp.shift[0], shift_audio: tp.shift[1] }
      };
    } else if (wf[id.shift]) {
      delete wf[id.shift];
    }
  }
  let modelRef = (tp.shift && !isPdd && wf[id.shift]) ? id.shift : id.lora;

  // ④ 引导器 / σ 序列 / 噪声 / 采样器
  // 🔴 引导器必须接「第一遍真正的最终 conditioning」（inj.condId 可能是 AddGuide 链尾，
  //    而不是基础条件节点）—— 接错就等于第二遍丢掉了首尾帧锚点。
  const g0 = wf[N.guider];
  const condRef = (g0 && Array.isArray(g0.inputs && g0.inputs.conditioning))
    ? g0.inputs.conditioning.slice() : [inj.condId, 0];
  // 🔴 第二遍加速（二采两遍都加加速 · 2026-10-21 用户拍板）：第二遍 guider 的 model 也串
  //    INT8 注意力 + BlockCache。节点编号用 72x 段（第一遍用 710/711，第二遍用 720/721，互不覆盖）。
  const accelCfg = (profile && profile.wiring && profile.wiring.attentionBoost) || null;
  if (params && params._accelOn && accelCfg && accelCfg.enabled !== false) {
    if (accelCfg.attention && accelCfg.attention.class) {
      wf['720'] = { class_type: accelCfg.attention.class, inputs: { model: [modelRef, 0], attention: accelCfg.attention.backend || 'comfy kitchen attention' } };
      modelRef = '720';
    }
    if (accelCfg.blockCache && accelCfg.blockCache.class) {
      wf['721'] = { class_type: accelCfg.blockCache.class, inputs: { model: [modelRef, 0], residual_diff_threshold: 0.12, start_percent: 0.08, end_percent: 0.95, max_consecutive_hits: 2, cache_device: 'cpu', metric_stride: 8, verbose: false } };
      modelRef = '721';
    }
  }
  wf[id.guider] = { class_type: 'BasicGuider', inputs: { model: [modelRef, 0], conditioning: condRef } };
  // 第一遍如果声明了 condTargets（引导器被外部改写），这里也照搬那份接线
  for (const t of (Array.isArray(profile.wiring && profile.wiring.condTargets) ? profile.wiring.condTargets : [])) {
    if (t.node !== N.guider) continue;
    const n = wf[id.guider];
    if (n && n.inputs) n.inputs[t.key] = condRef;
  }
  wf[id.noise] = { class_type: 'RandomNoise', inputs: { noise_seed: Number(seed) >>> 0 } };
  // PDD 二采：sigmas 直接取 PDD 节点输出（训练定死网格），不用 ManualSigmas；
  // 普通二采：ManualSigmas 走方案声明的 σ 序列。
  if (!pddSigmas) wf[id.sigmas] = { class_type: 'ManualSigmas', inputs: { sigmas: tp.sigmas } };
  wf[id.sampler] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: [id.noise, 0], guider: [id.guider, 0],
      sampler: [N.sampler, 0], sigmas: pddSigmas || [id.sigmas, 0],
      latent_image: [id.concatAv, 0]
    }
  };

  // ⑤ 输出改读第二遍；音频钉回第一遍
  if (wf[n1.decodeVideo]) wf[n1.decodeVideo].inputs.samples = [id.sampler, 0];
  if (wf[n1.decodeAudio]) wf[n1.decodeAudio].inputs.samples = [n1.sampler, 0];

  return { condId: id.conditioning, samplerId: id.sampler, width: W, height: H };
}


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

/** 产物旁车文件：<图片名>.json（目前只记生成耗时，供历史列表回显）。
 *  历史扫描只认图片扩展名，旁车不会混进列表；写失败也只是少一条时长，不能影响出片。 */
function writeSidecar(dir, name, meta) {
  try { fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(meta)); }
  catch (e) { try { logger.warn('写产物元数据失败（不影响出片）：' + ((e && e.message) || e)); } catch (_) {} }
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
    // 🔴 档位声明了 unet 正则（tiers.spec.unet）时，优先用它从该槽位的文件清单里挑基模 ——
    //    用于「同目录并存剪枝版 / 原始版」时按档位配对（速度优先 A 用剪枝版，B 用原始版）。
    const unetSlot = refMode
      ? (A.byRole.unetRef && A.byRole.unetRef.name ? A.byRole.unetRef : A.byRole.unet)
      : A.byRole.unet;
    let h3Unet = unetSlot && unetSlot.name;
    if (tierRes.unet && unetSlot && Array.isArray(unetSlot.files) && unetSlot.files.length) {
      const unetRe = (() => { try { return new RegExp(tierRes.unet, 'i'); } catch (_) { return null; } })();
      if (unetRe) {
        const hit = unetSlot.files.find(f => unetRe.test(String(f).split(/[\\/]/).pop()));
        if (hit) h3Unet = hit;
      }
    }
    p.h3_unet = h3Unet;
    p.h3_lora = tierRes.lora;                       // null = 基础模型直跑（摘 LoRA 节点）
    p.h3_loraKind = tierRes.loraKind || null;       // 'pdd' = PDD 节点加载（否则普通 LoraLoaderModelOnly）
    p.steps = p.stepsOverride || tierRes.steps;     // h3.steps 仅作高级手动覆盖
    p.h3_shift = tierRes.shift;                     // [v,a] 需注入 σ-shift 节点；null 不注入
    // 采样器：蒸馏 LoRA（4step/8step turbo/PDD）训练采样器是 euler，用模板默认 res_multistep 会残影
    // （2026-10-21 实测：同一份剪枝版+4step+480p，euler 干净 / res_multistep 拖影）。
    // 档位声明了 sampler 就透传改写 KSamplerSelect；没声明（20 步基础模型直跑）= null，沿用模板默认。
    p.h3_sampler = tierRes.sampler || null;
    // 采样序列：蒸馏模型（LTX-2.5）的 sigma 网格是训练时定死的，由档位直接给字符串
    // （ManualSigmas 节点）。走 LoRA 步数派的模型（H3）不声明，模板里也没有这个占位符。
    p.sigmas = tierRes.sigmas || (vidP && vidP.params && vidP.params.sigmas) || null;
    p.tierLabel = videoTiers.labelOf(vidP)[tierRes.tier] || tierRes.tier;
    // conditioning / latent 的连接目标；注入媒体支路后会由 injectMedia 改写
    p.cond_id = vidN.conditioning || '16';
    p.latent_id = p.cond_id;

    // —— 放大二采（本档声明才启用）——
    // 比例优先用调用方传的 aspect；没传就从本次画布推断（宽>高 = 横版）。
    const aspect = String(params.aspect || '').trim() ||
      ((Number(p.width) || 0) > (Number(p.height) || 0) ? '16:9' : '9:16');
    const tp = twoPassOf(vidP, tierRes, loraFiles, aspect);
    p.twoPass = tp;
    // 第二遍的噪声种子必须与第一遍不同：同种子 + 同一段 σ 会让第二遍形同「重放一遍」
    p.seed2 = ((Number(p.seed) || 0) + (tp ? tp.seedOffset : 0)) >>> 0;
    // 🔴 模板里的二采占位符是**常驻**的（同一份模板服务三档），不启用时也必须填上
    //    语法合法的中性值 —— 否则 applyParams 会跳过它们，JSON 解析直接失败。
    //    中性值之后由 dropTwoPass() 连节点一起摘掉，不会进 ComfyUI。
    const TP0 = (vidP && vidP.wiring && vidP.wiring.twoPass) || {};
    const tpId = TP0.nodes || {};
    p.twopass_w = tp ? tp.width : 0;
    p.twopass_h = tp ? tp.height : 0;
    p.twopass_lora = tp ? tp.lora : 'none';
    p.twopass_steps = tp ? tp.steps : 1;
    p.twopass_sigmas = tp ? tp.sigmas : '1, 0';
    p.twopass_shift_v = (tp && tp.shift) ? tp.shift[0] : 0;
    p.twopass_shift_a = (tp && tp.shift) ? tp.shift[1] : 0;
    // 输出解码读哪一路 / 二采条件与 latent 接哪
    p.out_latent = tp ? String(tpId.sampler || '21') : String(vidN.samplerAdv || '21');
    p.cond2_id = p.cond_id;
    p.latent2_id = p.cond_id;
    if (tp) {
      // 画布：第一遍按「第二遍画布的 ≈50% 像素」出构图（4 步蒸馏够用），第二遍放大补细节。
      // 🔴 第一遍 LoRA 是 544p 训练的，小画布不漂；第二遍换 768p 训练的 LoRA + 768p 画布。
      const cur = parseResStr(`${p.width}x${p.height}`);
      const small = firstPassCanvas(cur, tp);
      p.width = small[0];
      p.height = small[1];
    }
    realParams = { ...p, ...params };
    // 🔴 画布必须以「算出来的第一遍画布」为准，不能被调用方透传的 params.width 覆盖。
    //    调用方传的是「成片画布」（渲染层按档位推荐值传），而二采的第一遍必须用半像素画布 ——
    //    被覆盖的后果是「第一遍就跑 1344×768、第二遍放大等于空转」：耗时翻倍还看不出差别
    //    （2026-10-18 实测踩到：提交给 ComfyUI 的 16 号节点 width=1344）。
    if (realParams.twoPass) {
      realParams.width = p.width;
      realParams.height = p.height;
    }
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
    // 采样参数：图片模板（qwen_image / character_edit）的 KSampler 已改占位符，这里给 2.1 推荐默认 ——
    // 调用方（图片生成页）可覆盖；其它调用方（角色卡/场景卡）不传 = 原固定值 25 / 2.5 / euler / simple，行为不变
    realParams.steps = Number(params.steps) > 0 ? Math.round(params.steps) : 25;
    realParams.cfg = Number(params.cfg) > 0 ? Number(params.cfg) : 2.5;
    realParams.sampler = params.sampler || 'euler';
    realParams.scheduler = params.scheduler || 'simple';
    // 编辑通道（character_edit）的输出宽高：官方 TextEncodeQwenImage21 自带的 latent 输出
    // 尺寸跟参考图比例走、不理会所选分辨率（2026-10-17 实测 480×864 参考图出 768×1376）——
    // 模板已改接 EmptyQwenImage21LatentImage（__EW__/__EH__）。没传 ew/eh 的既有调用方
    // （角色卡换装/三视图等，只传 resolution）退回正方形 = 与改造前行为一致。
    realParams.ew = Number(params.ew) > 0 ? Math.round(params.ew) : (Number(realParams.resolution) > 0 ? Math.round(realParams.resolution) : 1024);
    realParams.eh = Number(params.eh) > 0 ? Math.round(params.eh) : (Number(realParams.resolution) > 0 ? Math.round(realParams.resolution) : 1024);
  }
  // 多图参考（Qwen-Image 2.1 原生编辑官方支持多图）：params.images = [abs path, ...]。
  // 第 1 张走既有 image 槽（驱动编辑/图生图支路），第 2..N 张上传后出图前动态注入 LoadImage。
  const refAbsList = Array.isArray(params.images) ? params.images.filter(Boolean) : [];
  if (refAbsList.length && !params.image) realParams.image = await uploadToComfy(refAbsList[0]);
  if (params.image) realParams.image = await uploadToComfy(params.image);
  if (refAbsList.length) {
    const skip = params.image ? 0 : 1;   // image 槽已吃掉第 1 张时其余才是「额外图」
    const extraNames = [];
    for (const p of refAbsList.slice(skip)) extraNames.push(await uploadToComfy(p));
    if (extraNames.length) realParams._extraImgs = extraNames;
  }
  if (realParams.seed === undefined || realParams.seed === null) realParams.seed = Math.floor(Math.random() * 1e9);

  const filled = applyParams(tplText, realParams);
  const optionalPH = optionalPlaceholders();
  const left = findPlaceholders(filled).filter(x => !optionalPH.has(x));
  if (left.length) {
    // 🔴 2026-10-16：空提示词会掉进这里 —— `applyParams` 对空串是 `continue`（跳过替换），模板里的
    //    `"__PROMPT__"` 就留下来被当成「模型缺失」报出去，用户会被引到「模型管家」白找一圈。
    //    （渲染层 `genReady` 已就地拦住这条路；这里是主进程侧的兜底文案，脚本/别处调用也能看懂。）
    if (left.includes('__PROMPT__')) {
      throw new Error('提示词为空：这张卡还没有生成提示词 —— 先按角色档案生成提示词（卡片刷新按钮 / 批量生成提示词）再出图。'
        + '（工作流模板里的 __PROMPT__ 占位符没被替换，与模型配置无关）');
    }
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

  // 视频模板里的「放大二采」段是常驻的（同一份模板要服务三档），本档不用时必须整段摘掉。
  // 🔴 否则 SaveVideo 会顺着 22 号解码节点一路把二采链路拉活：第二遍白跑一遍、耗时翻倍。
  //    判据是「模板里有没有 __SEED2__」—— 老模板（二采诞生前）不需要这一步。
  if (isVideo && !realParams.twoPass) dropTwoPass(wf, vidP);
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

  // 多图注入：找到 2.1 原生编辑节点（TextEncodeQwenImage21），把第 2..N 张参考图接上
  // images.image_2..N（官方多图上限 10，页面已限）。模板没有该节点（非 2.1 方案）就降级只发首图。
  if (Array.isArray(realParams._extraImgs) && realParams._extraImgs.length) {
    const encId = Object.keys(wf).find(k => wf[k] && wf[k].class_type === 'TextEncodeQwenImage21');
    if (encId) {
      realParams._extraImgs.forEach((nm, i) => {
        const id = '9' + String(90 + i);   // 注入段独立编号，不会撞模板节点 id
        wf[id] = { class_type: 'LoadImage', inputs: { image: nm } };
        wf[encId].inputs['images.image_' + (i + 2)] = [id, 0];
      });
    } else {
      logger.warn('当前生图方案没有 TextEncodeQwenImage21 节点，多图参考只使用了第 1 张');
    }
  }

  if (isVideo) {
    const Wg = (vidP && vidP.wiring) || {};
    const nModel = vidN.model, nLora = vidN.lora, nShift = vidN.shift;
    const condOut = Wg.condOutput !== undefined ? Wg.condOutput : 0;
    const latentOut = Wg.latentOutput !== undefined ? Wg.latentOutput : 1;

    // 采样器：蒸馏 LoRA（4step/8step turbo/PDD）训练采样器是 euler，模板默认 res_multistep 会残影/拖影
    // （2026-10-21 实测：同一份剪枝版+4step+480p，euler 干净、res_multistep 拖影）。
    // 档位声明了 sampler → 改写 KSamplerSelect 的 sampler_name；没声明（20 步基础模型）= 沿用模板默认。
    if (vidN.sampler && wf[vidN.sampler] && realParams.h3_sampler) {
      wf[vidN.sampler].inputs.sampler_name = realParams.h3_sampler;
    }

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

    // PDD 加载（速度优先 B：原始版 + 阿里 PDD 8 步 LoRA）：
    // 🔴 PDD 不是普通 LoRA —— 必须 MiniMaxH3PDDLoRA 节点（内部处理 σ-shift + 输出 sigmas），
    //    普通 LoraLoaderModelOnly 会静默丢掉 32 输出头库。装配时把 LoRA 节点改写成本节点，
    //    并把 sampler 的 sigmas 从 BasicScheduler 改接到 PDD 节点输出（PDD 的 sigmas 是训练定死的网格）。
    if (realParams.h3_lora && realParams.h3_loraKind === 'pdd' && wf[nLora]) {
      wf[nLora] = {
        class_type: 'MiniMaxH3PDDLoRA',
        inputs: { model: [nModel, 0], lora_name: realParams.h3_lora, strength: 1.0, steps: Number(realParams.steps) || 8 }
      };
      // sampler 的 sigmas 改接 PDD 节点输出（[nLora, 1]）；scheduler 不再参与，直接摘掉
      const nSampler = vidN.samplerAdv;
      if (nSampler && wf[nSampler] && Array.isArray(wf[nSampler].inputs.sigmas)) {
        wf[nSampler].inputs.sigmas = [nLora, 1];
      }
      if (vidN.scheduler && wf[vidN.scheduler]) delete wf[vidN.scheduler];
      // guider 的 model 直连 PDD 节点（PDD 自己输出 model，不走 σ-shift）
      if (wf[vidN.guider] && Array.isArray(wf[vidN.guider].inputs.model)) {
        wf[vidN.guider].inputs.model = [nLora, 0];
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

    // 加速优化开关（全局）：INT8 注意力 + BlockCache T8。
    // 🔴 开关是全局设置（wiring.attentionBoost.settingKey），与档位正交 —— 用户不管选哪个档位
    //    都能一键开关。开时在「最终模型 → Guider」之间串入两个 model patch 节点；
    //    关（或值为 '0'）则什么都不插，画面回到纯 pytorch 注意力的基线。
    // 🔴 INT8 注意力会改变采样轨迹（画面有轻微差异、无硬伤），BlockCache 在 8 步以上才有净收益；
    //    两者叠加在 PDD 档位下也实测可跑（A3 实验 151s 无硬伤）。节点编号用 7xx 段，避开模板/媒体/二采。
    const accel = (Wg.attentionBoost) || null;
    const accelOn = !!(accel && accel.enabled !== false &&
      String(db.getSetting(accel.settingKey || 'h3.attentionBoost') || '').trim() !== '0');
    // 记录加速开关状态，供二采第二遍复用（第二遍 guider 也要串同样的 710/711）
    realParams._accelOn = accelOn;
    if (accelOn && wf[vidN.guider] && Array.isArray(wf[vidN.guider].inputs.model)) {
      let modelRef = wf[vidN.guider].inputs.model;
      if (accel.attention && accel.attention.class) {
        const aid = '710';
        wf[aid] = {
          class_type: accel.attention.class,
          inputs: { model: modelRef, attention: accel.attention.backend || 'comfy kitchen attention' }
        };
        modelRef = [aid, 0];
      }
      if (accel.blockCache && accel.blockCache.class) {
        const bid = '711';
        wf[bid] = {
          class_type: accel.blockCache.class,
          inputs: { model: modelRef, residual_diff_threshold: 0.12, start_percent: 0.08, end_percent: 0.95,
            max_consecutive_hits: 2, cache_device: 'cpu', metric_stride: 8, verbose: false }
        };
        modelRef = [bid, 0];
      }
      wf[vidN.guider].inputs.model = modelRef;
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

    // 放大二采：在本档的第一遍之后接一段「放大 → 再采」（只在本档声明了 twoPass 时）
    if (realParams.twoPass) {
      try {
        const r2 = applyTwoPass(wf, realParams.twoPass, {
          inj, profile: vidP, params: realParams, seed: realParams.seed2
        });
        realParams._twoPassOn = r2;
      } catch (e) {
        // 二采装不起来就退回「只出一版」—— 绝不能因为补细节这一步把整条生成打断
        realParams._twoPassOn = null;
        logger.warn('放大二采装配失败，本次按单遍出片：' + ((e && e.message) || e));
      }
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
    if (realParams._twoPassOn) {
      const tp = realParams.twoPass;
      logger.info('放大二采：第一遍 ' + realParams.width + 'x' + realParams.height + '（' + realParams.steps + ' 步）' +
        ' → 放大到 ' + tp.width + 'x' + tp.height + '（' + tp.steps + ' 步，σ 起点 ' +
        String(tp.sigmas).split(',')[0].trim() + '），音频沿用第一遍');
    }
  }

  const clientId = 'comic-studio-' + Date.now();
  const tSubmit = Date.now();
  // 生成配置一览（方便排查「分辨率/秒数不对」这类问题）
  if (isVideo) {
    logger.info('本次视频生成配置：' + realParams.width + 'x' + realParams.height +
      (realParams._twoPassOn ? '（二采后 ' + realParams._twoPassOn.width + 'x' + realParams._twoPassOn.height + '）' : '') +
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
    if (realParams._twoPassOn) {
      logger.info('二采模型：' + realParams.twoPass.lora + '｜' + realParams.twoPass.steps + ' 步' +
        (realParams.twoPass.shift ? '｜σ-shift ' + realParams.twoPass.shift[0] + '/' + realParams.twoPass.shift[1] : '') +
        '｜σ 序列 ' + realParams.twoPass.sigmas);
    }
  } else {
    logger.info('本次图片生成配置：' + realParams.width + 'x' + realParams.height +
      (realParams.image ? '，图生图（denoise ' + realParams.denoise + '）' : '，文生图') +
      '，工作流 ' + models.activeImageTemplate());
  }
  logger.info('提交 ComfyUI 工作流：' + (templateKey === 'video' ? ((vidP && vidP.label) || '视频') : '角色图') + ' → ' + baseName);

  // 提交前对账（2026-10-18）：ComfyUI 校验工作流的依据是它自己的 /object_info ——
  // 「节点在不在」和「模型文件它扫没扫到」都先用它当场返回的清单核一遍，
  // 免得提交出去一个注定失败的任务，用户只拿到一段英文 JSON。
  // 🔴 探测失败（老内核没有单节点路由 / 请求超时 / 桩服务）一律**放行**：
  //    「查不到」不等于「有问题」，绝不能把网络问题变成阻止生成的墙。
  let chk = null;
  try {
    chk = await comfyProbe.verifyWorkflow(endpoint('comfyui'), wf, { modelsRoot: models.modelsRoot() || '' });
  } catch (e) {
    logger.detail('提交前对账跳过（探测器异常）：' + ((e && e.message) || e));
  }
  if (chk && chk.skipped) logger.detail('提交前对账跳过：' + (chk.reason || 'ComfyUI 无响应'));
  if (chk && chk.ok && !chk.skipped) logger.detail('提交前对账通过（节点与模型文件均在 ComfyUI 可见）');
  if (chk && !chk.ok) {
    logger.warn('提交前对账未通过：' + (chk.problems || []).length + ' 项 → ' + baseName);
    throw new Error(chk.message);
  }

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
    // 校验失败 → 翻成中文（节点缺失 / 值不在候选列表 / 必填缺失）。
    // 认不出来时保留原文，别把有用信息吞掉。
    const zh = comfyProbe.explainPromptError(submit.json);
    throw new Error(zh
      ? ('ComfyUI 拒绝工作流：\n' + zh)
      : ('ComfyUI 拒绝工作流：' + JSON.stringify(submit.json).slice(0, 400)));
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
  const elapsedMs = Date.now() - tSubmit;
  // 生成时长落盘（2026-10-17）：耗时只活在渲染层内存里，重启/切菜单就没了，
  // 历史列表（imggen:history 只 stat 目录）因此永远只有分辨率没有时长。
  // 给每个产物配一个 <图片名>.json 旁的「旁车文件」，历史回读时带上 ms。
  for (const name of saved) {
    writeSidecar(dir, name, { ms: elapsedMs, mode: templateKey, at: new Date().toISOString() });
  }
  logger.done(saved.join('、') + ' 生成完成', elapsedMs);
  return { files: saved, seed: realParams.seed, elapsedMs };
}

/* ---------------- 成片超分（SeedVR2 · ComfyUI 内置节点） ---------------- */

/** 对齐到 step 的整数倍（默认 16）：SeedVR2 的 preprocess 会 pad 到 16、post 又裁到偶数，
 *  这里先把目标尺寸对齐，省得它自己补一轮再裁一轮。 */
function snapTo(v, step) {
  const s = Number(step) > 0 ? Number(step) : 16;
  return Math.max(s, Math.round(Number(v) / s) * s);
}

/**
 * 视频超分：输入一条本地镜头视频 → 放大一档 → 落盘到 outDir。
 *
 * 走 ComfyUI **内置**的 SeedVR2（comfy_extras/nodes_seedvr.py + comfy/ldm/seedvr）：
 *   LoadVideo → GetVideoComponents ─┬→ ImageScale(目标尺寸) → SeedVR2Preprocess → VAEEncodeTiled
 *                                   │        → SeedVR2TemporalChunk ─┬→ SeedVR2Conditioning → KSampler(1 步)
 *                                   │                                └→ (latent)              ↓
 *                                   │                                   SeedVR2TemporalMerge → VAEDecodeTiled
 *                                   │                                                            ↓
 *                                   │        ┌──────────── original_resized_images ──────→ SeedVR2PostProcessing
 *                                   └→ audio ┴→ CreateVideo(images, audio, fps) → SaveVideo
 * 与第三方插件路线（_vendor + 两个补丁 + SEEDVR2 私有目录）相比：零依赖、零补丁，
 * 模型直接落在 ComfyUI 标准的 diffusion_models / vae 两个目录里。
 *
 * @param {object} a
 * @param {string} a.file      源视频绝对路径
 * @param {string} a.outDir    产物目录（通常是 <项目>/分镜/_upscale）
 * @param {number} [a.scale]   放大倍率（默认取方案 params.scale，内置方案 = 2）
 * @returns {Promise<{file:string,path:string,width:number,height:number,srcWidth:number,srcHeight:number,elapsedMs:number}>}
 */
async function upscaleVideo({ file, outDir, scale, timeoutMs = 3600000 } = {}) {
  const src = String(file || '').trim();
  if (!src || !fs.existsSync(src)) throw new Error('超分失败：源视频不存在（' + (src || '(空)') + '）');
  const out = String(outDir || '').trim() || path.dirname(src);

  const p = profiles.active('upscale');
  if (!p) {
    throw new Error('没有可用的超分方案：electron/profiles/upscale.json 缺失或配置有误。'
      + '请到 设置 → 模型管家 检查，或重新安装本软件。');
  }
  const tplFile = workflowPath('upscale');
  if (!fs.existsSync(tplFile)) {
    throw new Error('超分工作流模板缺失：' + tplFile
      + '。请重新启动软件（首次运行会把内置模板补到工作区 workflows/ 目录）。');
  }

  // 模型文件：槽位由方案声明（role = upscaleModel / upscaleVae），代码不认文件名
  const A = models.resolveAssets('upscale');
  const unet = (A.byRole.upscaleModel && A.byRole.upscaleModel.name) || '';
  const vae = (A.byRole.upscaleVae && A.byRole.upscaleVae.name) || '';
  if (!unet || !vae) {
    const miss = [];
    if (!unet) miss.push('超分主模型（' + (p.assets.find(a => a.role === 'upscaleModel') || {}).need
      + '，放在 ComfyUI 的 diffusion_models 目录）');
    if (!vae) miss.push('超分 VAE（' + (p.assets.find(a => a.role === 'upscaleVae') || {}).need
      + '，放在 ComfyUI 的 vae 目录）');
    throw new Error('超分模型缺失：' + miss.join('；')
      + '。放好后到 设置 → 模型管家 点「重新检测」。（模型目录：' + (models.modelsRoot() || '未设置') + '）');
  }

  const meta = await probeVideo(src);
  if (!meta.width || !meta.height) {
    throw new Error('超分失败：读不出源视频的分辨率（' + path.basename(src) + '），文件可能已损坏。');
  }

  const prm = p.params || {};
  const k = Number(scale) > 0 ? Number(scale) : (Number(prm.scale) > 0 ? Number(prm.scale) : 2);
  const cap = Number(prm.capLongEdge) > 0 ? Number(prm.capLongEdge) : 1920;
  let tw = Math.round(meta.width * k), th = Math.round(meta.height * k);
  const long = Math.max(tw, th);
  if (long > cap) {
    // 长边封顶：hq 档的 1344×768 直接 ×2 会到 2688×1536，16G 显存跑不动
    const r = cap / long;
    tw = Math.round(tw * r); th = Math.round(th * r);
  }
  tw = snapTo(tw, 16); th = snapTo(th, 16);

  const tplText = fs.readFileSync(tplFile, 'utf-8');
  const videoName = await uploadToComfy(src);
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const params = {
    seedvr2_unet: unet, seedvr2_vae: vae, video: videoName,
    width: tw, height: th, seed: Math.floor(Math.random() * 1e9),
    steps: num(prm.steps, 1), cfg: num(prm.cfg, 1), denoise: num(prm.denoise, 1),
    sampler: prm.sampler || 'euler', scheduler: prm.scheduler || 'simple',
    color: prm.colorCorrection || 'lab',
    tile_size: num(prm.tileSize, 512), tile_overlap: num(prm.tileOverlap, 128),
    temporal_size: num(prm.temporalSize, 64), temporal_overlap: num(prm.temporalOverlap, 8),
    prefix: 'comic/upscale'
  };

  const filled = applyParams(tplText, params);
  const optionalPH = optionalPlaceholders();
  const left = findPlaceholders(filled).filter(x => !optionalPH.has(x));
  if (left.length) {
    const TIPS = phTips();
    const tips = left.map(x => {
      const key = x.replace(/^__|__$/g, '').toLowerCase();
      return x + (TIPS[key] ? ' → 缺少 ' + TIPS[key] : '');
    });
    throw new Error('超分工作流占位符未解析：' + tips.join('；')
      + '。请到 设置 → 模型管家 看模型目录对不对、缺哪个模型。');
  }
  let wf;
  try { wf = JSON.parse(filled); }
  catch (e) { throw new Error('超分工作流 JSON 解析失败（' + path.basename(tplFile) + '）：' + (e && e.message)); }

  logger.info('超分：' + path.basename(src) + ' → ' + tw + 'x' + th
    + '（源 ' + meta.width + 'x' + meta.height + '，' + k + ' 倍'
    + (long > cap ? '，按长边 ' + cap + ' 封顶' : '') + '）');

  disarmVramFree();
  try {
    // 提交前对账：节点在不在 / 模型文件 ComfyUI 扫没扫到（探测失败一律放行）
    let chk = null;
    try {
      chk = await comfyProbe.verifyWorkflow(endpoint('comfyui'), wf, { modelsRoot: models.modelsRoot() || '' });
    } catch (e) {
      logger.detail('超分提交前对账跳过（探测器异常）：' + ((e && e.message) || e));
    }
    if (chk && chk.skipped) logger.detail('超分提交前对账跳过：' + (chk.reason || 'ComfyUI 无响应'));
    if (chk && !chk.ok) throw new Error(chk.message);

    const clientId = 'comic-studio-up-' + Date.now();
    const tSubmit = Date.now();
    let submit;
    try {
      submit = await fetchJson(endpoint('comfyui') + '/prompt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: wf, client_id: clientId })
      }, 15000);
    } catch (e) {
      throw new Error('ComfyUI 服务不可达（' + endpoint('comfyui') + '）。请先手动打开一次 ComfyUI Desktop。');
    }
    if (!submit.ok || !submit.json || !submit.json.prompt_id) {
      const zh = comfyProbe.explainPromptError(submit.json);
      throw new Error(zh ? ('ComfyUI 拒绝超分工作流：\n' + zh)
        : ('ComfyUI 拒绝超分工作流：' + JSON.stringify(submit.json).slice(0, 400)));
    }
    const pid = submit.json.prompt_id;
    _activePid = pid;
    _cancelPid = null;

    // 轮询：完成 / 出错 / 被停止 / 从队列消失（3 次）/ 超时
    let history = null, vanished = 0, unreachable = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (_cancelPid === pid) throw new CancelledError(pid);
      await new Promise(r => setTimeout(r, 1500));
      let h;
      try { h = await fetchJson(endpoint('comfyui') + '/history/' + pid, {}, 8000); unreachable = 0; }
      catch (_) {
        if (++unreachable >= 30 && Date.now() - t0 > 120000) {
          throw new Error('ComfyUI 连续 ' + unreachable + ' 次无响应：它可能已退出，请检查后重试。');
        }
        continue;
      }
      if (h.ok && h.json && h.json[pid]) {
        history = h.json[pid];
        const st = history.status || {};
        if (st.completed) break;
        if (st.status_str === 'error') break;
      } else if (Date.now() - t0 > 15000) {
        let q = null;
        try { q = await fetchJson(endpoint('comfyui') + '/queue', {}, 8000); } catch (_) { q = null; }
        if (q && q.ok && q.json) {
          const inQueue = ['queue_running', 'queue_pending'].some(key =>
            Array.isArray(q.json[key]) && q.json[key].some(it => (Array.isArray(it) ? it[1] : it && it.prompt_id) === pid));
          if (!inQueue) {
            vanished++;
            if (vanished >= 3) throw new Error('超分任务已从 ComfyUI 队列消失：ComfyUI 可能被重启或任务被中断，请重试。');
          } else vanished = 0;
        }
      }
    }
    if (!history) {
      throw new Error('超分超时未完成（已等待 ' + Math.round((Date.now() - t0) / 1000) + 's）。'
        + '可到 ComfyUI 界面确认它是否仍在运行（产物会留在 ComfyUI 的 output 目录）。');
    }
    if (history.status && history.status.status_str === 'error') {
      const errMsg = (history.status.messages || []).filter(m => m[0] === 'execution_error')[0];
      const e0 = errMsg ? errMsg[1] : null;
      const brief = e0
        ? ('节点 ' + e0.node_type + '[' + e0.node_id + ']：' + String(e0.exception_message || '').trim())
        : JSON.stringify(history.status.messages || {}).slice(0, 400);
      const raw = e0 ? String(e0.exception_message || '') : '';
      const tip = /out of memory|OutOfMemory|CUDA error/i.test(raw)
        ? '（显存不足：关掉其他占用显存的程序，或把放大倍率调小后重试）' : '';
      throw new Error('超分执行出错：' + brief + tip);
    }

    // 拉产物。
    // 🔴 只认「保存节点」/ type=output 的产物：LoadVideo 在 history.outputs 里也会挂一条
    //    （type=input 的原样回显），照单全收会把**上传的源视频**当成超分结果下载回来
    //    （2026-10-21 实测踩到：拿去当产物的那条是 864×480 的源片，真产物 1728×960 反而被丢掉）。
    const saveId = String((p.nodes && p.nodes.save) || '');
    const outNodes = (saveId && history.outputs[saveId])
      ? [saveId]
      : Object.keys(history.outputs || {});
    const bufs = [];
    for (const nodeId of outNodes) {
      for (const key of ['videos', 'gifs', 'images']) {
        for (const item of (history.outputs[nodeId][key] || [])) {
          if ((item.type || 'output') !== 'output') continue;
          const q = new URLSearchParams({
            filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output'
          });
          const r = await fetch(endpoint('comfyui') + '/view?' + q);
          if (!r.ok) throw new Error('超分产物下载失败：' + item.filename);
          bufs.push({ buf: Buffer.from(await r.arrayBuffer()), ext: (path.extname(item.filename) || '.mp4').slice(1) });
        }
      }
    }
    if (!bufs.length) throw new Error('ComfyUI 完成了超分但没有产出文件');

    // 一次超分只应有一份产物；万一方案以后接多个保存节点，全都落盘（渲染层取第一份）
    const written = [];
    for (const b of bufs) {
      const stem = path.basename(src, path.extname(src));
      const name = writeUnique(out, stem + '_超分', b.ext, b.buf);
      written.push(name);
    }
    const name = written[0];
    const abs = path.join(out, name);
    const after = await probeVideo(abs);
    const elapsedMs = Date.now() - tSubmit;
    logger.done('超分完成：' + name + '（' + (after.width || tw) + 'x' + (after.height || th) + '）', elapsedMs);
    return {
      file: name, path: abs,
      width: after.width || tw, height: after.height || th,
      srcWidth: meta.width, srcHeight: meta.height, elapsedMs
    };
  } finally {
    armVramFree();
    _activePid = null;
    _cancelPid = null;
  }
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

/* ---------------- 方案 D：成片逐镜响度归一化（2026-10-16） ----------------
 * 问题（Dragon 实测《真人剧4》第 4 集）：四镜综合响度 −34.6 / −15.0 / −17.0 / −21.0 LUFS，
 *   镜 1 与镜 2 差 19.6 dB。成片是**逐镜 concat**，每镜各起一次头 → 观感就是
 *   「BGM 一会儿有一会儿没有，像换了好几首」。
 * 做法：concat **之前**逐镜把那一段音频归一到同一目标响度。
 * 🔴 为什么不能「整片拼完再 loudnorm 一次」：两遍法的 linear 模式本质是**一个恒定增益**，
 *    只能整体平移，镜间 19.6 dB 的落差**原样保留**；单遍的动态模式会拉平，但会引入泵动
 *    （pumping）并压掉镜内音乐动态。要真正「落差归零」只有逐镜恒定增益一条路。
 * 收益：落差归零，且不改动视频管线（中间产物 `-c:v copy`，只重编音频）。
 */
const NORM_I = -16;            // 目标综合响度（LUFS）—— 流媒体通用档
const NORM_TP = -1.5;          // 目标真峰值（dBTP）—— 留 1.5 dB 余量防转码削波
const NORM_GAIN_MAX = 20;      // 单镜增益上限（dB）：防「近乎静音的镜」被抬成一片底噪
/** 综合响度低于此值视为「这一镜本来就没音」——放大只会抬底噪，直接不动（返回 0 dB 增益） */
const NORM_SILENT_I = -50;

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
 * 解析 ebur128 结尾的 Summary 段 → { i, lra, tp }（任一取不到给 null）。
 *
 * 段落实例（ffmpeg 6.x，`ebur128=peak=true`）：
 *   Summary:
 *     Integrated loudness:
 *       I:         -34.6 LUFS
 *       Threshold: -44.8 LUFS      ← 注意：Threshold 出现两次，这里不要它
 *     Loudness range:
 *       LRA:         1.0 LU
 *       Threshold: -55.2 LUFS
 *     True peak:
 *       Peak:      -17.0 dBFS
 *
 * ⚠️ 必须**锚定小节标题**再取值：`I:` / `LRA:` 在每 100ms 的周期行里也出现，
 *    不锚定就会把最后一条周期行当成摘要（那只是 100ms 的瞬时值，不是全片积分值）。
 */
function parseLoudnessSummary(txt) {
  const s = String(txt || '');
  const pick = (re) => { const m = s.match(re); return m ? parseFloat(m[1]) : null };
  const i = pick(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+)\s*LUFS/);
  const lra = pick(/Loudness range:\s*\n\s*LRA:\s*(-?[\d.]+)\s*LU/);
  const tp = pick(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+)\s*dBFS/);
  const ok = v => (Number.isFinite(v) ? v : null);
  return (i === null && lra === null && tp === null) ? null : { i: ok(i), lra: ok(lra), tp: ok(tp) };
}

/**
 * 由响度摘要算这一镜该加的**恒定增益**（dB，0 = 不动）。纯函数。
 *
 * 规则（三条护栏，按优先级）：
 *   1. 目标：把综合响度抬/压到 NORM_I（`NORM_I - i`）。
 *   2. 削波护栏：真峰值最多抬到 NORM_TP（`NORM_TP - tp`）—— 取两者更小者。
 *      这是「宁可差几 dB 也不削波」的取舍：H3 混音的 −34.6 LUFS 那一镜峰值已是 −17.0 dBFS，
 *      抬 18.6 dB 会顶穿 0 dBFS，按真峰值截到 +15.5 dB → 落在 −19.1 LUFS，
 *      与其它镜的 19.6 dB 落差收敛到 3.1 dB（物理上不可能再多了）。
 *   3. 上下限 ±NORM_GAIN_MAX；综合响度低于 NORM_SILENT_I 视为本镜无音 → 0（不抬底噪）。
 *
 * @param m analyzeShot().loud（可为 null = 无音轨 / 解析失败）
 * @returns 增益 dB（保留两位小数；0 表示不需要处理）
 */
function normGain(m, opt = {}) {
  const tI = Number.isFinite(opt.targetI) ? opt.targetI : NORM_I;
  const tTP = Number.isFinite(opt.targetTP) ? opt.targetTP : NORM_TP;
  const cap = Number.isFinite(opt.maxGain) ? opt.maxGain : NORM_GAIN_MAX;
  if (!m || !Number.isFinite(m.i)) return 0;
  if (m.i <= NORM_SILENT_I) return 0;
  let g = tI - m.i;
  if (Number.isFinite(m.tp)) g = Math.min(g, tTP - m.tp);
  g = Math.max(-cap, Math.min(cap, g));
  const r = Math.round(g * 100) / 100;
  return Number.isFinite(r) ? r : 0;
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

/**
 * 逐镜分析：一次 ffmpeg 进程同时拿到 ① 实测时长 ② 镜内响度曲线 ③ 响度摘要（LUFS/LRA/真峰值）。
 *
 * 🔴 2026-10-16（方案 D）：`peak` 由 `none` 改成 `true` —— 响度摘要里的 True peak 是
 *    响度归一化的**削波护栏**（增益必须让输出真峰值停在 TP 目标以下，见 normGain）。
 *    代价只是音频解码时多一次 4 倍过采样峰值扫描，`-vn` 下可忽略。
 *    周期性输出行会多出尾巴 `FTPK: .. TPK: ..`，`parseLevelCurve` 的正则只取 TARGET 与 M，
 *    不受影响（已实测对比两种设置的曲线点完全一致）。
 */
function analyzeShot(ffmpeg, file) {
  return new Promise(resolve => {
    // ⚠️ 不能加 -nostats：ebur128 的响度行会跟着一起被吞掉
    const args = ['-hide_banner', '-loglevel', 'info', '-i', file, '-vn',
      '-af', 'ebur128=peak=true', '-f', 'null', '-'];
    try {
      execFile(ffmpeg, args, { windowsHide: true, timeout: 180000, maxBuffer: 1 << 24 }, (err, _stdout, stderr) => {
        const txt = String(stderr || '');
        resolve({ dur: parseDurationLine(txt), level: parseLevelCurve(txt), loud: parseLoudnessSummary(txt) });
      });
    } catch (_) { resolve({ dur: 0, level: [], loud: null }); }
  });
}

/**
 * ffprobe 读一个视频的完整流规格（导出用）。
 * 用途有两个：①「自动分辨率」取第一个镜头的真实画布；② 判断能否零转码拼接
 * （所有段的 宽高/帧率/视频编码/像素格式/音频编码/采样率/声道 必须完全一致）。
 * 探测失败返回 null（调用方一律当「不可 copy」处理）。
 */
function probeStreamInfo(ffmpeg, file) {
  return new Promise(resolve => {
    const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (!fs.existsSync(ffprobe)) return resolve(null);
    const args = ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels',
      '-show_entries', 'format=duration', '-of', 'json', file];
    try {
      execFile(ffprobe, args, { windowsHide: true, timeout: 30000, maxBuffer: 1 << 21 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(String(stdout || '{}'));
          const ss = j.streams || [];
          const v = ss.find(s => s.codec_type === 'video') || null;
          const a = ss.find(s => s.codec_type === 'audio') || null;
          if (!v || !v.width) return resolve(null);
          const d = parseFloat((j.format || {}).duration);
          resolve({
            w: +v.width, h: +v.height,
            vcodec: String(v.codec_name || ''), pixfmt: String(v.pix_fmt || ''), fps: String(v.r_frame_rate || ''),
            hasAudio: !!a,
            acodec: a ? String(a.codec_name || '') : '',
            sr: a ? String(a.sample_rate || '') : '', ch: a ? String(a.channels || '') : '',
            dur: Number.isFinite(d) ? d : 0
          });
        } catch (_) { resolve(null); }
      });
    } catch (_) { resolve(null); }
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

/**
 * 单镜响度归一化 → 中间产物（方案 D）。
 *
 * 🔴 只重编**音频**（`-c:v copy`）→ 视频零损、耗时几乎只有 I/O，可以逐镜都过一遍。
 * 🔴 音频中间产物用 **PCM**（`pcm_s16le`，封进 mkv）：无损，成片那一步只做一次 AAC 编码；
 *    中途先编成 AAC 再编一次就是两代有损，能避则避。
 * 🔴 无音轨的镜补一段等长静音：concat 列表里各段流结构不一致时音轨会整体错位
 *    （表现为「越往后字幕/声音越飘」），宁可多写一次静音。
 *
 * @param gainDb normGain() 的结果（0 = 原样，但仍会产出规格统一的中间产物）
 * @param hasAudio 该镜是否有音轨（来自 analyzeShot 的响度摘要是否为 null）
 */
function normalizeShot(ffmpeg, src, dst, gainDb, hasAudio) {
  return new Promise(resolve => {
    const g = Number.isFinite(gainDb) ? Math.round(gainDb * 100) / 100 : 0;
    const args = ['-y', '-i', src];
    if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-shortest');
    args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0');
    if (hasAudio) args.push('-af', 'volume=' + g + 'dB');
    args.push('-c:v', 'copy', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-f', 'matroska', dst);
    try {
      execFile(ffmpeg, args, { windowsHide: true, timeout: 300000, maxBuffer: 1 << 22 }, (err, _o, se) => {
        const okFile = !err && fs.existsSync(dst);
        resolve({ ok: okFile, err: okFile ? '' : String(se || err || '').slice(-400) });
      });
    } catch (e) { resolve({ ok: false, err: String(e) }); }
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
 * 真实拼接导出：concat + 统一输出分辨率 + 可选逐镜响度归一 + 可选字幕烧录。
 * videos: [{file, dialogue, dur}]（绝对路径）
 * opts.width/height：输出分辨率（剧集「输出分辨率」配置），默认 1920x1080。
 * opts.autoRes：true = 忽略 width/height，取**第一个镜头**的实际分辨率（下拉里的「自动」）。
 * opts.normalize：**逐镜响度归一（方案 D）** —— concat 之前把每一镜的音频归到同一目标响度，
 *   治「镜间 BGM 音量忽大忽小」（《真人剧4》第 4 集实测差 19.6 dB）；关掉则与改造前逐字一致。
 */
async function exportVideo(outDir, outName, videos, { subtitles = true, width = 1920, height = 1080, autoRes = false, scope = '', normalize = true } = {}) {
  // 导出是一次性长任务：这里同步确认一次 ffmpeg（避免「预热没跑完」被误判成没装）
  const ffmpeg = findFfmpeg({ forceSync: true });
  if (!ffmpeg) throw new Error('未找到 ffmpeg。软件自带的 tools/ffmpeg/bin/ffmpeg.exe 不见了，'
    + '请重新安装，或把 ffmpeg 放进系统 PATH。');
  fs.mkdirSync(outDir, { recursive: true });
  if (!videos.length) throw new Error('没有可拼接的视频片段');
  let W = Math.max(16, Math.round(Number(width) || 1920));
  let H = Math.max(16, Math.round(Number(height) || 1080));
  // 🔴 成片分辨率「自动」（2026-10-19）：取**第一个镜头文件的真实画布**（不是生成时选的档位字符串）。
  //    目的：导出不再对每个镜头做一次 bicubic 放大/补边 —— 生成多大，成片就多大。
  if (autoRes) {
    const first = await probeStreamInfo(ffmpeg, videos[0].file);
    if (first && first.w && first.h) {
      // yuv420p / libx264 要求偶数边长，奇数向下取偶
      W = Math.max(16, first.w - (first.w % 2));
      H = Math.max(16, first.h - (first.h % 2));
    } else {
      logger.warn('成片分辨率=自动，但第一个镜头的分辨率探测失败 → 回退 ' + W + 'x' + H);
    }
  }
  const tExport = Date.now();
  logger.info('ffmpeg 组装成片：' + videos.length + ' 个镜头，输出 ' + W + 'x' + H + (autoRes ? '（自动：跟第一个镜头）' : '')
    + (normalize ? ' + 响度归一' : '') + (subtitles ? ' + 字幕烧录' : ''));

  const tmp = path.join(outDir, '_tmp_' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const vfBase = 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2';

    // ---- 逐镜分析（实测时长 / 镜内响度曲线 / 响度摘要）----
    // 归一化要用摘要算增益，字幕要用曲线定人声窗 —— 一次解码同时喂两处。
    // 两者都不需要时不跑，省一轮完整解码。
    const shots = (normalize || subtitles) ? await mapLimit(videos, 4, v => analyzeShot(ffmpeg, v.file)) : [];

    // ---- 方案 D：concat 之前逐镜响度归一（只重编音频，视频流 copy）----
    const segs = videos.map(v => v.file);
    if (normalize) {
      const info = [];
      const outs = await mapLimit(videos, 4, async (v, i) => {
        const m = (shots[i] || {}).loud || null;
        const g = normGain(m);
        const dst = path.join(tmp, 'n' + String(i).padStart(3, '0') + '.mkv');
        const r = await normalizeShot(ffmpeg, v.file, dst, g, !!m);
        if (!r.ok) { logger.warn('第 ' + (i + 1) + ' 镜响度归一化失败，该镜按原样拼接：' + r.err); return null; }
        info[i] = '镜' + (i + 1) + ' ' + (m ? m.i.toFixed(1) + '→' + (m.i + g).toFixed(1) : '无音轨') + ' LUFS '
          + '(' + (g >= 0 ? '+' : '') + g.toFixed(2) + 'dB)';
        return dst;
      });
      outs.forEach((p, i) => { if (p) segs[i] = p; });
      logger.info('响度目标 ' + NORM_I + ' LUFS / ' + NORM_TP + ' dBTP：' + info.filter(Boolean).join(' | '));
    }

    // concat 列表（先统一转码为相同规格，避免拼接黑屏）
    const listFile = path.join(tmp, 'list.txt');
    fs.writeFileSync(listFile, segs.map(p => 'file \'' + p.replace(/\\/g, '/').replace(/'/g, "'\\''") + '\'').join('\n'), 'utf-8');

    const outBase = sanitize(outName);
    // 走 assetStore 永不覆盖
    const finalName = (() => {
      let name = outBase + '.mp4', i = 2;
      while (fs.existsSync(path.join(outDir, name))) { name = outBase + '_' + String(i).padStart(2, '0') + '.mp4'; i++; }
      return name;
    })();
    const finalPath = path.join(outDir, finalName);
    const concatArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];

    // ---- 能否「零转码拼接」（2026-10-19）----
    // 条件：所有段规格**完全一致**、且就等于目标分辨率 —— 此时 scale/pad 是空操作，
    // 直接 `-c:v copy` 拼接 ⇒ 视频流一次都不重编（省一代有损 + 快几倍）。
    // 只要有一项不一致（换了档位 → 某镜是 864x480、某镜 1344x768），就必须走重编码。
    const segInfo = await mapLimit(segs, 4, p => probeStreamInfo(ffmpeg, p));
    const s0 = segInfo[0] || null;
    const copyable = !!(s0 && s0.hasAudio && segInfo.every(i => i
      && i.w === W && i.h === H && i.fps === s0.fps && i.vcodec === s0.vcodec && i.pixfmt === s0.pixfmt
      && i.acodec === s0.acodec && i.sr === s0.sr && i.ch === s0.ch));
    // 重编码兜底（画质档：crf 17 —— 比原来的 20 明显更实，文件约 +30%）
    const reencodeNoSubs = () => runFfmpeg(ffmpeg, [...concatArgs, '-vf', vfBase, '-c:v', 'libx264', '-preset', 'medium',
      '-crf', '17', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', finalPath], tmp);

    if (!subtitles) {
      let done = false;
      if (copyable) {
        const rc = await runFfmpeg(ffmpeg, [...concatArgs, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart', finalPath], tmp);
        if (rc.code === 0 && fs.existsSync(finalPath)) {
          done = true;
          logger.info('零转码拼接：' + videos.length + ' 段规格一致 → 视频流 copy，未产生新的压缩世代');
        } else {
          logger.warn('零转码拼接失败，回退重编码：' + rc.err.slice(-300));
          try { fs.rmSync(finalPath, { force: true }); } catch (_) {}
        }
      }
      if (!done) {
        const res = await reencodeNoSubs();
        if (res.code !== 0 || !fs.existsSync(finalPath)) throw new Error('ffmpeg 导出失败：' + res.err.slice(-500));
      }
    } else {
      // ---- pass1：先拼出无字幕母片（CRF 12，中间产物几乎不掉画质）----
      const mutePath = path.join(tmp, 'mute.mp4');
      const r1 = await runFfmpeg(ffmpeg, [...concatArgs, '-vf', vfBase, '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '12', '-c:a', 'aac', '-b:a', '192k', mutePath], tmp);
      if (r1.code !== 0 || !fs.existsSync(mutePath)) throw new Error('ffmpeg 拼接母片失败：' + r1.err.slice(-500));

      // ---- A + B：逐镜实测时长（A）+ 镜内响度窗定位人声（B）----
      // ⚠️ 分析结果在函数开头就取好了（响度归一要用同一份摘要）—— 这里直接复用，不要再跑一遍。
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
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-c:a', 'copy',
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
  upscaleVideo,
  extractLastFrame,
  applyParams, findPlaceholders, h3Params, forgetWorkspace, listVideosWithMeta,
  // 模型方案驱动的部分（换模型只改配置，下面是代码侧入口）
  injectMedia, phTips, optionalPlaceholders,
  // 字幕时间轴纯函数（离线自测用，不需要显卡/ffmpeg/Electron）
  srtTime, parseDurationLine, parseLevelCurve, bestSpeechSpan, trimSpeechSpan, cueText, cueWeight, spreadByWeight, buildCues, buildFilmCues, cuesToSrt,
  analyzeShot, probeDuration,
  // 响度归一化（方案 D · 离线自测用）
  parseLoudnessSummary, normGain, normalizeShot,
  // 导出仅为离线自测（test/h3-inject-check.cjs 直接验证连线，不需要显卡/ComfyUI）
  injectH3Media,
  // 放大二采（离线自测用；生产链路只经 comfyGenerate）
  __twoPassOf: twoPassOf, __applyTwoPass: applyTwoPass, __dropTwoPass: dropTwoPass,
  __firstPassCanvas: firstPassCanvas,
  // 纯函数（离线自测用）
  contentLen,
  // 提示词反推（图片 → 正向提示词）
  reversePrompt, cleanPromptText, REVERSE_SYSTEM
};
