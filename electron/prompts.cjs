'use strict';
/**
 * 项目级提示词规范文件（2026-09-20 v2）：
 * 各模块的风格规范统一抽成 md 文件，内置在仓库 comic-studio/skills/prompts/
 * （与第三方 skill 共用 skills 根目录；本目录里的 md 没有 SKILL.md，
 * 不会被 skills.cjs 的技能播种逻辑当成技能包）。
 *
 * 注意：这些 md 是「风格规范」，不是直接发给大模型的完整提示词 ——
 * 真正的 system 提示词由渲染层的 src/prompts.js 组装：
 *   身份说明（代码固定）+ 风格规范（读这里的 md）+ 输出格式契约（代码固定）
 * 这样用户改规范能调风格，但改不坏 JSON 格式等技术契约。
 *
 * 每个项目 <项目>/prompts/ 下有一份可编辑拷贝：
 *  - 新建项目时自动播种一份
 *  - 任何读取（含各模块生成前）发现缺失 → 自动从内置目录补一份
 *  - v1 时代的旧版内置文件（指令体，既无 rev 也无「## 适用范围」小节）直接删除重播
 *  - 用户改过的新版文件永远保留
 */
const fs = require('fs');
const path = require('path');

/** 内置提示词根目录（仓库内 comic-studio/skills/prompts/） */
const BUILTIN_DIR = path.join(__dirname, '..', 'skills', 'prompts');

/** v2 统一的规范结构标记：旧版（v1 指令体）文件不含此小节 */
const STRUCT_MARK = '## 适用范围';

/**
 * 判断一份规范文件是不是「新版结构」（= 可以保留用户修改的那种）。
 * 🔴 2026-10-07：原判据是「必须含 '## 适用范围' 这个标题」。用户微调规范时一旦把标题删掉或改名，
 *    文件就被判成旧版 → 每次读取都重播内置版 → **用户的修改静默消失**（「用户会自己改规范」这条路上最危险的一坑）。
 *    现改为「带 rev 或 带结构标记」二者有一即可：rev 在 frontmatter 里、用户不会随便删，
 *    标题怎么改都不再影响判定。
 */
function isNewStruct(text) {
  if (text === null || text === undefined) return false;
  const t = String(text);
  return revOf(t) > 0 || t.indexOf(STRUCT_MARK) >= 0;
}

/** 提示词规范文件：文件名固定（代码按名索引），title 用于界面展示 */
const FILES = {
  'adapt.md': '改编规范',
  'shots.md': '分镜规范',
  'chars.md': '角色规范',
  'scenes.md': '场景规范',
  'profile.md': '档案规范（角色 / 场景档案）',
  'h3.md': 'H3 提示词规范（基础模式）',
  'h3ref.md': 'H3 提示词规范（参考模式）',
  'promptgen.md': '生图提示词规范（档案 → 提示词）',
  'ltx.md': 'LTX-2.5 提示词规范',
  'split.md': '拆镜重写规范（拆分镜头后的画面补写）'
};

function isKnown(name) { return Object.prototype.hasOwnProperty.call(FILES, name); }

/**
 * 变体规范：`<基名>-<后缀>.md`（如 `adapt-ad.md`），基名必须是上面表里的基规范。
 * 后缀只允许小写字母 / 数字 / 连字符，所以整名里**不可能**出现 `/`、`..` 这类路径字符
 * —— 这两个正则一起构成了「文件名 → 磁盘路径」那条路的安全边界，不要放宽。
 *
 * 🔴 为什么要有变体：一份规范只服务一种体裁是不够的。广告片的改编与小说改编对
 *    「镜头语言」「人物命名」的要求正好相反，必须整份换规范；而换规范如果每次都要
 *    改代码登记表，扩展成本就落在开发者身上了。变体让「新增一个体裁 = 只写自己那几个
 *    md 文件」，代码零改动。
 *
 * @returns {string} 基规范名（不是变体则返回 ''）
 */
const VARIANT_SUFFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function variantBase(name) {
  const n = String(name || '');
  if (!/\.md$/.test(n)) return '';
  for (const base of Object.keys(FILES)) {
    const stem = base.slice(0, -3);                       // 'adapt'
    if (n === base || n.indexOf(stem + '-') !== 0) continue;
    if (VARIANT_SUFFIX_RE.test(n.slice(stem.length + 1, -3))) return base;
  }
  return '';
}

/** 认不认这份规范：基规范或命名合规的变体 */
function known(name) { return isKnown(name) || !!variantBase(name); }

/** 展示名：基规范查表；变体优先取它自己 frontmatter 里的 title，没有就「基名（后缀）」 */
function titleOf(name, dir) {
  if (isKnown(name)) return FILES[name];
  const base = variantBase(name);
  if (!base) return String(name || '');
  const raw = readSafe(path.join(dir || '', name)) || readSafe(path.join(BUILTIN_DIR, name));
  const head = String(raw || '').match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  const t = head && head[1].match(/(?:^|\n)\s*title:\s*(.+?)\s*(?:\n|$)/);
  if (t && t[1].trim()) return t[1].trim();
  const stem = base.slice(0, -3);
  return FILES[base] + '（' + String(name).slice(stem.length + 1, -3) + '）';
}

/** 读 frontmatter 里的 rev 版本号（无则 0） */
function revOf(text) {
  const m = String(text || '').match(/(?:^|\n)\s*rev:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** 读取文件内容；失败返回 null（用于版本判定） */
function readSafe(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch (_) { return null; }
}

/**
 * 播一份规范（基规范与变体走同一条规则）：
 *  - 缺失 → 从内置目录补
 *  - 已存在但是旧版结构（v1 指令体）→ 覆盖重播（用户拍板：老项目直接删除重来）
 *  - 已存在且是新版结构，且 rev 不低于内置版 → 原样保留（可能是用户自己改过的）
 *  - 已存在但 rev 低于内置版（规范升级）→ 覆盖升级（用户拍板：官方规范升级必须跟上）
 * @returns {boolean} 这份规范现在在项目里存在吗
 */
function seedOne(rootDir, name) {
  if (!rootDir || !known(name)) return false;
  const dir = path.join(rootDir, 'prompts');
  const dst = path.join(dir, name);
  const src = path.join(BUILTIN_DIR, name);
  const srcText = readSafe(src);
  if (srcText == null) return fs.existsSync(dst);        // 内置没有（项目自造的变体）→ 不动它
  if (fs.existsSync(dst)) {
    const cur = readSafe(dst);
    if (isNewStruct(cur) && revOf(cur) >= revOf(srcText)) return true;   // 新版且不落后，保留用户的修改
  }
  try { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(src, dst); return true; } catch (_) { return false; }
}

/**
 * 把内置规范播种到 <rootDir>/prompts/（对表里的每一份基规范走 seedOne）。
 * 🔴 变体规范**不在这里**：它们按需播种（见 readAt / listAt）——只有真正要用它的项目
 *    才会多出这个文件，别的体裁的项目不会被塞一堆用不上的规范。
 */
function seedAt(rootDir) {
  if (!rootDir) return null;
  const dir = path.join(rootDir, 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(FILES)) seedOne(rootDir, name);
  return dir;
}

/**
 * 列出规范文件。
 * @param {string[]} needed 本项目当前体裁声明要用到的真实文件名（可变体）——会顺带播种，
 *   这样「提示词配置中心」一打开就能看到并编辑该体裁的规范，不用等它被真正读一次。
 */
function listAt(rootDir, needed) {
  const dir = path.join(rootDir || '', 'prompts');
  const names = Object.keys(FILES).slice();
  const seen = new Set(names);
  for (const n of (Array.isArray(needed) ? needed : [])) {
    const nm = String(n || '');
    if (seen.has(nm) || !known(nm)) continue;
    seen.add(nm); names.push(nm);
    if (variantBase(nm)) seedOne(rootDir, nm);          // 变体：首次进清单时按需播种
  }
  let entries = [];
  try { entries = fs.readdirSync(dir).sort(); } catch (_) { entries = []; }
  for (const fn of entries) {
    // 项目里已经存在的变体（用户以前用过 / 自己放的）也列出来，让它能被编辑与恢复
    if (seen.has(fn) || !known(fn) || isKnown(fn)) continue;
    seen.add(fn); names.push(fn);
  }
  const out = [];
  for (const name of names) {
    const p = path.join(dir, name);
    let size = 0, mtimeMs = 0;
    try { const st = fs.statSync(p); size = st.size; mtimeMs = st.mtimeMs; } catch (_) {}
    out.push({ name, title: titleOf(name, dir), path: p, size, mtimeMs, variant: !!variantBase(name) });
  }
  return out;
}

/** 读项目里的规范文件；缺失 / 旧版结构 / rev 落后于内置版 → 先播种（变体按需单份播种） */
function readAt(rootDir, name) {
  if (!known(name)) throw new Error('未知提示词文件：' + name);
  const p = path.join(rootDir, 'prompts', name);
  if (variantBase(name)) {
    seedOne(rootDir, name);
  } else {
    const cur = fs.existsSync(p) ? readSafe(p) : null;
    const srcText = readSafe(path.join(BUILTIN_DIR, name));
    if (!isNewStruct(cur) || (srcText && revOf(cur) < revOf(srcText))) seedAt(rootDir);
  }
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

/** 保存用户编辑后的规范文件 */
function saveAt(rootDir, name, content) {
  if (!known(name)) throw new Error('未知提示词文件：' + name);
  seedOne(rootDir, name);
  const dir = variantBase(name) ? path.join(rootDir, 'prompts') : (seedAt(rootDir) || path.join(rootDir, 'prompts'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), String(content), 'utf-8');
  return true;
}

/**
 * 把项目里的某份规范恢复成内置版：删掉项目副本后重新播种
 * （与 rev 升级走同一条路径 —— 所以「恢复内置」不会留下任何半新半旧的状态）。
 * 基规范走 seedAt（整批，保证同批一致），变体走 seedOne（单份）。
 */
function resetAt(rootDir, name) {
  if (!known(name)) throw new Error('未知提示词文件：' + name);
  const p = path.join(String(rootDir || ''), 'prompts', name);
  try { fs.rmSync(p, { force: true }); } catch (_) {}
  if (variantBase(name)) seedOne(rootDir, name); else seedAt(rootDir);
  return fs.existsSync(p);
}

/* ------------------------------------------------------------------ *
 * 成品覆写层（2026-10-07 提示词配置中心）
 *   背景：用户真正想改的是「合成出来的那一篇成品提示词」（通用规范 + 模型专属 +
 *   风格替换 + 风格说明 拼起来的结果），而不是去理解"这四份零件是怎么拼的"。
 *   于是新增第三层作用域：
 *     内置 skills/prompts/  ←  项目 <项目>/prompts/  ←  **成品覆写 <项目>/prompts/final/<用途>.md**
 *   覆写存在 → 该用途直接下发覆写全文，**不再走合成**（也不做风格替换、不追加模型专属与风格说明）。
 *   代价是「脱钩」：改画风 / 换模型不再影响它 —— 所以界面必须显式标出来，
 *   并给一键恢复（= 删掉覆写文件，立刻回到合成）。
 * ------------------------------------------------------------------ */

/** 覆写目录名（挂在 <项目>/prompts/ 下） */
const FINAL_SUBDIR = 'final';

/** 用途 id 允许的字符 —— 它直接当文件名用，必须挡住路径穿越 */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function finalDir(rootDir) { return path.join(String(rootDir || ''), 'prompts', FINAL_SUBDIR); }

/**
 * 从覆写文件（可选）的 frontmatter 里取元信息。
 * 目前只有一个 `for:` —— 记「这份覆写是为哪个模型方案写的」（视频侧 H3 与 LTX 写法不同，
 * 换了视频方案还在用旧覆写就会串味，界面据此打黄标）。
 */
function finalMeta(text) {
  const m = String(text || '').match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { forId: '' };
  const f = m[1].match(/(?:^|\n)\s*for:\s*(.+?)\s*(?:\n|$)/);
  return { forId: f ? f[1].trim() : '' };
}

/** 列出某项目的全部成品覆写：{ [taskId]: { size, mtimeMs, forId } } */
function listFinal(rootDir) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(finalDir(rootDir)); } catch (_) { return out; }
  for (const fn of names) {
    if (!fn.endsWith('.md')) continue;
    const id = fn.slice(0, -3);
    if (!TASK_ID_RE.test(id)) continue;
    const p = path.join(finalDir(rootDir), fn);
    let size = 0, mtimeMs = 0;
    try { const st = fs.statSync(p); size = st.size; mtimeMs = st.mtimeMs; } catch (_) { continue; }
    out[id] = { size, mtimeMs, forId: finalMeta(readSafe(p)).forId };
  }
  return out;
}

/** 读一份成品覆写；不存在返回 null（与「存了空内容」区分开） */
function readFinal(rootDir, taskId) {
  if (!TASK_ID_RE.test(String(taskId || ''))) return null;
  const p = path.join(finalDir(rootDir), taskId + '.md');
  return fs.existsSync(p) ? readSafe(p) : null;
}

/** 写一份成品覆写（id 白名单 + 自动建目录） */
function saveFinal(rootDir, taskId, content) {
  const id = String(taskId || '');
  if (!TASK_ID_RE.test(id)) throw new Error('非法的用途 id：' + id);
  fs.mkdirSync(finalDir(rootDir), { recursive: true });
  fs.writeFileSync(path.join(finalDir(rootDir), id + '.md'), String(content == null ? '' : content), 'utf-8');
  return true;
}

/** 删掉一份成品覆写（= 恢复默认合成） */
function clearFinal(rootDir, taskId) {
  const id = String(taskId || '');
  if (!TASK_ID_RE.test(id)) return false;
  try { fs.rmSync(path.join(finalDir(rootDir), id + '.md'), { force: true }); } catch (_) { return false; }
  return true;
}

module.exports = {
  BUILTIN_DIR, FILES, STRUCT_MARK, isNewStruct, isKnown, known, variantBase, titleOf,
  seedAt, seedOne, listAt, readAt, saveAt, resetAt,
  FINAL_SUBDIR, finalDir, finalMeta, listFinal, readFinal, saveFinal, clearFinal
};
