'use strict';
/**
 * 模型目录检测 —— 与 ComfyUI 共用同一份模型目录。
 *
 * 设计原则：软件不自建模型目录，而是直接复用 ComfyUI 的 models 目录。
 *   用户只指定一个「ComfyUI 模型根目录」(= ComfyUI 的 models 目录，
 *   ComfyUI Desktop 通常为 ...\ComfyUI-Shared\models)，
 *   软件按 ComfyUI 标准子目录名（checkpoints / diffusion_models /
 *   text_encoders / vae / loras ...）读取。
 *   → 在 ComfyUI 里下载的模型，本软件立刻可用，不需要复制第二份。
 *
 * 特例：剧本大模型（llama.cpp 的 GGUF）不是 ComfyUI 的节点权重，但目录也统一放
 *   在模型根目录下 —— ComfyUI 没有 llm 这一类目，GGUF 与文本编码器同属「文本模型」，
 *   所以落在标准目录 text_encoders\ 里（用户只需记一个模型目录）。
 *   取用时按顺序找：模型根\text_encoders → 旧布局 llm/gguf 子目录 → 项目 runtime\models\llm。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const profiles = require('./profiles.cjs');

let db = null;

/** 模型根目录的设置键（用户只需设置这一个）；AUTO_KEY 存自动探测结果 */
const ROOT_KEY = 'comfyui.modelsRoot';
const AUTO_KEY = 'comfyui.modelsRootAuto';
/** 历史键：旧版本把 ComfyUI 底模目录 / H3 目录分开存，启动时迁移 */
const LEGACY_ROOT_KEYS = ['modelpath.comfyui', 'modelpath.h3'];

/** ComfyUI 标准模型子目录名（用于判断一个目录「像不像」ComfyUI 的 models 根） */
const STANDARD_SUBDIRS = [
  'audio_encoders', 'background_removal', 'checkpoints', 'clip', 'clip_vision',
  'configs', 'controlnet', 'diffusers', 'diffusion_models', 'embeddings',
  'frame_interpolation', 'loras', 'model_patches', 'photomaker', 'style_models',
  'text_encoders', 'unet', 'upscale_models', 'vae', 'vae_approx'
];

/**
 * 剧本大模型（llama.cpp 的 GGUF）落点 = ComfyUI 标准目录 text_encoders。
 * ComfyUI 的目录规范里没有 llm 这一类目，而 GGUF 本身就是文本模型权重，
 * 与 text_encoders 里的文本编码器同类 —— 放这里既符合「一个模型目录」的原则，
 * 也不用再教用户认识一个私有目录。
 */
const LLM_SUBDIR = 'text_encoders';
/** 历史布局：GGUF 曾单独放模型根下的 llm / gguf 目录（仍然识别，老环境不至于突然变红） */
const LEGACY_LLM_SUBDIRS = ['llm', 'LLM', 'LLMs', 'gguf', 'GGUF'];
/** GGUF 里带 vl 的是 H3 的 qwen3vl 文本编码器，不是剧本大模型，不能拿来跑 llama-server */
const LLM_NOT_RE = /vl/i;

/**
 * 模型清单。key = ComfyUI 标准子目录名（llm 例外）。
 * sub      : 模型根目录下的子目录名
 * prefer   : 首选文件名特征（挑不到就退化为「最大的一个」）
 * required : 缺失时「环境未就绪」
 */
const ITEMS = [
  {
    key: 'llm', sub: LLM_SUBDIR, group: 'engine', short: 'LLM',
    label: 'LLM 文本模型（llama.cpp GGUF）', exts: ['.gguf'], prefer: /qwen|gemma|llama|mistral/i,
    exclude: LLM_NOT_RE,   // qwen3vl 的 GGUF 是 H3 编码器，不是剧本大模型
    required: true, hint: '改编稿 / 分镜脚本生成，llama-server 加载（放在模型根目录的 text_encoders 下）'
  },
  {
    key: 'diffusion_models', sub: 'diffusion_models', group: 'comfy', short: 'H3主模型',
    label: 'H3 视频主模型 diffusion_models', exts: ['.safetensors'], prefer: /fl2va|ref2va|h3/i,
    required: true, hint: 'minimax_h3 fl2va / ref2va，第 6 块出视频'
  },
  {
    key: 'text_encoders', sub: 'text_encoders', group: 'comfy', short: '编码器',
    label: 'H3 文本编码器 text_encoders', exts: ['.safetensors'], prefer: /qwen3vl|h3/i,
    required: true, hint: 'qwen3vl_32b —— H3 必需'
  },
  {
    key: 'vae', sub: 'vae', group: 'comfy', short: 'VAE',
    label: 'H3 VAE', exts: ['.safetensors'], prefer: /video_vae|h3/i,
    required: true, hint: 'minimax_h3 的 video vae + audio vae，两者都需要'
  },
  {
    key: 'loras', sub: 'loras', group: 'comfy', short: 'LoRA',
    label: 'LoRA（H3 Turbo 加速）', exts: ['.safetensors'], prefer: /turbo|h3/i,
    required: false, hint: '可选：Turbo LoRA 把采样从 30+ 步压到 4-8 步'
  }
];

function init(dbRef) {
  db = dbRef;
  profiles.init(dbRef);   // 模型方案先就位（下面 ensure() 里的迁移与检测都要读它）
  ensure();
}

function item(key) { return ITEMS.find(i => i.key === key) || null; }

/** 项目根目录（workspace 的上一级，即 .../AIComic） */
function projectRoot() {
  const ws = db.getSetting('workspace') || '';
  return ws ? path.dirname(ws) : '';
}

/* ------------------------------------------------------------------ *
 * 根目录探测
 * ------------------------------------------------------------------ */

let _rootCache = null;      // 本次进程内解析出的生效根目录
let _detectCache = null;    // 本次进程内自动探测的结果

/** 「像不像 ComfyUI models 根」打分：标准子目录数 + 有文件的子目录数×3，-1 = 不像 */
function scoreRoot(dir) {
  if (!dir) return -1;
  let st;
  try { st = fs.statSync(dir); } catch (_) { return -1; }
  if (!st.isDirectory()) return -1;
  let subCount = 0, filled = 0;
  for (const s of STANDARD_SUBDIRS) {
    const p = path.join(dir, s);
    if (!fs.existsSync(p)) continue;
    subCount++;
    try { if (fs.readdirSync(p).length) filled++; } catch (_) { /* ignore */ }
  }
  if (!subCount) return -1;
  return subCount + filled * 3;
}

/** ComfyUI Desktop 自己的配置文件里记录的位置（可能过期，需要 existsSync 校验） */
function appDataCandidates() {
  const out = [];
  const ad = process.env.APPDATA;
  if (!ad) return out;
  const base = path.join(ad, 'ComfyUI');

  // extra_models_config.yaml → base_path + download_model_base
  try {
    const y = fs.readFileSync(path.join(base, 'extra_models_config.yaml'), 'utf-8');
    const bp = (y.match(/^\s*base_path:\s*(.+)$/m) || [])[1];
    const dbm = (y.match(/^\s*download_model_base:\s*(.+)$/m) || [])[1] || 'models';
    const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '');
    if (clean(bp)) out.push(path.join(clean(bp), clean(dbm)));
  } catch (_) { /* 文件不存在即可 */ }

  // config.json → basePath
  try {
    const c = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf-8'));
    if (c && c.basePath) out.push(path.join(String(c.basePath), 'models'));
  } catch (_) { /* ignore */ }
  return out;
}

/** 存在的盘符（C..Z）。断开的网络盘 existsSync 可能慢，包在 try 里 */
function drives() {
  const out = [];
  for (let i = 67; i <= 90; i++) {
    const d = String.fromCharCode(i) + ':\\';
    try { if (fs.existsSync(d)) out.push(d); } catch (_) { /* ignore */ }
  }
  return out;
}

/** 候选目录列表（按可信度排序） */
function candidates() {
  const c = [];

  // 1) ComfyUI Desktop 的配置文件
  c.push(...appDataCandidates());

  // 2) 旧约定的工作区模型目录
  const ws = db.getSetting('workspace');
  if (ws) c.push(path.join(ws, 'models'));

  // 3) 各盘符顶层 Comfy* 目录（ComfyUI Desktop 默认把共享目录放在安装目录旁）
  for (const d of drives()) {
    let tops = [];
    try { tops = fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()); } catch (_) { continue; }
    for (const t of tops) {
      if (!/^comfy/i.test(t.name)) continue;
      const p = path.join(d, t.name);
      c.push(path.join(p, 'ComfyUI-Shared', 'models'));       // Desktop 共享目录
      c.push(path.join(p, 'ComfyUI', 'models'));              // Desktop 安装实例
      c.push(path.join(p, 'models'));
      c.push(path.join(p, 'resources', 'ComfyUI', 'models'));
    }
  }

  // 5) 常见固定位置兜底
  const home = os.homedir();
  c.push(path.join(home, 'ComfyUI-Shared', 'models'));
  c.push(path.join(home, 'Documents', 'ComfyUI', 'models'));
  c.push(path.join(home, 'ComfyUI', 'models'));
  return c;
}

/** 自动探测得分最高的 ComfyUI models 根目录；找不到返回 '' */
function detectModelsRoot(force) {
  if (!force && _detectCache !== null) return _detectCache;
  let best = '', bestScore = 0;
  for (const dir of candidates()) {
    const s = scoreRoot(dir);
    if (s > bestScore) { best = dir; bestScore = s; }
  }
  _detectCache = best;
  return best;
}

/**
 * 当前生效的模型根目录：
 *   1) 用户显式设置的路径（存在就用）
 *   2) 上次自动探测并缓存的路径
 *   3) 现探一次（结果缓存进库，下次启动秒开）
 */
function modelsRoot() {
  const saved = db.getSetting(ROOT_KEY);
  if (saved && fs.existsSync(saved)) return saved;
  if (_rootCache !== null) return _rootCache;
  const auto = db.getSetting(AUTO_KEY);
  if (auto && scoreRoot(auto) > 0) { _rootCache = auto; return auto; }
  const d = detectModelsRoot();
  _rootCache = d || '';
  if (d) db.setSetting(AUTO_KEY, d);
  return _rootCache;
}

/** 保存用户指定的模型根目录；传空 = 清除自定义，回到自动探测 */
function setModelsRoot(dir) {
  const v = dir ? String(dir).trim() : null;
  db.setSetting(ROOT_KEY, v);
  _rootCache = null;
  return check();
}

/** 强制重新探测 ComfyUI 模型目录并更新缓存 */
function redetect() {
  _rootCache = null;
  _detectCache = null;
  db.setSetting(AUTO_KEY, null);
  const d = detectModelsRoot(true);
  if (d) db.setSetting(AUTO_KEY, d);
  _rootCache = d;
  return check();
}

/* ------------------------------------------------------------------ *
 * 目录解析 / 文件枚举
 * ------------------------------------------------------------------ */

/** 目录里有没有「剧本大模型」的 GGUF（带 vl 的是 H3 文本编码器，不算） */
function hasLlmGguf(dir) {
  try {
    return fs.readdirSync(dir).some(n => /\.gguf$/i.test(n) && !LLM_NOT_RE.test(n));
  } catch (_) { return false; }
}

/**
 * 剧本大模型（GGUF）目录 —— 一律在模型根目录体系内，不再单开私有目录：
 *   1) ComfyUI 标准目录 text_encoders（新落点，与文本编码器同类）
 *   2) 历史布局：模型根下的 llm / gguf 子目录（老用户不动文件也能继续跑）
 *   3) 更老的兜底：项目 runtime\models\llm
 * 命中条件 = 目录里真的有非 vl 的 GGUF；一个都没命中时返回「应该放的那一个」，
 * 这样界面提示出来的路径就是用户该用的位置。
 */
function llmDir() {
  const root = modelsRoot();
  const pr = projectRoot();
  const legacy = pr ? path.join(pr, 'runtime', 'models', 'llm') : '';
  const cands = [];
  if (root) {
    cands.push(path.join(root, LLM_SUBDIR));
    for (const s of LEGACY_LLM_SUBDIRS) cands.push(path.join(root, s));
  }
  if (legacy) cands.push(legacy);
  for (const d of cands) if (hasLlmGguf(d)) return d;
  return root ? path.join(root, LLM_SUBDIR) : legacy;
}

/**
 * 解析一个 ComfyUI 标准子目录的绝对路径。
 * 用户手改过该子目录（设置键 modelpath.<sub>）时以用户的为准 ——
 * 这样「模型方案」里声明的目录与生成时真正用的目录永远是同一个。
 */
function dirOfSub(sub) {
  if (!sub) return null;
  const custom = db.getSetting('modelpath.' + sub);
  if (custom) return custom;
  const root = modelsRoot();
  if (root) return path.join(root, sub);
  const pr = projectRoot();
  return pr ? path.join(pr, 'runtime', 'models', sub) : null;
}

function resolveDir(key) {
  if (!key) return null;
  if (key === ROOT_KEY || key === 'comfyuiRoot') return modelsRoot();

  const custom = db.getSetting('modelpath.' + key);
  if (custom) return custom;

  const it = item(key);
  if (!it) return null;

  // llm：GGUF 也放在 ComfyUI 模型根目录里（标准目录 text_encoders），见 llmDir()
  if (it.key === 'llm') return llmDir();

  return it.sub ? dirOfSub(it.sub) : null;
}

/**
 * 列出一个目录下的模型文件（递归；按体积降序 —— 大文件通常就是主模型）。
 * @param {string} dir      绝对路径
 * @param {string[]} exts   认得的扩展名（空 = 全认）
 * @param {RegExp|null} exclude  命中则跳过（同名的非底模文件，如 sam3.1）
 */
function listInDir(dir, exts, exclude) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const stack = [{ d: dir, rel: '' }];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur.d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = cur.rel ? cur.rel + '/' + e.name : e.name;
      if (e.isDirectory()) { stack.push({ d: path.join(cur.d, e.name), rel }); continue; }
      if (exts && exts.length && !exts.some(x => e.name.toLowerCase().endsWith(x))) continue;
      if (exclude && exclude.test(e.name)) continue;
      let size = 0;
      try { size = fs.statSync(path.join(cur.d, e.name)).size; } catch (_) { /* ignore */ }
      out.push({ name: rel, size });
    }
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

/** 枚举某个 key 下的模型文件（返回相对名，ComfyUI 认的就是相对名） */
function listFiles(key) {
  const it = item(key);
  if (!it) return [];
  return listInDir(resolveDir(key), it.exts, it.exclude);
}

/* ------------------------------------------------------------------ *
 * 模型方案 → 实际文件
 * ------------------------------------------------------------------ */

/** 安全编译配置里写的正则（用户写错了不能让生成整个挂掉） */
function safeRe(src, flags) {
  if (!src) return null;
  if (src instanceof RegExp) return src;
  try { return new RegExp(String(src), flags || ''); } catch (_) { return null; }
}

/**
 * 按「模型方案」里的一条 assets 声明，解析这个槽位实际用哪个文件。
 *   pick: 'strict' → 文件名必须命中特征，否则视为没装（H3 的 fl2va / ref2va 这类「必须是指定那一个」）
 *   pick: 'any'    → 命中不了就用该目录里最大的那个（普通底模：装了什么就用什么）
 * @returns {{ name: string|null, files: string[] }}
 *   files = 该目录里可用的全部文件名（list: true 的槽位要用它做档位解析）
 */
function resolveAsset(asset) {
  const all = listInDir(dirOfSub(asset.dir), asset.exts, null);
  const re = safeRe(asset.match, 'i');
  const exRe = safeRe(asset.exclude, 'i');
  const usable = exRe ? all.filter(f => !exRe.test(path.basename(f.name))) : all;
  const hit = re ? usable.filter(f => re.test(path.basename(f.name))) : usable;
  const files = asset.list ? usable.map(f => f.name) : hit.map(f => f.name);
  if (hit.length) return { name: hit[0].name, files };
  if (asset.pick === 'any' && usable.length) return { name: usable[0].name, files };
  return { name: null, files };
}

/**
 * 按「角色」索引当前方案的模型文件 —— 生成流程只认角色
 * （unet / textEncoder / videoVae / lora …），不认槽位名，
 * 所以换模型（改槽位名 / 加别名）不需要改生成代码。
 */
function resolveAssets(kind) {
  const p = profiles.active(kind);
  const byRole = {}, bySlot = {};
  if (!p) return { profile: null, byRole, bySlot };
  for (const a of p.assets) {
    const r = resolveAsset(a);
    byRole[a.role] = { slot: a.slot, name: r.name, files: r.files };
    bySlot[a.slot] = { role: a.role, name: r.name, files: r.files };
  }
  return { profile: p, byRole, bySlot };
}

/** 某个角色当前解析到的文件名（拿不到返回 null） */
function assetName(kind, role) {
  const a = resolveAssets(kind);
  return (a.byRole[role] && a.byRole[role].name) || null;
}

/** 某个角色对应槽位的全部文件（档位解析 LoRA 用） */
function assetFiles(kind, role) {
  const a = resolveAssets(kind);
  return (a.byRole[role] && a.byRole[role].files) || [];
}

/**
 * 供 ComfyUI 工作流使用的模型文件名集合。
 * 🔴 键名 = 工作流模板里的占位符名（小写）：声明了 slot `z_unet`，模板里就写 `__Z_UNET__`。
 *    值为 null 的会被 applyParams 跳过，最后由「占位符未解析」统一报缺哪个模型。
 *
 * @param {string} [kind] 'image' | 'video'；
 *        省略 = 合并「所有生图方案 + 当前视频方案」—— 生图模板可能同时引用两套方案的槽位
 *        （如 Z-Image 三件套与 SDXL 底模各留一份模板），视频同时只跑一套。
 */
function workflowModels(kind) {
  const out = {};
  const list = [];
  if (kind) {
    const p = profiles.active(kind);
    if (p) list.push(p);
  } else {
    for (const p of profiles.all('image')) list.push(p);
    const v = profiles.active('video');
    if (v) list.push(v);
  }
  for (const p of list) {
    for (const a of p.assets) {
      const r = resolveAsset(a);
      out[a.slot] = r.name;
      // 档位解析要「这个目录里有哪些 LoRA」的完整清单
      if (a.list) out[a.slot + '_files'] = r.files;
      // 历史别名：老工作流模板里的旧占位符（如 __H3_MODEL__）指同一个文件
      for (const alias of a.alsoAs) out[alias] = r.name;
    }
  }
  return out;
}

/** 挑一个模型名：优先 prefer 命中，否则取最大的一个 */
function pick(key, prefer) {
  const it = item(key);
  const re = prefer === undefined ? (it && it.prefer) : prefer;
  const files = listFiles(key);
  if (!files.length) return null;
  if (re instanceof RegExp) {
    const hit = files.find(f => re.test(path.basename(f.name)));
    if (hit) return hit.name;
  }
  return files[0].name;
}

/**
 * 严格挑模型：文件名不匹配就返回 null。
 * 用于「必须是指定那一个」的场合（如 H3 需要 fl2va / ref2va / video vae / audio vae
 * 各一个具体文件），避免用别的模型兜底后 ComfyUI 报出难懂的错。
 */
function pickStrict(key, re) {
  if (!(re instanceof RegExp)) return null;
  const files = listFiles(key);
  const hit = files.find(f => re.test(path.basename(f.name)));
  return hit ? hit.name : null;
}

/**
 * 旧版的「模型文件名硬编码表」已被「模型方案」取代 —— 见上面的 workflowModels()。
 * 保留这段历史说明，因为它记录的坑仍然成立：
 *
 * 🔴 H3 的权重与加速 LoRA 必须「显式配对」：fl2va 只能配 fl2v 系列的 LoRA，
 *    ref2va 只能配 ref2v 系列的 LoRA，混配会直接毁掉画面。
 *    所以方案里一律用「精确正则 + pick: strict」，绝不用 /turbo/ 这种模糊匹配 ——
 *    目录里同时存在 fl2v_turbo_4step / fl2v_turbo_8step / ref2v_turbo_4step 三份，
 *    「第一个含 turbo 的文件」会随机配错。
 */
/* ------------------------------------------------------------------ *
 * 分辨率档位（按当前方案与模型过滤）
 *   图片：用方案声明的 resolutions（每个内置生图方案都自带，走不到兜底）
 *   视频：用方案自己的 resolutions（不同视频模型支持的分辨率完全不同）
 *   输出：成片导出档位（与模型无关）
 * 返回 [{ value:'WxH', label:'宽×高（比）' }]，value 直接存库/传生成。
 * ------------------------------------------------------------------ */
/** 图片档位兜底（正常走不到：内置生图方案都自带 resolutions） */
const RES_IMG_FALLBACK = [
  ['1024x1024', '1024×1024（1:1）'],
  ['1920x1080', '1920×1080（16:9）'],
  ['1080x1920', '1080×1920（9:16）'],
  ['2560x1440', '2560×1440（16:9）'],
  ['1440x2560', '1440×2560（9:16）'],
  ['2048x2048', '2048×2048（1:1）'],
  ['1344x768',  '1344×768（16:9）'],
  ['768x1344',  '768×1344（9:16）'],
  ['1152x896',  '1152×896（9:7）'],
  ['896x1152',  '896×1152（7:9）']
];
const RES_VID_GENERIC = [
  ['1280x720',  '1280×720（16:9）'],
  ['720x1280',  '720×1280（9:16）'],
  ['1024x1024', '1024×1024（1:1）']
];
const RES_OUT = [
  ['1920x1080', '1920×1080（16:9）'],
  ['1280x720',  '1280×720（16:9）'],
  ['2560x1440', '2560×1440（16:9）'],
  ['1080x1920', '1080×1920（9:16）'],
  ['720x1280',  '720×1280（9:16）']
];
const toOpts = (a) => a.map(([value, label]) => ({ value, label }));

/* ------------------------------------------------------------------ *
 * 生图方案（模型方案的一部分；这里保留老的「模板注册表」接口名做兼容）
 *   生图用哪个工作流、要哪些模型文件、参数与分辨率档全部由「模型方案」声明
 *   （electron/profiles/*.json 内置，workspace/profiles/*.json 覆盖）。
 *   新增一个生图模型 = 加一份方案 JSON + 一个工作流模板，这里一行都不用改。
 * ------------------------------------------------------------------ */

/** 当前激活的生图方案 id（设置缺失 / 非法时回默认方案；只用于缺件提示文案） */
function activeImageTemplate() { return profiles.activeId('image'); }

function resOptions() {
  const img = profiles.active('image');
  const vid = profiles.active('video');
  // 方案自己声明分辨率清单；缺了才用兜底档（正常情况走不到兜底）
  const imgRes = (img && Array.isArray(img.resolutions) && img.resolutions.length) ? img.resolutions : RES_IMG_FALLBACK;
  const vidRes = (vid && Array.isArray(vid.resolutions) && vid.resolutions.length) ? vid.resolutions : RES_VID_GENERIC;
  return { img: toOpts(imgRes), vid: toOpts(vidRes), out: toOpts(RES_OUT) };
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

function check() {
  const root = modelsRoot();
  const imgP = profiles.active('image');
  const vidP = profiles.active('video');

  // 当前方案要求哪些目录（决定下面那 6 个目录项的「必需」标记）
  const needDirs = new Set();
  for (const p of [imgP, vidP]) {
    if (!p) continue;
    for (const a of p.assets) if (a.required) needDirs.add(a.dir);
  }

  const items = ITEMS.map(it => {
    const dir = resolveDir(it.key);
    const files = (dir && fs.existsSync(dir)) ? listFiles(it.key) : [];
    // 引擎项（剧本大模型）恒必需；comfy 目录项只在该目录被当前方案要求时才算必需
    const required = it.group === 'engine' ? true : needDirs.has(it.sub);
    return {
      key: it.key, label: it.label, short: it.short, group: it.group,
      hint: it.hint, required, sub: it.sub,
      path: dir || '', ok: files.length > 0, count: files.length,
      sample: files.slice(0, 3).map(f => f.name),
      isCustom: !!db.getSetting('modelpath.' + it.key)
    };
  });

  // 方案要求的具体模型文件 —— 同一个目录里可能混放多套方案的权重（如 diffusion_models 里
  // 既放生图主模型又放视频主模型），只看目录项看不出到底缺哪一个，所以逐个列出来。
  for (const p of [imgP, vidP]) {
    if (!p) continue;
    for (const a of p.assets) {
      const r = resolveAsset(a);
      items.push({
        key: a.slot, label: a.label, short: a.short || a.role, group: 'asset',
        hint: a.why || a.hint, required: a.required, sub: a.dir,
        path: dirOfSub(a.dir) || '', ok: !!r.name,
        count: r.name ? Math.max(1, r.files.length) : 0,
        sample: r.files.slice(0, 3),
        isCustom: !!db.getSetting('modelpath.' + a.dir)
      });
    }
  }

  const required = items.filter(i => i.required);
  return {
    ready: required.every(i => i.ok),
    items,
    comfyItems: items.filter(i => i.group === 'comfy' || i.group === 'asset'),
    engineItems: items.filter(i => i.group === 'engine'),
    assetItems: items.filter(i => i.group === 'asset'),
    modelsRoot: root || '',
    modelsRootOk: scoreRoot(root) > 0,
    modelsRootIsCustom: !!db.getSetting(ROOT_KEY),
    detectedRoot: (() => { try { return detectModelsRoot(); } catch (_) { return ''; } })()
  };
}

function setPath(key, dir) {
  if (key === ROOT_KEY || key === 'comfyuiRoot') return setModelsRoot(dir);
  db.setSetting('modelpath.' + key, dir ? String(dir).trim() : null);
  return check();
}

/** 启动时的一次性迁移：旧版的 modelpath.comfyui / modelpath.h3 → 新的根目录模型 */
function ensure() {
  const legacyComfy = db.getSetting('modelpath.comfyui');
  if (legacyComfy) {
    if (!db.getSetting(ROOT_KEY) && (scoreRoot(legacyComfy) > 0 || /models$/i.test(legacyComfy))) {
      db.setSetting(ROOT_KEY, legacyComfy);
    } else if (!db.getSetting('modelpath.checkpoints')) {
      db.setSetting('modelpath.checkpoints', legacyComfy);
    }
    db.setSetting('modelpath.comfyui', null);
  }
  const legacyH3 = db.getSetting('modelpath.h3');
  if (legacyH3) {
    if (!db.getSetting(ROOT_KEY) && scoreRoot(legacyH3) > 0) db.setSetting(ROOT_KEY, legacyH3);
    db.setSetting('modelpath.h3', null);
  }
  for (const k of LEGACY_ROOT_KEYS) db.setSetting(k, null);
  // 首次运行：探测一次并把结果写进设置，后续启动直接读
  modelsRoot();
}

module.exports = {
  init, check, setPath, resolveDir, dirOfSub, ensure,
  modelsRoot, setModelsRoot, redetect, detectModelsRoot,
  listFiles, listInDir, pick, pickStrict, scoreRoot, drives, ITEMS, ROOT_KEY, AUTO_KEY,
  llmDir, hasLlmGguf, LLM_SUBDIR,
  // 模型方案 → 实际文件：换模型只改配置，下面是代码侧唯一入口
  workflowModels, resolveAsset, resolveAssets, assetName, assetFiles,
  // 生图方案：换模型只改方案 JSON，代码侧只保留「当前激活项」这一个入口
  activeImageTemplate,
  resOptions, profiles
};
