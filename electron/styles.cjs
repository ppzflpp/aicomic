'use strict';
/**
 * 风格体系（2026-10-08 四轴 + 语义槽位改造）—— 「换风格只写一个文件，不改别的」的收口点。
 *
 * 演进：最早把「古风真人实拍」写死在规范正文与示例行里 → 只能做古装剧；
 * 第二版拆成三轴，但**轴之间靠手写矩阵拼**（render 引 {{S.p_*}}，每个 world 文件为每个
 * 画风族各写一份 phrases）—— 加一个画风族要回头改 N 个世界文件，加一个轴就变成 M×N×K。
 * 这一版把「轴之间怎么拼」变成**声明式槽位契约**：
 *
 *   画面风格 render —— 画面长什么样（真人实拍 / 二次元 / 3D）  ← 提供**组合模板** + 纯画风词
 *   世界设定 world  —— 故事发生在哪个时代（古装 / 现代都市 / 民国 / 未来） ← 提供 w_* 事实槽位
 *   内容体裁 genre  —— 片子是什么形态（剧集 / 广告）          ← 只改**结构**，不改词汇
 *   制作调性 tone   —— 拍成什么档次（电影感 / 商业广告大片 / 纪实 / 时尚杂志） ← 提供 t_* 调性槽位
 *
 * 于是「真人实拍 + 现代都市 + 广告 + 商业广告大片」= 一个组合 id
 * `live-action:modern:ad:commercial`（三段写法 `render:world:genre` 仍接受，tone 取默认）。
 *
 * 🔴 槽位契约（SLOT_SPEC）是这一版的核心：
 *   - 每个轴只负责自己那一组槽位（w_* / t_* / render 的模板），轴之间**互不写对方的文件**；
 *   - render 的模板引用 `{{S.w_*}}` 与 `{{S.t_*}}`：**世界侧连词序都能用模板表达**
 *     （古装写 `{{S.renderWho}}{{S.w_noun}}`、现代写 `{{S.w_full}}{{S.renderWho}}`），
 *     所以新增画风族**不需要碰任何世界文件**，新增世界也**不需要碰画风文件**；
 *   - 扫描期做**完备性自检**：哪一轴少给了它该给的槽位，errors() 当场指名报错
 *     （不再"悄悄回落到古风文案"，那是用户看不见的假成功）。
 *
 * 目录（内置 electron/styles/ ← 项目 <项目>/styles/ 同名覆盖）：
 *   base.json                    兜底变量表（= 改造前古风的原文，逐字保留）
 *   axes/render/<id>.json[.md]   画风族：纯画风词 + **组合模板**（引用 w_* / t_* 槽位）
 *   axes/world/<id>.json[.md]    世界：w_* 事实槽位（含名词、材质、举例替换表）
 *   axes/genre/<id>.json[.md]    体裁：结构要求（追加说明为主）
 *   axes/tone/<id>.json[.md]     调性：t_* 调性槽位（光影 / 调色 / 构图守则 / 英文调性词）
 *   presets/<id>.json            预置组合：给一个四元组起名（向后兼容老的项目 style 值）
 *   <id>/style.json              老版单层风格包（仍支持，当作「只有变量覆写的预置」）
 *
 * 🔴 四条硬规则（都是被坑出来的）：
 *   1) **不静默回落**。项目存的风格取不到 → 保留原 id 不动、把原因放进 resolved.reason，
 *      由界面显式报出来。老实现是 `get()` 悄悄给古风包，结果用户以为在用现代风格、
 *      实际出的是古风片，而全项目没有任何地方会告诉他。
 *   2) **兜底而不是拒绝**。合成以 base.json 打底，所以缺任何一个非核心键都不会把整包判死
 *      （老实现是 REQUIRED_VARS 全有或全无 —— 加第 36 个键会让所有存量包集体失效）。
 *   3) **槽位缺失要指名报错**。某一轴少给自己该给的槽位 = 这个组合根本不成立，
 *      必须写进 errors() 并说清是哪个轴、缺哪个键 —— 而不是留一条用户看不见的 warning。
 *   4) **替换只发生在内存里**（渲染层 src/prompts.js 的 readPrompt）—— 项目 prompts/ 下的
 *      磁盘副本永远不含替换结果，于是 prompts.cjs 的 rev 播种机制不受影响，
 *      用户手改的规范也不会被污染。
 */
const fs = require('fs');
const path = require('path');

/** 内置风格目录（随包发布，只读） */
const BUILTIN_DIR = path.join(__dirname, 'styles');
/** 绘制层找不到风格时的兜底预置（= 改造前唯一风格） */
const DEFAULT_ID = 'guofeng-real';
/** 四轴默认值（= 改造前唯一风格：真人实拍 + 古装 + 剧集 + 电影感） */
const DEFAULT_AXES = { render: 'live-action', world: 'guofeng', genre: 'story', tone: 'cinematic' };
const AXIS_NAMES = ['render', 'world', 'genre', 'tone'];
const AXIS_LABEL = { render: '画面风格', world: '世界设定', genre: '内容体裁', tone: '制作调性' };

/**
 * 规范正文里用到的全部风格键（10 份 md 里的 {{S.x}}，外加程序要用的 equipStrip）
 * —— 合成结果必须把这 49 个键都填满。少一个，规范里就会留下裸占位符，
 * 渲染层的闸门会当场抛错（静默出废片比报错难查得多）。
 * 49 = 改造前就有的 35 个 + 调性层 3 个（lightAdd / colorGrade / sceneCompRule）
 *      + 世界举例别名 9 个（exFabric … exLeak）+ 器材剥除表 1 个（equipStrip）
 *      + 画风族英文反画风词表 1 个（antiRenderWordsEn）。
 */
const REQUIRED_VARS = [
  'styleName', 'dramaLabel', 'worldShort', 'worldRule', 'charRefKind', 'sceneRefKind',
  'styleCore', 'styleCoreName', 'styleFeel',
  'startChar', 'endChar', 'endCharFilm', 'actorShot', 'costume', 'costumeNpc',
  'startScene', 'startSceneAlt', 'endScene', 'endSceneFilm', 'keeper',
  'materialSamples', 'placeSamples', 'lightSamples',
  'antiStyleWords', 'antiStyleWordsCn', 'lightMain', 'extraExclude',
  // 画风族的英文反画风词表（视频侧规范直接引它，见 h3.md / h3ref.md / ltx.md）
  'antiRenderWordsEn',
  'worldTerms', 'roleExamples', 'lookTable',
  'enShotSample', 'enStyleWords', 'enStyleSentence', 'enLtxSample', 'enStyleWordsShort',
  // 制作调性（tone）注入规范的光影 / 调色 / 构图守则
  'lightAdd', 'colorGrade', 'sceneCompRule',
  // 「世界」提供的题材举例替换槽位 —— 规范正文里零硬编码题材词，举例一律由世界给
  'exFabric', 'exProp', 'exSign', 'exText', 'exAnchor', 'exPalette', 'exWardrobe', 'exState', 'exLeak',
  // 程序用（不在 md 里当占位符）：画风族声明「哪些词必须从正向提示词里剥掉」
  'equipStrip'
];

/**
 * 核心键 —— 缺了直接判这个包不合格（拒绝装载）。
 * 其余键缺失只走 base 兜底并记 warning：这样**以后新增规范键**（要往 REQUIRED_VARS 里加）
 * 不会让所有存量风格包集体失效，也不会让用户自建的包一夜之间变成古风。
 */
const CORE_VARS = [
  'styleName', 'worldShort', 'worldRule', 'styleCore',
  'startChar', 'endChar', 'startScene', 'endScene', 'keeper',
  'antiStyleWords', 'lightMain', 'lookTable', 'enStyleSentence'
];

/**
 * 调性层（tone）负责的规范键 —— 只有这 3 个不由画风族提供：
 * 它们是「拍成什么档次」的事实（光影要求 / 调色 / 构图守则），画风族不该写死。
 */
const TONE_VARS = ['lightAdd', 'colorGrade', 'sceneCompRule'];

/**
 * 🔴 槽位契约（SLOT_SPEC）—— 每个轴**必须**提供的槽位键。
 *   这是「新增任一轴值只写自己的一个文件」这条不变量的执行机制：
 *   扫描期逐轴检查，缺一个就写进 errors() 并指名道姓，绝不静默回落。
 *
 *   render：纯画风词 + 世界举例别名 + **全部规范键的组合模板**
 *           （正文里那 46 个不带调的键，画风族必须逐个写成 {{S.w_*}} / {{S.t_*}} 模板。
 *            少写一个，那个键就会悄悄回落成 base.json 里的古风原文 —— 这正是要杀掉的失败模式：
 *            用户以为「换了二次元画风」，出片却是古风实拍）
 *   world ：题材事实（w_subjectStart / w_subjectEnd 这类是**词序模板**，可含 {{S.renderWho}}）
 *   tone  ：制作档次与调性（t_tex 是质感核心词，直接进 styleCore）
 *
 *   render 的槽位里还有一组 **别名**（exFabric / exProp / … / exLeak）：规范正文里写的是
 *   `{{S.exProp}}` 这种不带世界前缀的键，由 render 别名到某个世界的 `w_ex*`。
 *   这样正文才能做到「零硬编码题材举例」—— 举例永远来自当前世界，换世界不用碰正文。
 */
const SLOT_SPEC = {
  render: [
    // 纯画风词：只被模板引用，不直接进规范正文
    'renderWho', 'renderActor', 'renderMedium', 'renderMediumScene',
    'realismPrefix', 'filmWord',
    'antiRenderWords', 'antiRenderWordsCn',
    'enPhotoreal', 'enPhotorealLC', 'renderEnWho',
    // 「规范正文举例 → 世界举例槽位」的别名（正文只认这 9 个名字）
    'exFabric', 'exProp', 'exSign', 'exText', 'exAnchor',
    'exPalette', 'exWardrobe', 'exState', 'exLeak',
    // 规范正文要的全部键（调性层负责的 3 个除外）—— 必须逐个写成组合模板
    ...REQUIRED_VARS.filter(k => TONE_VARS.indexOf(k) < 0)
  ],
  world: [
    'w_noun', 'w_full', 'w_styleHead', 'w_subjectStart', 'w_subjectEnd', 'w_actorWorld',
    'w_worldRule', 'w_sceneStart', 'w_sceneKind', 'w_sceneRef', 'w_sceneEnd', 'w_keeper',
    'w_costume', 'w_costumeNpc', 'w_material', 'w_place', 'w_light', 'w_lightMain',
    'w_terms', 'w_roleExamples', 'w_lookTable',
    'w_excludeWorld', 'w_antiWorld', 'w_antiWorldCn',
    'w_enEra', 'w_enLight', 'w_enLtxScene',
    'w_exFabric', 'w_exProp', 'w_exSign', 'w_exText', 'w_exAnchor', 'w_exPalette',
    'w_exWardrobe', 'w_exState', 'w_exLeak'
  ],
  genre: [],
  tone: [
    't_core', 't_tex', 't_feel',
    'lightAdd', 'colorGrade', 'sceneCompRule',
    't_enGrade', 't_enLook'
  ]
};

/**
 * 🔴 允许为空的槽位 —— 这些键的「正确取值」本身就是空串（例如古装世界没有要排除的
 *    本时代词），所以完备性检查只要求**键被声明**，不要求非空。
 *    它们只被别的模板引用（不直接进规范正文），空串替换后不会留下裸占位符。
 */
const SLOT_ALLOW_EMPTY = new Set(['w_antiWorld', 'w_antiWorldCn']);

/** 一份轴自带说明默认追加到哪些规范之后 */
const APPEND_DEFAULT = [
  'chars.md', 'scenes.md', 'shots.md', 'promptgen.md', 'profile.md',
  'h3.md', 'h3ref.md', 'ltx.md'
];

/** 变量值里的 `{{S.x}}`（画风族的组合模板用它引用世界提供的事实） */
const TEMPLATE_RE = /\{\{\s*S\.([A-Za-z0-9_]+)\s*\}\}/g;
/** 🔴 查残留必须用**不带 g** 的正则：带 g 的 test() 会记住 lastIndex，循环里会隔一个漏一个 */
const TEMPLATE_PROBE = /\{\{\s*S\.[A-Za-z0-9_]+\s*\}\}/;
/** 模板最多解几轮（A 引用 B、B 引用 C 这种链）—— 同时兼作成环保护 */
const TEMPLATE_ROUNDS = 6;
/** 模板解析后的总长度上限（防止手写的互相引用把字符串指数放大） */
const TEMPLATE_SIZE_CAP = 400000;

/**
 * 扫描缓存：key = 项目根目录（'' = 只用内置）→ 扫描结果 { base, axes, presets, errors, warnings }。
 * 🔴 必须是**按项目**的 Map，不能是单例：风格覆盖是项目级的，两个项目各有各的覆盖目录，
 *    用一份缓存必然串味（改了这个项目的词表、那个项目的出图跟着变）。
 */
const _cacheMap = new Map();

/* ------------------------------------------------------------------ *
 * 目录
 * ------------------------------------------------------------------ */

/**
 * 项目级风格目录（<项目>/styles/）—— 想改内置风格就在项目里放一份同名文件覆盖。
 * 🔴 2026-10-07 改造：原先读 workspace/styles/（工作区级，一份覆盖管所有项目），
 *    已下沉到项目 —— 换题材词只影响它所属的那部片子。**工作区目录不再读取。**
 * 没给 projectRoot（新建项目弹窗、设置页这类「还不知道哪个项目」的场景）→ 返回 ''，纯用内置。
 */
function userDir(projectRoot) {
  const r = s(projectRoot).trim();
  return r ? path.join(r, 'styles') : '';
}

/* ------------------------------------------------------------------ *
 * 读取小工具
 * ------------------------------------------------------------------ */

function readJsonFile(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
function readText(p) { try { return fs.readFileSync(p, 'utf-8'); } catch (_) { return ''; } }
function s(v) { return v == null ? '' : String(v); }
function basenames(arr) {
  return (Array.isArray(arr) ? arr : []).map(x => path.basename(s(x))).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

/**
 * 校验一个「老版单层风格包」（<id>/style.json 或用户自建的全量包）。
 * 通过返回 ''，不通过返回原因（中文，给界面看）。
 * 🔴 只按 CORE_VARS 判死：非核心键缺失交给 base 兜底 + 记 warning。
 */
function validate(o, dirName) {
  if (!o || typeof o !== 'object') return '不是一个 JSON 对象';
  if (String(o.id || '') !== dirName) return 'id 与目录名不一致（目录 ' + dirName + '，id ' + (o.id || '空') + '）';
  if (!s(o.name).trim()) return '缺少 name';
  const v = o.vars;
  if (!v || typeof v !== 'object') return '缺少 vars';
  const miss = CORE_VARS.filter(k => !Object.prototype.hasOwnProperty.call(v, k) || !s(v[k]).trim());
  if (miss.length) return '核心变量缺失 ' + miss.length + ' 个：' + miss.slice(0, 6).join(', ') + (miss.length > 6 ? ' …' : '');
  return '';
}

/** 校验一个轴文件（渲染 / 世界 / 体裁 / 调性各一份，只写自己那组槽位） */
function validateAxis(o, dirName, axis) {
  if (!o || typeof o !== 'object') return '不是一个 JSON 对象';
  if (String(o.id || '') !== dirName) return 'id 与文件名不一致（文件 ' + dirName + '，id ' + (o.id || '空') + '）';
  if (!s(o.label).trim()) return '缺少 label（界面下拉要显示）';
  if (o.vars != null && typeof o.vars !== 'object') return 'vars 不是一个对象';
  // 🔴 2026-10-08：phrases（世界为每个画风族手写措辞的 M×N 矩阵）已废弃 ——
  //    世界改为提供 w_* 槽位（词序也能用模板表达），画风族只写模板。
  //    老文件里若还留着 phrases 不报错（忽略即可），但新写的轴不要再用它。
  if (o.phrases != null && axis !== 'world') return 'phrases 只有「世界」曾经用过，且已废弃 —— 请改用 w_* 槽位';
  return '';
}

/** 校验一个预置组合 */
function validatePreset(o, dirName) {
  if (!o || typeof o !== 'object') return '不是一个 JSON 对象';
  if (String(o.id || '') !== dirName) return 'id 与文件名不一致（文件 ' + dirName + '，id ' + (o.id || '空') + '）';
  if (!s(o.name).trim()) return '缺少 name（界面下拉要显示）';
  if (o.vars != null && typeof o.vars !== 'object') return 'vars 不是一个对象';
  // 四轴里 render / world / genre 必填；tone 可省（省了取默认调性，老预置不用改）
  const need = ['render', 'world', 'genre'].some(k => !s(o[k]).trim());
  if (need && !s(o.extends).trim()) return '缺少 render / world / genre（tone 可省；或声明 extends 继承一个已有预置）';
  return '';
}

/**
 * 轴 / 预置可声明「本项目该读哪些规范文件」，形状 `prompt.files`：
 *
 *   { "逻辑规范名": ["真实文件名", ...] }
 *
 * 键 = 代码里认的**逻辑规范名**（adapt.md / shots.md / profile.md…）；
 * 值 = **这个项目实际要读的文件清单**（按序拼接）。
 *
 * 🔴 为什么用「逻辑名 → 文件清单」这张表：它让同一套机制同时表达两种意图，
 *    不需要再分「替换」与「追加」两个字段 ——
 *      · 写一份（["adapt-ad.md"]）   → 整份替换：体裁与基规范**规则互斥**时用。
 *        广告改编与小说改编对「镜头语言」「人物命名」的要求正好相反，追加只会让模型
 *        收到两条打架的指令（实测就是模型拒答的直接原因），必须整份换掉。
 *      · 写两份（["shots.md","shots-ad.md"]）→ 基座 + 体裁增量：**JSON 契约全片共用**时用。
 *        分镜的输出格式是程序解析依据，换成两份不同契约等于给自己埋雷，只能加不能换。
 *    ⇒ 「新增一个体裁 = 只写自己那几个文件、零代码改动」这条不变量，就靠它成立。
 *
 * 🔴 安全：这张表的值会**直接变成磁盘读取路径**。只接受「无路径分隔符的 .md 文件名」，
 *    不挡住 ../ 就等于把机器上任意文件读进提示词。形状不合法的项直接丢掉（不报错），
 *    免得一个手滑的轴文件把整个风格包判死 —— 真读不到文件时，渲染层会指名报错。
 */
function normFiles(o) {
  const src = o && o.prompt && o.prompt.files;
  if (!src || typeof src !== 'object') return null;
  const out = Object.create(null);
  for (const [k, v] of Object.entries(src)) {
    if (!/^[A-Za-z0-9_]+\.md$/.test(k)) continue;
    const list = (Array.isArray(v) ? v : [v])
      .map(x => s(x))
      .filter(x => /^[A-Za-z0-9_-]+\.md$/.test(x));
    if (list.length) out[k] = list;
  }
  return Object.keys(out).length ? out : null;
}

/* ------------------------------------------------------------------ *
 * 扫描：内置 → 用户同名覆盖
 * ------------------------------------------------------------------ */

function loadBase(dir, source, into, errors) {
  const p = path.join(dir, 'base.json');
  if (!fs.existsSync(p)) return;
  let o = null;
  try { o = readJsonFile(p); }
  catch (e) { errors.push(source + ' / base.json：读不进来（' + String((e && e.message) || e) + '）'); return; }
  if (!o || typeof o.vars !== 'object') { errors.push(source + ' / base.json：缺少 vars'); return; }
  for (const k of CORE_VARS) {
    if (!s(o.vars[k]).trim()) {
      errors.push(source + ' / base.json：核心兜底值 ' + k + ' 缺失或为空 —— 已忽略这一项（继续用内置值）');
      continue;
    }
    into[k] = s(o.vars[k]);
  }
  // 非核心键也照收（不是核心就允许覆盖成空？不 —— 空值等于没兜底，忽略）
  for (const [k, v] of Object.entries(o.vars)) {
    if (!s(v).trim()) continue;
    into[k] = s(v);
  }
}

function loadAxisDir(dir, axis, source, into, errors) {
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch (_) { return; }
  for (const fn of names) {
    if (!fn.endsWith('.json')) continue;
    const id = fn.slice(0, -5);
    const full = path.join(dir, fn);
    let o = null;
    try { o = readJsonFile(full); }
    catch (e) { errors.push(source + ' / ' + AXIS_LABEL[axis] + ' ' + id + '：读不进来（' + String((e && e.message) || e) + '）'); continue; }
    const bad = validateAxis(o, id, axis);
    if (bad) { errors.push(source + ' / ' + AXIS_LABEL[axis] + ' ' + id + '：' + bad); continue; }
    into[axis][id] = {
      id, axis, label: s(o.label), desc: s(o.desc),
      order: Number(o.order == null ? 50 : o.order),
      vars: (o.vars && typeof o.vars === 'object') ? { ...o.vars } : {},
      phrases: (o.phrases && typeof o.phrases === 'object') ? o.phrases : null,
      append: Array.isArray(o.append) ? basenames(o.append) : null,
      files: normFiles(o),
      text: readText(path.join(dir, id + '.md')),
      note: s(o._note), source, dir
    };
  }
}

function loadPresetDir(dir, source, into, errors) {
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch (_) { return; }
  for (const fn of names) {
    if (!fn.endsWith('.json')) continue;
    const id = fn.slice(0, -5);
    let o = null;
    try { o = readJsonFile(path.join(dir, fn)); }
    catch (e) { errors.push(source + ' / 预置 ' + id + '：读不进来（' + String((e && e.message) || e) + '）'); continue; }
    const bad = validatePreset(o, id);
    if (bad) { errors.push(source + ' / 预置 ' + id + '：' + bad); continue; }
    into[id] = {
      id,
      name: s(o.name), desc: s(o.desc), rev: Number(o.rev || 0),
      tags: (o.tags && typeof o.tags === 'object') ? o.tags : {},
      render: s(o.render) || null, world: s(o.world) || null,
      genre: s(o.genre) || null, tone: s(o.tone) || null,
      extends: s(o.extends) || null,
      vars: (o.vars && typeof o.vars === 'object') ? { ...o.vars } : {},
      append: Array.isArray(o.append) ? basenames(o.append) : null,
      files: normFiles(o),
      text: readText(path.join(dir, id + '.md')),
      source
    };
  }
}

/** 老版单层风格包：<项目>/styles/<id>/style.json（+ style.md）。当作「只有变量覆写的预置」 */
function loadLegacyDir(dir, source, into, errors) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'axes' || e.name === 'presets') continue;
    const full = path.join(dir, e.name, 'style.json');
    if (!fs.existsSync(full)) continue;
    let o = null;
    try { o = readJsonFile(full); }
    catch (err) { errors.push(source + ' / ' + e.name + '：style.json 读不进来（' + String((err && err.message) || err) + '）'); continue; }
    const bad = validate(o, e.name);
    if (bad) {
      // 老包判不合格不再静默使用内置同名包 —— 明确报出来（这是老实现最容易坑人的地方）
      errors.push(source + ' / 风格包 ' + e.name + '：' + bad + ' —— 该风格不可用，请补齐或删除它');
      continue;
    }
    into[e.name] = {
      id: e.name,
      name: s(o.name), desc: s(o.desc), rev: Number(o.rev || 0),
      tags: (o.tags && typeof o.tags === 'object') ? o.tags : {},
      render: s(o.render) || null, world: s(o.world) || null,
      genre: s(o.genre) || null, tone: s(o.tone) || null,
      extends: s(o.extends) || null,
      vars: { ...o.vars },
      append: Array.isArray(o.append) ? basenames(o.append) : null,
      files: normFiles(o),
      text: readText(path.join(dir, e.name, 'style.md')),
      legacy: true,
      source
    };
  }
}

function scan(projectRoot) {
  const key = s(projectRoot).trim();
  const hit = _cacheMap.get(key);
  if (hit) return hit;
  const axes = { render: Object.create(null), world: Object.create(null), genre: Object.create(null), tone: Object.create(null) };
  const presets = Object.create(null);
  const errors = [];
  const warnings = [];

  // ① 内置兜底表（永远先装，用户那份只在核心键上覆盖）
  const base = Object.create(null);
  loadBase(BUILTIN_DIR, 'builtin', base, errors);

  // ② 内置三轴 + 预置
  for (const ax of AXIS_NAMES) loadAxisDir(path.join(BUILTIN_DIR, 'axes', ax), ax, 'builtin', axes, errors);
  loadPresetDir(path.join(BUILTIN_DIR, 'presets'), 'builtin', presets, errors);

  // ③ 项目覆盖目录（同名覆盖内置）—— 没给项目根就用纯内置
  const ud = userDir(key);
  if (ud) {
    loadBase(ud, 'user', base, errors);
    for (const ax of AXIS_NAMES) loadAxisDir(path.join(ud, 'axes', ax), ax, 'user', axes, errors);
    loadPresetDir(path.join(ud, 'presets'), 'user', presets, errors);
    loadLegacyDir(ud, 'user', presets, errors);
  }

  if (!Object.keys(presets).length) errors.push('没有扫描到任何预置组合（electron/styles/presets/ 是否丢了？）');

  const c = { base, axes, presets, errors, warnings, checked: false };
  // 🔴 必须先入缓存再做交叉检查：checkCross 会回头调 resolveId → scan(projectRoot)，
  //    此刻若还没登记，就会重新构建 → 再 checkCross → 无限递归（原实现靠"先赋值后检查"绕开）。
  _cacheMap.set(key, c);
  // 预置 / 世界短语的可解析性检查（把「以后加画风族忘补短语」这种错推到扫描时就说清楚）
  checkCross(c, key);
  c.checked = true;
  return c;
}

/**
 * 扫描一次后的交叉检查 —— 这就是「完备性自检」（判据③）：
 *   ① 每个预置能不能解析成四轴；
 *   ② 🔴 每个轴值有没有给齐**它这一轴该给的槽位**（SLOT_SPEC）。
 *      少了 → 直接进 errors() 并指名「哪个轴、哪个值、缺哪些键」。
 *      这样「新增画风族忘了声明组合键」「新世界忘了给举例替换表」这类错
 *      在扫描期就报出来，而不是等生成时甩一个裸 {{S.x}} 出去、或悄悄回落成古风文案。
 */
function checkCross(c, projectRoot) {
  for (const id of Object.keys(c.presets)) {
    const r = resolveId(id, projectRoot);
    if (!r.ok) c.errors.push('预置 ' + id + ' 无法解析：' + r.reason);
  }
  for (const ax of AXIS_NAMES) {
    const spec = SLOT_SPEC[ax] || [];
    for (const id of Object.keys(c.axes[ax])) {
      const a = c.axes[ax][id];
      const v = a.vars || {};
      const miss = spec.filter(k => !Object.prototype.hasOwnProperty.call(v, k) ||
        (!SLOT_ALLOW_EMPTY.has(k) && !s(v[k]).trim()));
      if (miss.length) {
        c.errors.push(AXIS_LABEL[ax] + '「' + (a.label || id) + '」（' + (a.source === 'user' ? '项目覆盖' : '内置') +
          '）缺少本轴必须提供的槽位 ' + miss.length + ' 个：' + miss.join('、') +
          ' —— 选到含它的组合时会留下未替换的占位符，请补齐这些键');
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 解析：id → 三轴
 * ------------------------------------------------------------------ */

/**
 * 组合 id → 四轴。
 *   `render:world:genre:tone` → 四段都解析
 *   `render:world:genre`      → 三段（tone 取默认「电影感」，所以老项目存的
 *                                `live-action:modern:story` 不用迁移、行为不变）
 *   其它段数 → null（交给「预置名」那条解析路径）
 */
function parseTriple(id) {
  const parts = s(id).split(':').map(x => x.trim()).filter(Boolean);
  if (parts.length === 4) return { render: parts[0], world: parts[1], genre: parts[2], tone: parts[3] };
  if (parts.length === 3) return { render: parts[0], world: parts[1], genre: parts[2], tone: DEFAULT_AXES.tone };
  return null;
}

function axesExist(c, tri) {
  const bad = [];
  for (const ax of AXIS_NAMES) if (!c.axes[ax][tri[ax]]) bad.push(AXIS_LABEL[ax] + '「' + tri[ax] + '」');
  return bad;
}

/**
 * 把项目存的 style 值解析成三轴。
 * 🔴 解析不了**不回落**：返回 ok:false + reason，由调用方（IPC / 界面）显式告知用户。
 *    同时仍然给出三轴默认值，让调用方能拿到一个「能用的兜底包」而不至于崩。
 */
function resolveId(id, projectRoot) {
  const c = scan(projectRoot);
  const key = s(id).trim();

  const tri = parseTriple(key);
  if (tri) {
    const bad = axesExist(c, tri);
    if (!bad.length) return { ok: true, ...tri, id: key, wanted: key, source: 'triple' };
    return {
      ok: false, ...DEFAULT_AXES, id: key, wanted: key, tried: tri, source: 'triple',
      reason: '组合里有不存在的轴值：' + bad.join('、')
    };
  }

  if (key && c.presets[key]) {
    // extends 链：从最远的祖先往近处叠加（近的优先）
    const chain = [];
    let cur = c.presets[key];
    let guard = 0;
    while (cur) {
      chain.push(cur);
      const pid = cur.extends;
      if (!pid) break;
      if (chain.some(x => x.id === pid)) {
        return { ok: false, ...DEFAULT_AXES, id: key, wanted: key, source: 'preset',
          reason: 'extends 成环：' + chain.map(x => x.id).join(' → ') + ' → ' + pid };
      }
      const parent = c.presets[pid];
      if (!parent) {
        return { ok: false, ...DEFAULT_AXES, id: key, wanted: key, source: 'preset',
          reason: 'extends 指向的风格包不存在：' + pid };
      }
      if (++guard > 8) {
        return { ok: false, ...DEFAULT_AXES, id: key, wanted: key, source: 'preset', reason: 'extends 链过深' };
      }
      cur = parent;
    }
    const tri2 = { ...DEFAULT_AXES };
    for (let i = chain.length - 1; i >= 0; i--) {
      const p = chain[i];
      if (p.render) tri2.render = p.render;
      if (p.world) tri2.world = p.world;
      if (p.genre) tri2.genre = p.genre;
      if (p.tone) tri2.tone = p.tone;
    }
    const bad = axesExist(c, tri2);
    if (!bad.length) {
      return { ok: true, ...tri2, id: key, wanted: key, source: 'preset', chain: chain.map(x => x.id) };
    }
    return { ok: false, ...DEFAULT_AXES, id: key, wanted: key, tried: tri2, source: 'preset',
      reason: '组合里有不存在的轴值：' + bad.join('、') };
  }

  return {
    ok: false, ...DEFAULT_AXES, id: key, wanted: key, source: 'missing',
    reason: key ? ('找不到风格「' + key + '」—— 它可能被删除、改名，或项目里没有这个风格包') : '项目没有设置风格'
  };
}

/* ------------------------------------------------------------------ *
 * 合成
 * ------------------------------------------------------------------ */

/** 一份轴该追加到哪些规范：显式数组照用（空数组 = 一句都不追加）；没给但有说明 → 默认清单 */
function axisAppend(a) {
  if (!a) return [];
  if (Array.isArray(a.append)) return a.append.slice();
  return a.text ? APPEND_DEFAULT.slice() : [];
}

/**
 * 模板解析：变量值里可以有 `{{S.x}}`（画风族的组合模板引用世界提供的事实）。
 * 多轮替换直到不再变化；自引用原样保留（否则会自我膨胀）；总长度超上限就停。
 */
function resolveTemplates(vars, warnings, who) {
  for (let r = 0; r < TEMPLATE_ROUNDS; r++) {
    let changed = false;
    let total = 0;
    for (const k of Object.keys(vars)) {
      const before = s(vars[k]);
      if (!before || before.indexOf('{{') < 0) { total += before.length; continue; }
      const after = before.replace(TEMPLATE_RE, (whole, kk) =>
        (kk !== k && Object.prototype.hasOwnProperty.call(vars, kk)) ? s(vars[kk]) : whole);
      if (after !== before) { vars[k] = after; changed = true; }
      total += after.length;
    }
    if (total > TEMPLATE_SIZE_CAP) {
      warnings.push('风格「' + who + '」的变量模板解析后体积异常（超过 ' + TEMPLATE_SIZE_CAP + ' 字符）—— 可能写成了互相引用，已停止解析');
      break;
    }
    if (!changed) break;
  }
  return vars;
}

/**
 * 合成一个风格包的全部产物。
 * 叠加顺序：base（兜底）→ world（w_* 事实）→ genre（结构）→ render（画风族的组合模板）
 *          → **tone（t_* 调性，最后一道轴）** → 预置链（从远到近）。
 *
 * 🔴 三级轴之间键名基本不重叠（w_* / t_* / render 的模板键），所以这里的顺序只决定
 *    「同名键谁赢」。tone 排在 render 之后是有意的：调性层要能覆盖画风族的
 *    「档次旋钮」（realismPrefix 这类定调词前缀）—— 商业广告片不能用「极其逼真的摄影作品」
 *    这种纪实语域。模板解析是独立一轮（resolveTemplates），所以在哪一层给值都不影响拼装。
 *    world 侧的 `w_subjectStart` 之类**词序模板**同理：它引用 {{S.renderWho}}，
 *    于是「新增画风族不用碰世界文件」—— 这就是替代旧 M×N phrases 矩阵的关键。
 */
function compose(res, projectRoot) {
  const c = scan(projectRoot);
  const warnings = [];
  const vars = Object.create(null);
  for (const [k, v] of Object.entries(c.base)) vars[k] = s(v);

  const provided = new Set();
  const texts = [];
  const appends = [];
  /* 规范文件清单（逻辑名 → 实际读取的文件列表）。叠加顺序与 vars 完全一致：
     远的一层先写、近的一层覆盖 —— 预置链最后取，所以预置能改体裁定的基线。 */
  const files = Object.create(null);

  const claimFiles = (a) => {
    for (const [k, v] of Object.entries((a && a.files) || {})) files[k] = v.slice();
  };

  const applyAxis = (a) => {
    if (!a) return;
    for (const [k, v] of Object.entries(a.vars || {})) { vars[k] = s(v); provided.add(k); }
    if (a.text) texts.push({ name: a.id + '.md', text: a.text, append: axisAppend(a) });
    // 🔴 这里要用 axisAppend 而不是 a.append：轴没显式声明 append 时，默认清单
    //    （APPEND_DEFAULT）必须靠它补上，否则「世界带的说明」根本不会追加到规范后面。
    appends.push(...axisAppend(a));
    claimFiles(a);
  };

  // 先报缺轴（正常路径不会发生：resolveId 已经校验过轴值存在）
  for (const ax of AXIS_NAMES) {
    if (!c.axes[ax][res[ax]]) {
      warnings.push('组合「' + res.id + '」的' + AXIS_LABEL[ax] + '「' + res[ax] + '」不存在 —— 相关文案会带着未替换的占位符');
    }
  }

  applyAxis(c.axes.world[res.world]);
  applyAxis(c.axes.genre[res.genre]);
  applyAxis(c.axes.render[res.render]);
  // 🔴 tone 放在 render **之后**：调性层允许覆盖画风层的「档次旋钮」
  //    （realismPrefix 这种定调词前缀 —— 商业广告片不能说「极其逼真的摄影作品」，
  //     那是纪实语域）。模板解析是独立一轮，所以在哪一层给值都不影响拼装。
  applyAxis(c.axes.tone[res.tone]);

  // 预置链（四轴已在 resolveId 里定好，这里只叠加它们的 vars + 说明）
  for (const pid of (res.chain || [])) {
    const p = c.presets[pid];
    if (!p) continue;
    for (const [k, v] of Object.entries(p.vars || {})) { vars[k] = s(v); provided.add(k); }
    if (p.text) texts.push({ name: pid + '.md', text: p.text, append: axisAppend(p) });
    appends.push(...axisAppend(p));
    claimFiles(p);
  }

  resolveTemplates(vars, warnings, res.id);

  // 抽取规范要的 49 个键；核心键缺失 = 这个包不能用（明确报错，不假装能用）
  const out = Object.create(null);
  const missingCore = [];
  const fellBack = [];
  for (const k of REQUIRED_VARS) {
    let v = s(vars[k]);
    if (!v) {
      // 走到这里只可能是有人显式把它置空了（base 兜底覆盖不到空串）
      v = s(c.base[k]);
      if (v) {
        fellBack.push(k);
        if (CORE_VARS.includes(k)) missingCore.push(k);
      } else {
        missingCore.push(k);
      }
    }
    out[k] = v;
  }
  for (const k of fellBack) {
    warnings.push('风格「' + res.id + '」把变量 ' + k + ' 显式置空了，已回落到兜底值 —— 请检查轴文件里是不是误写成了空串');
  }
  // 四轴一个都没提供的规范键 → 用的是兜底值，必须留痕。
  // 正常情况不该出现：render 的组合模板会把 49 个规范键全部落定。真出现了就说明
  // render 族漏写了某个模板键 —— 那时这些键会悄悄变成兜底里的古风文案，出片才发现就晚了。
  const fromBase = REQUIRED_VARS.filter(k => !provided.has(k));
  if (fromBase.length) {
    warnings.push('风格「' + res.id + '」有 ' + fromBase.length + ' 个变量四轴都没提供，回落到兜底值：' +
      fromBase.slice(0, 6).join('、') + (fromBase.length > 6 ? ' …' : '') +
      ' —— 画风族必须为每一个规范键写组合模板（见 SLOT_SPEC.render 与 base.json 的键清单）');
  }
  if (missingCore.length) {
    warnings.push('风格「' + res.id + '」的核心变量缺失：' + missingCore.join('、') + ' —— 生成时会因未替换的占位符当场报错');
  }
  // 模板没收干净（某一轴少给了槽位）也要说清楚 —— errors() 里已经有更明确的版本
  const leftKeys = REQUIRED_VARS.filter(k => TEMPLATE_PROBE.test(out[k]));
  if (leftKeys.length) {
    warnings.push('风格「' + res.id + '」有 ' + leftKeys.length + ' 个变量仍含未替换占位符（' +
      leftKeys.slice(0, 5).join('、') + (leftKeys.length > 5 ? ' …' : '') +
      '）—— 请查 errors()：那会指名是哪个轴哪个值缺了哪个槽位');
  }

  // append 汇总：三轴各自的目标规范取并集（老契约：composeSystem 用它判断要不要追加说明）
  const append = [];
  for (const a of appends) if (!append.includes(a)) append.push(a);

  return {
    vars: out,
    append,
    files,
    text: texts.map(t => t.text).join('\n\n'),
    warnings,
    parts: texts.map(t => t.name),
    provided: [...provided]
  };
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

function ids(projectRoot) { return Object.keys(scan(projectRoot).presets); }

/** 预置组合清单（默认排最前）。四轴网格用 axes()，这份给「预置」和向后兼容用 */
function list(projectRoot) {
  const c = scan(projectRoot);
  const arr = ids(projectRoot).map(id => {
    const p = c.presets[id];
    return {
      id, name: p.name, desc: p.desc, tags: p.tags, rev: p.rev,
      render: p.render, world: p.world, genre: p.genre, tone: p.tone, source: p.source
    };
  });
  arr.sort((a, b) => {
    if (a.id === DEFAULT_ID) return -1;
    if (b.id === DEFAULT_ID) return 1;
    return s(a.name).localeCompare(s(b.name), 'zh');
  });
  return arr;
}

/** 四轴清单（新建项目 / 项目配置的四组点选卡用）+ 默认值 + 预置 + 错误 */
function axes(projectRoot) {
  const c = scan(projectRoot);
  const grab = (ax) => Object.values(c.axes[ax])
    .sort((a, b) => (a.order - b.order) || s(a.id).localeCompare(s(b.id)))
    .map(a => ({
      id: a.id, label: a.label, desc: a.desc, order: a.order, source: a.source,
      varCount: Object.keys(a.vars || {}).length,
      slots: (SLOT_SPEC[ax] || []).length,
      missingSlots: (SLOT_SPEC[ax] || []).filter(k => {
        const v = (a.vars || {})[k];
        return !Object.prototype.hasOwnProperty.call(a.vars || {}, k) ||
          (!SLOT_ALLOW_EMPTY.has(k) && !s(v).trim());
      }),
      hasText: !!a.text
    }));
  return {
    render: grab('render'), world: grab('world'), genre: grab('genre'), tone: grab('tone'),
    presets: list(projectRoot),
    default: { ...DEFAULT_AXES },
    defaultTriple: tripleId(DEFAULT_AXES),
    labels: { ...AXIS_LABEL }
  };
}

function tripleId(tri) {
  const o = { ...DEFAULT_AXES, ...(tri || {}) };
  return AXIS_NAMES.map(ax => s(o[ax])).join(':');
}

/** 把四轴拼成展示名（没有对应预置时用） */
function tripleName(tri, projectRoot) {
  const c = scan(projectRoot);
  const L = (ax, id) => s((c.axes[ax][id] || {}).label) || id;
  return AXIS_NAMES.map(ax => L(ax, tri[ax])).join(' · ');
}

/**
 * 取一个风格包（渲染层唯一入口）。
 * — 解析成功：`id` = 请求的 id，`resolved.ok = true`
 * — 解析失败：**仍然返回一个可用的兜底包**（否则渲染层会炸），但 `resolved.ok = false`
 *   且 `resolved.reason` 写明原因 —— 调用方必须把它报给用户，不许静默用它出片。
 */
function get(id, projectRoot) {
  const c = scan(projectRoot);
  const res = resolveId(id, projectRoot);
  const use = res.ok ? res : { ...res, ...DEFAULT_AXES };
  const comp = compose(use, projectRoot);

  const preset = res.source === 'preset' ? c.presets[res.id] : null;
  const name = (preset && preset.name) || tripleName(use, projectRoot);
  return {
    id: res.ok ? res.id : DEFAULT_ID,
    name,
    desc: (preset && preset.desc) || '',
    tags: (preset && preset.tags) || { render: use.render, world: use.world, genre: use.genre, tone: use.tone },
    rev: (preset && preset.rev) || 0,
    render: use.render, world: use.world, genre: use.genre, tone: use.tone,
    vars: comp.vars,
    append: comp.append,
    // 本项目要读的规范文件清单（逻辑名 → 文件列表）。渲染层靠它把「改编规范」这类
    // 逻辑名换成该体裁真正要读的文件 —— 这是「按体裁分流规范」的唯一供给点。
    files: comp.files,
    text: comp.text,
    parts: comp.parts,
    warnings: comp.warnings,
    resolved: {
      ok: !!res.ok,
      reason: res.reason || '',
      wanted: s(res.wanted || id),
      // 解析成功 = 它就是被解析出来的 id；解析失败 = 没有东西被解析出来（null），
      // 调用方靠 wanted + reason 报错，靠 pack.id 拿兜底包
      id: res.ok ? res.id : null,
      source: res.source,
      chain: res.chain || null
    }
  };
}

/** 变量表（渲染层替换 {{S.x}} 用）。取不到返回 {}（渲染层会因裸占位符而报错，不静默出古风） */
function vars(id, projectRoot) {
  const p = get(id, projectRoot);
  return p ? { ...p.vars } : {};
}

/** 默认预置 id（= 改造前的唯一风格） */
function defaultId(projectRoot) {
  const c = scan(projectRoot);
  if (c.presets[DEFAULT_ID]) return DEFAULT_ID;
  const first = ids(projectRoot)[0];
  return first || DEFAULT_ID;
}

/** 默认三轴（新建项目时三个下拉的预选值） */
function defaultAxes() { return { ...DEFAULT_AXES }; }

/** 结构性问题（文件读不进来 / 键缺失 / 预置解析不了）—— 界面黄条用 */
function errors(projectRoot) { return scan(projectRoot).errors.slice(); }
/** 不致命但要说的（世界没给某个画风族备 phrases 之类） */
function warnings(projectRoot) { return scan(projectRoot).warnings.slice(); }

/** 把一个 project.style 值转成人类可读描述（日志 / 界面提示用） */
function describe(id, projectRoot) {
  const res = resolveId(id, projectRoot);
  if (!res.ok) return '⚠ ' + res.reason;
  const p = get(id, projectRoot);
  return p.name + '（' + tripleId(res) + '）';
}

function reload() { _cacheMap.clear(); return scan(); }

/* ------------------------------------------------------------------ *
 * 风格文件读写（2026-10-07 提示词配置中心）
 *   把 electron/styles/ 的结构摊开给界面看与改。rel 形如：
 *     base.json                         兜底变量表
 *     axes/render/live-action.json      画风族（纯画风词 + 组合模板）
 *     axes/world/modern.json / .md      世界（w_* 事实槽位；md 给该世界的补充说明）
 *     axes/genre/ad.json / .md          体裁（结构要求）
 *     axes/tone/commercial.json / .md   制作调性（t_* 调性槽位）
 *     presets/guofeng-real.json         预置四轴
 *     <id>/style.json                   老版单层风格包（仍支持）
 *   写一律落到项目 <项目>/styles/<rel>（同名覆盖内置）；删掉即恢复内置。
 *   🔴 这套路径直接来自界面输入 → 必须挡路径穿越（只允许白名单字符、不许 .. 与空段）。
 * ------------------------------------------------------------------ */

const REL_RE = /^[A-Za-z0-9_.\-\/]{1,120}$/;

/** 规范化并校验一个相对路径；不合法返回 '' */
function safeRel(rel) {
  const r = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!REL_RE.test(r)) return '';
  if (r.split('/').some(x => x === '' || x === '..')) return '';
  return r;
}

/** 递归列出某目录下的 .json / .md（返回相对路径） */
function walkFiles(dir) {
  const out = [];
  const walk = (d, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(path.join(d, e.name), rel); continue; }
      if (/\.(json|md)$/i.test(e.name)) out.push(rel);
    }
  };
  walk(dir, '');
  return out;
}

/** 文件属于哪一组（界面按组展示） */
function relGroup(rel) {
  if (rel === 'base.json') return 'base';
  const m = rel.match(/^axes\/(render|world|genre|tone)\//);
  if (m) return m[1];
  if (rel.indexOf('presets/') === 0) return 'preset';
  return 'legacy';
}

/**
 * 风格文件清单：[{ rel, user, size, mtimeMs, ext, group, label }]
 * user=true 表示项目里有一份同名覆盖（= 用户改过）。
 */
function fileList(projectRoot) {
  const ud = userDir(projectRoot);
  const userSet = new Set(ud ? walkFiles(ud) : []);
  const rels = [...new Set([...walkFiles(BUILTIN_DIR), ...userSet])].sort();
  const out = [];
  for (const rel of rels) {
    const user = userSet.has(rel);
    const p = user ? path.join(ud, rel) : path.join(BUILTIN_DIR, rel);
    let size = 0, mtimeMs = 0;
    try { const st = fs.statSync(p); size = st.size; mtimeMs = st.mtimeMs; } catch (_) {}
    const stem = path.basename(rel).replace(/\.(json|md)$/i, '');
    let label = stem;
    if (/\.json$/i.test(rel)) {
      try {
        const o = readJsonFile(p);
        if (o && !o.__err) label = s(o.label) || s(o.name) || stem;
      } catch (_) { /* 坏 JSON 就退回文件名 */ }
    } else {
      label = stem + '（说明）';
    }
    out.push({ rel, user, size, mtimeMs, ext: (stem === rel ? '' : (rel.split('.').pop() || '').toLowerCase()), group: relGroup(rel), label });
  }
  return out;
}

/** 某 rel 的实际路径（项目覆盖优先） */
function styleFilePath(rel, projectRoot) {
  const r = safeRel(rel);
  if (!r) return '';
  const ud = userDir(projectRoot);
  if (ud) {
    const u = path.join(ud, r);
    if (fs.existsSync(u)) return u;
  }
  const b = path.join(BUILTIN_DIR, r);
  return fs.existsSync(b) ? b : '';
}

/** 读一份风格文件（项目覆盖优先；拿不到返回 ''） */
function readFile(rel, projectRoot) { const p = styleFilePath(rel, projectRoot); return p ? readText(p) : ''; }

/** 校验内容（json 必须能解析）——坏 JSON 存进去会让整个风格包失载，保存前就拦住 */
function validateFileContent(rel, content) {
  if (!/\.json$/i.test(String(rel || ''))) return '';
  try { JSON.parse(String(content == null ? '' : content)); return ''; }
  catch (e) { return 'JSON 语法错误：' + String((e && e.message) || e); }
}

/** 写一份风格文件到项目（自动建目录；JSON 必须先通过语法校验） */
function saveFile(rel, content, projectRoot) {
  const r = safeRel(rel);
  if (!r) throw new Error('非法的风格文件路径：' + rel);
  const bad = validateFileContent(r, content);
  if (bad) throw new Error(bad);
  const ud = userDir(projectRoot);
  if (!ud) throw new Error('还没有选择项目，无法保存风格文件');
  const dst = path.join(ud, r);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, String(content == null ? '' : content), 'utf-8');
  return true;
}

/** 删掉项目覆盖（= 恢复内置版） */
function clearFile(rel, projectRoot) {
  const r = safeRel(rel);
  const ud = userDir(projectRoot);
  if (!r || !ud) return false;
  try { fs.rmSync(path.join(ud, r), { force: true }); } catch (_) { return false; }
  return true;
}

/**
 * 🔴 2026-10-07 改造后**不再需要 db**：风格覆盖已从工作区下沉到项目，
 *    所有对外函数改由调用方传 projectRoot。签名保留只为兼容既有调用点。
 */
function init() { reload(); }

module.exports = {
  init, reload, scan, list, axes, get, vars, ids, defaultId, defaultAxes, describe,
  errors, warnings, validate, resolveId, parseTriple, tripleId, compose,
  fileList, readFile, saveFile, clearFile, safeRel, relGroup, validateFileContent,
  BUILTIN_DIR, DEFAULT_ID, DEFAULT_AXES, AXIS_NAMES, AXIS_LABEL,
  REQUIRED_VARS, CORE_VARS, SLOT_SPEC, TONE_VARS, APPEND_DEFAULT, userDir
};
