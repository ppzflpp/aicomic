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
 * 特例：llm（llama.cpp 的 GGUF）不属于 ComfyUI 的模型体系，
 *   优先看模型根目录下有没有 llm/LLM 子目录，否则退回项目 runtime\models\llm。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

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

/** ComfyUI 模型根下可能存放 GGUF 的子目录名 */
const LLM_SUBDIRS = ['llm', 'LLM', 'LLMs', 'gguf', 'GGUF'];

/**
 * 模型清单。key = ComfyUI 标准子目录名（llm 例外）。
 * sub      : 模型根目录下的子目录名
 * prefer   : 首选文件名特征（挑不到就退化为「最大的一个」）
 * required : 缺失时「环境未就绪」
 */
const ITEMS = [
  {
    key: 'llm', sub: null, group: 'engine', short: 'LLM',
    label: 'LLM 文本模型（llama.cpp GGUF）', exts: ['.gguf'], prefer: /qwen|gemma|llama|mistral/i,
    required: true, hint: '改编稿 / 分镜脚本生成，llama-server 加载'
  },
  {
    key: 'checkpoints', sub: 'checkpoints', group: 'comfy', short: '底模',
    label: '角色图底模 checkpoints', exts: ['.safetensors', '.ckpt'], prefer: /xl|anime|illustrious|noob|pony|novelai/i,
    exclude: /^(sam|vit|blip|swin|nsfw_detector)/i,
    required: true, hint: '第 4 块「角色库」出图用的 SD / SDXL 底模'
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

function resolveDir(key) {
  if (!key) return null;
  if (key === ROOT_KEY || key === 'comfyuiRoot') return modelsRoot();

  const custom = db.getSetting('modelpath.' + key);
  if (custom) return custom;

  const it = item(key);
  if (!it) return null;

  if (it.sub) {
    const root = modelsRoot();
    if (root) return path.join(root, it.sub);
    const pr = projectRoot();
    return pr ? path.join(pr, 'runtime', 'models', it.sub) : null;
  }

  // llm：优先模型根下的 llm 目录（若 GGUF 也放在 ComfyUI 里），否则项目 runtime
  const root = modelsRoot();
  if (root) {
    for (const s of LLM_SUBDIRS) {
      const p = path.join(root, s);
      if (fs.existsSync(p)) return p;
    }
  }
  const pr = projectRoot();
  return pr ? path.join(pr, 'runtime', 'models', 'llm') : '';
}

/** 枚举某个 key 下的模型文件（返回相对名，ComfyUI 认的就是相对名） */
function listFiles(key) {
  const it = item(key);
  const dir = resolveDir(key);
  const out = [];
  if (!it || !dir || !fs.existsSync(dir)) return out;

  const stack = [{ d: dir, rel: '' }];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur.d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = cur.rel ? cur.rel + '/' + e.name : e.name;
      if (e.isDirectory()) { stack.push({ d: path.join(cur.d, e.name), rel }); continue; }
      if (it.exts.length && !it.exts.some(x => e.name.toLowerCase().endsWith(x))) continue;
      if (it.exclude && it.exclude.test(e.name)) continue;   // 排除同名场景的非底模文件（如 sam3.1）
      let size = 0;
      try { size = fs.statSync(path.join(cur.d, e.name)).size; } catch (_) { /* ignore */ }
      out.push({ name: rel, size });
    }
  }
  out.sort((a, b) => b.size - a.size);   // 大文件通常是主模型
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
 * 供 ComfyUI 工作流使用的模型文件名集合（缺失的为 null，替换时会被跳过并给出缺件提示）
 *
 * 🔴 H3 的权重与加速 LoRA 必须「显式配对」：fl2va 只能配 fl2v 系列的 LoRA，
 *    ref2va 只能配 ref2v 系列的 LoRA，混配会直接毁掉画面。
 *    所以这里绝不用 /turbo/ 这种模糊匹配 —— 目录里同时存在
 *    fl2v_turbo_4step / fl2v_turbo_8step / ref2v_turbo_4step 三份，
 *    「第一个含 turbo 的文件」会随机配错。
 */
function workflowModels() {
  return {
    ckpt: pick('checkpoints'),
    // —— Z-Image Turbo 三件套（生图模板 character_zimage_turbo.json 用）——
    z_unet: pickStrict('diffusion_models', /z_image/i),
    z_clip: pickStrict('text_encoders', /qwen_3_4b/i),
    z_vae: pickStrict('vae', /^ae[\._-]/i),
    h3_model: pick('diffusion_models', /fl2va/i) || pick('diffusion_models'),
    h3_fl2va: pickStrict('diffusion_models', /fl2va/i),
    h3_ref2va: pickStrict('diffusion_models', /ref2va/i),
    h3_text_encoder: pick('text_encoders', /qwen3vl|h3/i) || pick('text_encoders'),
    h3_video_vae: pickStrict('vae', /video_vae/i),
    h3_audio_vae: pickStrict('vae', /audio_vae/i),
    // fl2v 加速 LoRA：快速档 = 4step，高质量档 = 8step（两份都留，按档位选）
    h3_fl2v_lora_fast: pickStrict('loras', /fl2v[a-z_]*turbo_4step|fl2v.*4step/i) || pickStrict('loras', /fl2v/i),
    h3_fl2v_lora_hq: pickStrict('loras', /fl2v.*8step/i) || pickStrict('loras', /fl2v/i),
    // ref2v 专用加速 LoRA —— 只能配 ref2va，不能配到 fl2va 上
    h3_ref2v_lora: pickStrict('loras', /ref2v/i),
    // 兼容旧占位符：默认一律走 fl2v（= 文字/首帧/首尾帧那条线）
    h3_lora: pickStrict('loras', /fl2v/i),
    h3_turbo_lora: pickStrict('loras', /fl2v/i)
  };
}

/* ------------------------------------------------------------------ *
 * 分辨率档位（按当前模型过滤）
 *   图片：看底模 —— SDXL 系给 1024 档，SD1.5 系给 512 档
 *   视频：看 diffusion_models —— 检出 H3（fl2va/ref2va）给 H3 档，否则给通用档
 *   输出：成片导出档位（与模型无关）
 * 返回 [{ value:'WxH', label:'宽×高（比）' }]，value 直接存库/传生成。
 * ------------------------------------------------------------------ */
const RES_SDXL = [
  ['1024x1024', '1024×1024（1:1）'],
  ['1216x832',  '1216×832（3:2）'],
  ['832x1216',  '832×1216（2:3）'],
  ['1344x768',  '1344×768（16:9）'],
  ['768x1344',  '768×1344（9:16）'],
  ['1152x896',  '1152×896（9:7）'],
  ['896x1152',  '896×1152（7:9）']
];
const RES_SD15 = [
  ['512x512', '512×512（1:1）'],
  ['768x512', '768×512（3:2）'],
  ['512x768', '512×768（2:3）'],
  ['640x640', '640×640（1:1）']
];
const RES_H3 = [
  ['864x480', '864×480（16:9）'],
  ['480x864', '480×864（9:16）'],
  ['960x544', '960×544（16:9）'],
  ['544x960', '544×960（9:16）'],
  ['1344x768', '1344×768（16:9）'],
  ['768x1344', '768×1344（9:16）'],
  ['768x768', '768×768（1:1）'],
  ['640x640', '640×640（1:1）']
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
 * 生图工作流模板（插件化：新增工作流 = electron/workflows/ 放模板文件 + 这里加一行）
 * ------------------------------------------------------------------ */

/**
 * 生图工作流模板注册表。
 * file   : workspace/workflows/ 下的模板文件（缺省时由 ensureDefaultTemplates 从内置播种）
 * resTier: 分辨率档位 —— '1024' 固定 1024 档（Z-Image / SDXL），'ckpt' 按底模文件名判断
 * 模板内占位符契约：__PROMPT__ __NEGATIVE__ __SEED__ __WIDTH__ __HEIGHT__
 *                   __IMAGE__（图生图支路，节点1/2）__LATENT__（节点5 空潜变量）__DENOISE__
 *                   __CKPT__（SDXL）/ __Z_UNET__ __Z_CLIP__ __Z_VAE__（Z-Image 三件套）
 */
const IMAGE_TEMPLATES = {
  'zimage-turbo': {
    key: 'zimage-turbo', label: 'Z-Image Turbo（中文提示词 · 8 步）',
    file: 'workflows/character_zimage_turbo.json', resTier: '1024'
  },
  'sdxl': {
    key: 'sdxl', label: 'SDXL 底模（旧版，animagine-xl）',
    file: 'workflows/character.json', resTier: 'ckpt'
  }
};
const DEFAULT_IMAGE_TEMPLATE = 'zimage-turbo';

/** 当前激活的生图模板 key（设置缺失 / 非法时回默认） */
function activeImageTemplate() {
  const k = db.getSetting('imageTemplate');
  return (k && IMAGE_TEMPLATES[k]) ? k : DEFAULT_IMAGE_TEMPLATE;
}

function imageTemplateInfo() { return IMAGE_TEMPLATES[activeImageTemplate()]; }

/** 给设置界面的下拉列表：全部候选 + 当前激活标记 */
function imageTemplates() {
  const act = activeImageTemplate();
  return Object.values(IMAGE_TEMPLATES).map(t => ({ key: t.key, label: t.label, active: t.key === act }));
}

function resOptions() {
  const act = activeImageTemplate();
  // Z-Image 原生 1024 档，与 SDXL 同档；SD1.5 才降到 512 档
  const isXL = IMAGE_TEMPLATES[act].resTier === '1024' ||
    /xl|pony|illustrious|noob|z_image/i.test(String(pick('checkpoints') || ''));
  const wm = workflowModels();
  const vid = (wm.h3_fl2va || wm.h3_ref2va || /h3/i.test(String(wm.h3_model || ''))) ? RES_H3 : RES_VID_GENERIC;
  return { img: toOpts(isXL ? RES_SDXL : RES_SD15), vid: toOpts(vid), out: toOpts(RES_OUT) };
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

function check() {
  const root = modelsRoot();
  const act = activeImageTemplate();
  const items = ITEMS.map(it => {
    const dir = resolveDir(it.key);
    const files = (dir && fs.existsSync(dir)) ? listFiles(it.key) : [];
    // checkpoints（SDXL 底模）只在激活 SDXL 模板时才算必需；Z-Image 模板下由下面的动态项接管
    const required = it.key === 'checkpoints' ? act !== 'zimage-turbo' : !!it.required;
    return {
      key: it.key, label: it.label, short: it.short, group: it.group,
      hint: it.hint, required, sub: it.sub,
      path: dir || '', ok: files.length > 0, count: files.length,
      sample: files.slice(0, 3).map(f => f.name),
      isCustom: !!db.getSetting('modelpath.' + it.key)
    };
  });
  if (act === 'zimage-turbo') {
    const zmain = workflowModels().z_unet;
    items.push({
      key: 'zimage', label: 'Z-Image Turbo 主模型 diffusion_models', short: '生图主模', group: 'comfy',
      hint: '第 4 块「角色库」出图用的 Z-Image Turbo 主模型（z_image_turbo_*.safetensors）',
      required: true, sub: 'diffusion_models',
      path: resolveDir('diffusion_models') || '',
      ok: !!zmain, count: zmain ? 1 : 0, sample: zmain ? [zmain] : [],
      isCustom: !!db.getSetting('modelpath.diffusion_models')
    });
  }
  const required = items.filter(i => i.required);
  return {
    ready: required.every(i => i.ok),
    items,
    comfyItems: items.filter(i => i.group === 'comfy'),
    engineItems: items.filter(i => i.group === 'engine'),
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
  init, check, setPath, resolveDir, ensure,
  modelsRoot, setModelsRoot, redetect, detectModelsRoot,
  listFiles, pick, pickStrict, workflowModels, scoreRoot, drives, ITEMS, ROOT_KEY, AUTO_KEY,
  IMAGE_TEMPLATES, activeImageTemplate, imageTemplateInfo, imageTemplates,
  resOptions
};
