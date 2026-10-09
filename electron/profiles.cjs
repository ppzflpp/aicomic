'use strict';
/**
 * 模型方案（profile）—— 「换生图 / 生视频模型只改配置，不改代码」的收口点。
 *
 * 一份 profile = 一个模型方案的全部模型相关知识：
 *   id / kind     标识 + 用途（image 生图 / video 视频）
 *   workflow      用哪个工作流模板（workspace/workflows/ 下的相对路径）
 *   assets        需要哪些模型文件：放哪个标准子目录、按什么文件名特征匹配
 *   nodes         节点语义锚点 —— 代码按「角色」找节点，不再认写死的数字 id
 *   classes       这套模型特有的节点类名（如 H3 的 MiniMaxH3* 系列）
 *   params        采样参数（生图/视频的基础步数等）
 *   frames        视频帧参数（帧率 / 帧网格 / 秒数范围 / 宽高对齐）—— 仅 video
 *   tiers         快慢质量档位 → 权重 / LoRA / 步数 / σ-shift 的映射 —— 仅 video
 *   wiring        首尾帧 / 参考图 / 参考视频怎么接进工作流 —— 仅 video
 *   capabilities  支持哪些能力（不支持的入口在界面上直接禁用，而不是生成时才发现）
 *   prompt        这套模型用哪些提示词规范文件（可覆盖 / 可追加）
 *
 * 换模型的做法（全程不碰代码）：
 *   ① ComfyUI 里把新工作流导出成 API 格式 JSON → 丢进 workspace/workflows/
 *   ② 复制一份 profile JSON 改字段 → 丢进 workspace/profiles/
 *   ③ 设置页选中它。
 *
 * 读取顺序：内置（electron/profiles/，随包发布）→ 用户（workspace/profiles/，同名覆盖）。
 * 兜底原则（老用户升级不能炸）：内置目录里永远有一份能跑的内置方案；
 * 用户那份读不出 / 校验不过 → 丢掉用户那份、继续用内置的，并把错误报给设置页。
 */
const fs = require('fs');
const path = require('path');

/** 内置方案目录（随包发布，只读） */
const BUILTIN_DIR = path.join(__dirname, 'profiles');
/** 方案自带的提示词规范放在 <方案目录>/prompts/ */
const PROMPT_SUBDIR = 'prompts';
/**
 * 项目级「模型专属规范」覆盖子目录：<项目>/prompts/model/。
 * 🔴 2026-10-07 改造：原先读 workspace/profiles/prompts/（工作区级，一份覆盖管所有项目），
 *    已下沉到项目 —— 换模型写法只影响它所属的那部片子。**工作区目录不再读取。**
 *    单独起 model/ 子目录是为了不和 <项目>/prompts/ 下那 10 份通用规范挤在一层。
 */
const MODEL_SUBDIR = 'model';

let db = null;
/** 扫描结果缓存：{ byId: {id: {profile, source, file}}, errors: [] }，reload() 清空 */
let _cache = null;

const KINDS = ['image', 'video'];
/** 每种用途的激活方案设置键 */
const SETTING = { image: 'profile.image', video: 'profile.video' };
/** 历史键：老版本只有生图模板这一个设置（imageTemplate）→ 迁移成 profile.image */
const LEGACY_SETTING = { image: 'imageTemplate' };
/** 用途的中文名（报错文案用） */
const KIND_LABEL = { image: '生图', video: '视频' };

/* ------------------------------------------------------------------ *
 * 文件读取
 * ------------------------------------------------------------------ */

function ws() {
  try { return (db && db.getSetting('workspace')) || ''; } catch (_) { return ''; }
}

/** 用户方案目录（工作区下；用户想改内置方案就复制一份到这里，同名覆盖） */
function userDir() {
  const w = ws();
  return w ? path.join(w, 'profiles') : '';
}

/**
 * 项目级「模型专属规范」覆盖目录（<项目>/prompts/model/）。
 * 没给 projectRoot（设置页这类「还不知道哪个项目」的场景）→ 返回 ''，纯用内置。
 */
function userPromptDir(projectRoot) {
  const r = String(projectRoot == null ? '' : projectRoot).trim();
  return r ? path.join(r, 'prompts', MODEL_SUBDIR) : '';
}

function listByExt(dir, re) {
  try {
    return fs.readdirSync(dir).filter(f => re.test(f)).sort().map(f => path.join(dir, f));
  } catch (_) { return []; }
}

/** 读 JSON；失败返回 { __err }（不抛，配置错误要能被收集展示而不是炸掉启动） */
function readJsonFile(p) {
  let text;
  try { text = fs.readFileSync(p, 'utf-8'); }
  catch (e) { return { __err: '读不到文件：' + String((e && e.message) || e) }; }
  let o;
  try { o = JSON.parse(text); }
  catch (e) { return { __err: 'JSON 语法错误：' + String((e && e.message) || e) }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { __err: '顶层必须是一个 JSON 对象' };
  return o;
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

/**
 * 校验一份方案。返回错误说明数组（空 = 通过）。
 * 报错必须点名到字段 —— 用户手改配置出错时，这条信息就是他唯一的线索。
 */
function validate(p) {
  const e = [];
  const str = (k) => (typeof p[k] === 'string' && p[k].trim()) ? p[k].trim() : '';

  if (!str('id')) e.push('缺 id');
  if (p.id && !/^[A-Za-z0-9._-]+$/.test(p.id)) e.push('id 只能用字母 / 数字 / 点 / 短横 / 下划线');
  if (!KINDS.includes(p.kind)) e.push('kind 必须是 image（生图）或 video（视频）');
  if (!str('label')) e.push('缺 label（设置页里显示的名字）');
  if (!str('workflow')) e.push('缺 workflow（工作流模板路径，如 workflows/xxx.json）');
  if (!p.params || typeof p.params !== 'object' || Array.isArray(p.params)) e.push('缺 params（采样参数对象）');

  if (!p.nodes || typeof p.nodes !== 'object' || Array.isArray(p.nodes) || !Object.keys(p.nodes).length) {
    e.push('缺 nodes（节点语义锚点：角色名 → 节点 id）');
  }
  if (!Array.isArray(p.assets) || !p.assets.length) {
    e.push('缺 assets（模型文件槽位清单，至少一条）');
  } else {
    p.assets.forEach((a, i) => {
      if (!a || typeof a !== 'object') { e.push(`assets[${i}] 不是对象`); return; }
      if (!str2(a.slot)) e.push(`assets[${i}] 缺 slot（槽位名 = 工作流占位符名，小写）`);
      if (!str2(a.dir)) e.push(`assets[${i}] 缺 dir（ComfyUI 标准子目录名）`);
      if (!str2(a.match)) e.push(`assets[${i}] 缺 match（文件名匹配特征）`);
      else {
        try { new RegExp(a.match); }
        catch (err) { e.push(`assets[${i}].match 不是合法正则：${a.match}`); }
      }
    });
  }

  // 按用途校验「必须有的角色」—— 少了这些，生成流程没法装配
  const need = p.kind === 'video'
    ? [['conditioning', '主条件节点（承载提示词 / 首尾帧 / 参考媒体）'],
       ['guider', '引导器节点（模型 → 条件）'],
       ['samplerAdv', '高级采样器节点（把噪声 / 引导 / 调度接起来）'],
       ['model', '模型加载节点（LoRA / σ-shift 都从它接下去）']]
    : [['latent', '空潜变量节点（文生图时的 latent_image 来源）'],
       ['save', '产物保存节点']];
  const nodes = (p.nodes && typeof p.nodes === 'object') ? p.nodes : {};
  for (const [role, why] of need) if (!str2(nodes[role])) e.push(`nodes 缺角色「${role}」（${why}）`);

  if (p.kind === 'video') {
    const f = p.frames;
    if (!f || typeof f !== 'object') e.push('视频方案缺 frames（帧参数）');
    else {
      if (!(Number(f.fps) > 0)) e.push('frames.fps 必须是正数（每秒帧数）');
      if (!Array.isArray(f.grid) || f.grid.length !== 2 || !(Number(f.grid[0]) > 0)) {
        e.push('frames.grid 必须是 [周期, 偏移] 两个数，如 [17, 5] 表示帧数对齐到 17k+5');
      }
    }
    if (!p.tiers || typeof p.tiers !== 'object' || !Object.keys(p.tiers).length) {
      e.push('视频方案缺 tiers（快慢质量档位表）');
    }
    if (!p.wiring || typeof p.wiring !== 'object') e.push('视频方案缺 wiring（首尾帧 / 参考媒体接线方式）');
  }
  return e;

  function str2(v) { return (typeof v === 'string' && v.trim()) ? v.trim() : ''; }
}

/** 补默认值，让下游消费方不用到处判空 */
function normalize(p) {
  const out = { ...p };
  out.nodes = { ...(p.nodes || {}) };
  out.classes = { ...(p.classes || {}) };
  out.params = { ...(p.params || {}) };
  out.capabilities = { ...(p.capabilities || {}) };
  out.assets = (p.assets || []).map(a => ({
    slot: String(a.slot).trim(),
    // role：代码按角色取文件（不认槽位名）。不写就默认与 slot 同名。
    role: String(a.role || a.slot).trim(),
    dir: String(a.dir).trim(),
    match: String(a.match),
    exts: (Array.isArray(a.exts) && a.exts.length) ? a.exts.map(x => String(x).toLowerCase()) : ['.safetensors'],
    exclude: a.exclude ? String(a.exclude) : '',
    // strict = 文件名必须命中（H3 的 fl2va / ref2va 这类「必须是指定那一个」）；
    // any = 命中不了就用该目录里最大的那个兜底（普通底模）
    pick: a.pick === 'strict' ? 'strict' : 'any',
    // list = 还要把该目录里所有命中文件列出来（档位按文件名解析 LoRA 用）
    list: !!a.list,
    // optional = 「缺了不算错，自动摘掉相关节点」——
    // 与 required（缺了算环境没就绪）是两个维度：h3_ref2va 是 required:false 但 optional:false
    // （只有走参考模式时才需要，可真需要时缺了必须报错），h3_lora 才是 optional:true。
    optional: !!a.optional,
    // alsoAs = 同一个文件还要以这些名字供占位符替换（历史别名：老工作流模板里的旧占位符）——
    // 例如 H3 的 __H3_MODEL__ 与 __H3_FL2VA__ 指向同一个权重文件
    alsoAs: Array.isArray(a.alsoAs) ? a.alsoAs.map(x => String(x).trim()).filter(Boolean) : [],
    required: a.required !== false,
    // 记入模型管家「可导入」清单（默认记；LLM 那种不在 assets 里的另有来源）
    importable: a.importable !== false,
    // importRe：**模型管家专用**的文件名特征（可选）。
    //   与 match 的区别：match 是在「已经确定的那个目录里挑文件」，可以带兜底分支
    //   （如 H3 编码器写 `qwen_?3[._-]?vl|h3`，因为目录已经是 text_encoders）；
    //   而模型管家是**跨目录按文件名猜该放哪**，特征必须足够独特 ——
    //   带兜底分支的 match 会把 `h3_video_vae.safetensors` 也判成编码器。
    //   不写就用 match。
    importRe: a.importRe ? String(a.importRe) : '',
    label: a.label || a.slot,
    // short：状态栏小胶囊上的短标签（2-4 个字）
    short: a.short || '',
    need: a.need || '',
    why: a.why || '',
    hint: a.hint || a.why || ''
  }));
  if (p.kind === 'video') {
    out.frames = { fps: 24, grid: [17, 5], seconds: [4, 15], snap: 32, default: [864, 480], ...(p.frames || {}) };
    out.wiring = { ...(p.wiring || {}) };
    out.branches = Array.isArray(p.branches) && p.branches.length ? p.branches : [
      { key: 'noref', label: '文字 / 首尾帧支路', when: 'noref' },
      { key: 'ref', label: '参考图 / 参考视频支路', when: 'ref' }
    ];
    out.defaultTier = p.defaultTier || Object.keys(p.tiers || {})[0] || '';
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 扫描 / 选择
 * ------------------------------------------------------------------ */

/** 扫描内置 + 用户目录；用户同名覆盖内置；坏配置只记错误不炸 */
function scan(force) {
  if (_cache && !force) return _cache;
  const byId = {};
  const errors = [];
  /** 内置目录声明的默认方案（按用途）—— 与「用户是否覆盖了它」无关 */
  const builtinDefaults = {};

  for (const f of listByExt(BUILTIN_DIR, /\.json$/i)) {
    const o = readJsonFile(f);
    if (o.__err) { errors.push({ file: f, source: 'builtin', message: o.__err }); continue; }
    const errs = validate(o);
    if (errs.length) { errors.push({ file: f, source: 'builtin', id: o.id || '', message: errs.join('；') }); continue; }
    byId[o.id] = { profile: normalize(o), source: 'builtin', file: f };
    if (o.default && KINDS.includes(o.kind) && !builtinDefaults[o.kind]) builtinDefaults[o.kind] = o.id;
  }

  for (const f of listByExt(userDir(), /\.json$/i)) {
    const o = readJsonFile(f);
    if (o.__err) { errors.push({ file: f, source: 'user', message: o.__err }); continue; }
    const errs = validate(o);
    if (errs.length) {
      // 用户改坏了：报出来，但继续用内置那份（绝不能因为一个错字就让软件不可用）
      errors.push({ file: f, source: 'user', id: o.id || '', message: errs.join('；') });
      continue;
    }
    byId[o.id] = { profile: normalize(o), source: 'user', file: f };
  }

  if (!Object.keys(byId).length) errors.push({ file: BUILTIN_DIR, source: 'builtin', message: '一个可用的内置方案都没有（安装包不完整？）' });
  _cache = { byId, errors, builtinDefaults };
  return _cache;
}

/** 某用途的默认方案：内置声明的那个 → 用户标了 default 的 → 该用途的第一个 */
function defaultId(kind) {
  const { byId, builtinDefaults } = scan();
  const ids = Object.keys(byId).filter(id => byId[id].profile.kind === kind);
  // 🔴 内置声明的默认方案优先，且**不因用户覆写它的配置而改变** ——
  //    否则用户改一下 zimage-turbo.json，默认生图方案就漂移到 SDXL 去了。
  const bd = builtinDefaults[kind];
  if (bd && ids.includes(bd)) return bd;
  return ids.find(id => byId[id].profile.default) || ids[0] || '';
}

/** 某用途当前激活的方案 id（设置非法 / 被删 / 指向别的用途 → 回默认） */
function activeId(kind) {
  const { byId } = scan();
  let v = '';
  try { v = String(db.getSetting(SETTING[kind]) || '').trim(); } catch (_) { v = ''; }
  if (!v && LEGACY_SETTING[kind]) {
    try { v = String(db.getSetting(LEGACY_SETTING[kind]) || '').trim(); } catch (_) { v = ''; }
  }
  if (v && byId[v] && byId[v].profile.kind === kind) return v;
  return defaultId(kind);
}

/** 某用途当前生效的方案对象（拿不到返回 null） */
function active(kind) {
  const id = activeId(kind);
  const { byId } = scan();
  return (id && byId[id]) ? byId[id].profile : null;
}

/** 按 id 取方案（拿不到返回 null） */
function get(id) {
  const { byId } = scan();
  return (id && byId[id]) ? byId[id].profile : null;
}

/** 某用途的全部方案对象（不传 kind = 全部） */
function all(kind) {
  const { byId } = scan();
  return Object.values(byId)
    .filter(e => !kind || e.profile.kind === kind)
    .sort((a, b) => (a.profile.kind === b.profile.kind ? 0 : a.profile.kind.localeCompare(b.profile.kind)))
    .map(e => e.profile);
}

/** 全部方案（给设置页下拉）：按用途过滤，带激活标记与来源 */
function list(kind) {
  const { byId, errors } = scan();
  const activeById = {};
  for (const k of KINDS) activeById[k] = activeId(k);
  const items = Object.values(byId)
    .filter(e => !kind || e.profile.kind === kind)
    .map(e => ({
      id: e.profile.id, kind: e.profile.kind, label: e.profile.label,
      desc: e.profile.desc || '', source: e.source,
      capabilities: e.profile.capabilities || {},
      // 该方案声明的提示词规范文件（{逻辑名: 文件名}）——渲染层按它决定这个模型用哪份规范，
      // 例如视频方案 h3 声明 { base: 'h3.md', ref: 'h3ref.md' }，ltx25 声明 { base: 'ltx.md' }。
      promptFiles: (e.profile.prompt && e.profile.prompt.files) || {},
      // 该方案声明「追加到哪些通用规范后面」的模型专属规范：{ 通用规范名: [文件名] }
      // 提示词配置中心用它显示「这份 model-*.md 到底被哪个方案用着」（不然一堆死文件分不清）
      promptAppend: (e.profile.prompt && e.profile.prompt.append) || {},
      active: e.profile.id === activeById[e.profile.kind]
    }))
    .sort((a, b) => (a.kind === b.kind ? (b.active - a.active) || a.label.localeCompare(b.label, 'zh') : a.kind.localeCompare(b.kind)));
  return { items, errors };
}

/** 切换某用途的方案 */
function set(kind, id) {
  if (!KINDS.includes(kind)) throw new Error('未知用途：' + kind);
  const { byId } = scan();
  const e = byId[id];
  if (!e) throw new Error('没有这个模型方案：' + id);
  if (e.profile.kind !== kind) {
    throw new Error(`「${id}」是${KIND_LABEL[e.profile.kind]}方案，不能当成${KIND_LABEL[kind]}方案使用`);
  }
  db.setSetting(SETTING[kind], id);
  return list();
}

/** 清缓存（用户在工作区放了新方案 / 改了配置后调用） */
function reload() {
  _cache = null;
  return list();
}

/** 当前所有方案的校验错误（设置页要显示「你改的配置有问题，现在用的是内置版」） */
function errors() { return scan().errors; }

/* ------------------------------------------------------------------ *
 * 提示词规范文件
 * ------------------------------------------------------------------ */

/**
 * 某用途当前方案要用 / 追加的提示词规范文件。
 * 返回 { files: {逻辑名: 文件名}, append: {逻辑名: [文件名]}, sources: {文件名: 绝对路径} }
 * 文件查找顺序：<项目>/prompts/model/ → electron/profiles/prompts/
 */
function promptPlan(kind) {
  const p = active(kind);
  const plan = { files: {}, append: {}, sources: {} };
  if (!p || !p.prompt || typeof p.prompt !== 'object') return plan;
  if (p.prompt.files && typeof p.prompt.files === 'object') plan.files = { ...p.prompt.files };
  if (p.prompt.append && typeof p.prompt.append === 'object') {
    for (const [k, v] of Object.entries(p.prompt.append)) {
      plan.append[k] = Array.isArray(v) ? v.slice() : [v];
    }
  }
  for (const name of extraNames()) plan.sources[name] = extraPath(name) || '';
  return plan;
}

/** 附加规范文件（electron/profiles/prompts/*.md + 项目覆盖）的清单 */
function extraNames(projectRoot) {
  const out = new Set();
  for (const f of listByExt(path.join(BUILTIN_DIR, PROMPT_SUBDIR), /\.md$/i)) out.add(path.basename(f));
  const ud = userPromptDir(projectRoot);
  if (ud) for (const f of listByExt(ud, /\.md$/i)) out.add(path.basename(f));
  return [...out].sort();
}

/** 附加规范文件的实际路径（项目版优先） */
function extraPath(name, projectRoot) {
  const base = path.basename(String(name || ''));
  if (!base) return '';
  const ud = userPromptDir(projectRoot);
  if (ud) {
    const u = path.join(ud, base);
    if (fs.existsSync(u)) return u;
  }
  const b = path.join(BUILTIN_DIR, PROMPT_SUBDIR, base);
  return fs.existsSync(b) ? b : '';
}

/** 读一份附加规范（拿不到返回 ''） */
function readExtra(name, projectRoot) {
  const p = extraPath(name, projectRoot);
  if (!p) return '';
  try { return fs.readFileSync(p, 'utf-8'); } catch (_) { return ''; }
}

/**
 * 附加规范清单（提示词配置中心用）：[{ name, user, size, mtimeMs }]
 * user=true 表示项目里有一份同名覆盖（= 用户改过），false 表示用的是内置那份。
 */
function extraList(projectRoot) {
  const ud = userPromptDir(projectRoot);
  const out = [];
  for (const name of extraNames(projectRoot)) {
    const p = extraPath(name, projectRoot);
    let size = 0, mtimeMs = 0;
    try { const st = fs.statSync(p); size = st.size; mtimeMs = st.mtimeMs; } catch (_) {}
    out.push({ name, user: !!(ud && fs.existsSync(path.join(ud, name))), size, mtimeMs });
  }
  return out;
}

/**
 * 写一份项目覆盖（<项目>/prompts/model/<name>）—— 保存后必须让渲染层 clearPromptExtras()，
 * 否则那份「模型专属规范正文」的缓存还在，改了半天不生效。
 * 只允许 <basename>.md：这条路径直接来自界面，必须挡路径穿越。
 */
function saveExtra(name, content, projectRoot) {
  const base = path.basename(String(name || ''));
  if (!/^[A-Za-z0-9_.-]{1,60}\.md$/i.test(base)) throw new Error('非法的规范文件名：' + name);
  const ud = userPromptDir(projectRoot);
  if (!ud) throw new Error('还没有选择项目，无法保存模型专属规范');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, base), String(content == null ? '' : content), 'utf-8');
  return true;
}

/** 删掉用户覆盖（= 恢复内置版） */
function clearExtra(name, projectRoot) {
  const base = path.basename(String(name || ''));
  const ud = userPromptDir(projectRoot);
  if (!ud || !base) return false;
  try { fs.rmSync(path.join(ud, base), { force: true }); } catch (_) { return false; }
  return true;
}

/**
 * 各用途当前方案「要追加的模型专属规范」的正文，一次读全交给渲染层拼装。
 * 返回 { image: { 规范文件名: [正文…] }, video: {…} }。
 * 渲染层 composeSystem 在读完通用规范后，把这里对应的正文接在同名规范之后下发 ——
 * 于是「换生图模型」这件事的提示词部分也变成只改配置。
 */
function promptExtras(projectRoot) {
  const out = {};
  for (const kind of KINDS) {
    const plan = promptPlan(kind);
    const m = {};
    for (const [name, files] of Object.entries(plan.append)) {
      const texts = [];
      for (const f of files) {
        const t = readExtra(f, projectRoot);
        if (t) texts.push(t);
      }
      if (texts.length) m[name] = texts;
    }
    out[kind] = m;
  }
  return out;
}

function init(dbRef) {
  db = dbRef;
  scan(true);
}

module.exports = {
  init, scan, reload, errors,
  validate, normalize,
  list, get, all, set, active, activeId, defaultId,
  promptPlan, promptExtras, extraNames, extraPath, readExtra,
  extraList, saveExtra, clearExtra,
  BUILTIN_DIR, PROMPT_SUBDIR, MODEL_SUBDIR, KINDS, SETTING, KIND_LABEL,
  userDir, userPromptDir
};
