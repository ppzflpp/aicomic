'use strict';
/**
 * 第三方 Skill 模块：安装 / 管理「提示词扩展技能包」。
 *
 * 一个 skill = 一个文件夹，内含 SKILL.md（必需）与可选的 references/ 等附件，
 * 原样保留、不做任何提炼 —— 注入提示词时全文拼接。
 *
 * 存储位置：<userData>/skills/<id>/（与数据库同盘管理，卸载软件即清理）。
 * 内置 skill 随软件发行（comic-studio/skills/），首次启动自动播种到 skillsDir；
 * 播种时写入 .builtin 标记，用户可删可关，软件升级时若内置版本更新会自动覆盖
 * （仅限未被用户修改过的：以 .builtin 标记存在为准）。
 */
const fs = require('fs');
const path = require('path');

let skillsDir = null;
/** 随软件发行的内置 skill 根目录（仓库内 comic-studio/skills/） */
const builtinRoot = path.join(__dirname, '..', 'skills');

function init(userDataDir) {
  skillsDir = path.join(userDataDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  seedBuiltins();
}

/** 把内置 skill 播种到用户目录：不存在则复制；存在且是 .builtin 且版本变了则覆盖 */
function seedBuiltins() {
  let dirs = [];
  try { dirs = fs.readdirSync(builtinRoot).filter(f => fs.existsSync(path.join(builtinRoot, f, 'SKILL.md'))); } catch (_) {}
  for (const id of dirs) {
    const src = path.join(builtinRoot, id);
    const dst = path.join(skillsDir, id);
    const srcVer = builtinVersion(src);
    const dstVer = fs.existsSync(dst) ? builtinVersion(dst) : -1;
    if (!fs.existsSync(dst)) {
      copyDir(src, dst);
      try { fs.writeFileSync(path.join(dst, '.builtin'), String(srcVer), 'utf-8'); } catch (_) {}
    } else if (fs.existsSync(path.join(dst, '.builtin')) && srcVer > dstVer) {
      // 内置升级：只在用户没改过（仍是 .builtin）时覆盖
      fs.rmSync(dst, { recursive: true, force: true });
      copyDir(src, dst);
      try { fs.writeFileSync(path.join(dst, '.builtin'), String(srcVer), 'utf-8'); } catch (_) {}
    }
  }
}

/** 内置版本号：读发行目录里的 VERSION 文件（没有就算 1） */
function builtinVersion(dir) {
  try { return parseInt(fs.readFileSync(path.join(dir, 'VERSION'), 'utf-8').trim(), 10) || 1; } catch (_) { return 1; }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 极简 frontmatter 解析：--- 包裹的 YAML 里抓 name / description */
function parseMeta(text) {
  const m = { name: '', description: '' };
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const name = fm[1].match(/^name:\s*(.+)$/m);
    const desc = fm[1].match(/^description:\s*(.+)$/m);
    if (name) m.name = name[1].trim();
    if (desc) m.description = desc[1].trim();
  }
  return m;
}

/** 已启用的 skill 集合（db 设置 skills.enabled = { id: true/false }；缺省视为启用） */
function enabledMap(db) {
  try {
    const v = JSON.parse(db.getSetting('skills.enabled') || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch (_) { return {}; }
}

function list(db) {
  const on = enabledMap(db);
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(skillsDir); } catch (_) {}
  for (const id of dirs) {
    const dir = path.join(skillsDir, id);
    const md = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    let text = '';
    try { text = fs.readFileSync(md, 'utf-8'); } catch (_) {}
    const meta = parseMeta(text);
    let size = 0;
    try { size = dirSize(dir); } catch (_) {}
    out.push({
      id,
      name: meta.name || id,
      description: meta.description,
      size,
      builtin: fs.existsSync(path.join(dir, '.builtin')),
      enabled: on[id] !== false
    });
  }
  return out;
}

function dirSize(dir) {
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    n += fs.statSync(p).isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
}

/**
 * 安装：srcPath 可以是含 SKILL.md 的文件夹（整个拷入，references 等附件全保留）。
 * id：文件夹姿势取文件夹名；单文件姿势取 frontmatter 的 name（没有就用所在文件夹名）。
 * 重名自动加 -2、-3 后缀。
 */
function install(srcPath) {
  let srcDir = null, preferId = null;
  try {
    const st = fs.statSync(srcPath);
    if (st.isDirectory()) {
      if (!fs.existsSync(path.join(srcPath, 'SKILL.md'))) throw new Error('所选文件夹里没有 SKILL.md');
      srcDir = srcPath;
      preferId = path.basename(srcPath);
    } else if (/^SKILL\.md$/i.test(path.basename(srcPath))) {
      // 选了单个 SKILL.md：连同同级的 references/ 一起收
      const parent = path.dirname(srcPath);
      const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'skill-'));
      const mdText = fs.readFileSync(srcPath, 'utf-8');
      fs.writeFileSync(path.join(tmp, 'SKILL.md'), mdText, 'utf-8');
      const refs = path.join(parent, 'references');
      if (fs.existsSync(refs)) copyDir(refs, path.join(tmp, 'references'));
      srcDir = tmp;
      const meta = parseMeta(mdText);
      preferId = (meta.name || path.basename(parent) || 'skill').trim();
    } else {
      throw new Error('请选择含 SKILL.md 的文件夹，或直接选 SKILL.md 文件');
    }
  } catch (e) { throw e; }

  let id = (preferId || 'skill').replace(/[\\/:*?"<>|\s]+/g, '_');
  for (let i = 2; fs.existsSync(path.join(skillsDir, id)); i++) id = (preferId || 'skill').replace(/[\\/:*?"<>|\s]+/g, '_') + '-' + i;
  copyDir(srcDir, path.join(skillsDir, id));
  return id;
}

function remove(db, id) {
  const dir = path.join(skillsDir, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  const on = enabledMap(db);
  if (id in on) { delete on[id]; db.setSetting('skills.enabled', JSON.stringify(on)); }
  return true;
}

function setEnabled(db, id, onFlag) {
  const on = enabledMap(db);
  on[id] = !!onFlag;
  db.setSetting('skills.enabled', JSON.stringify(on));
  return on[id];
}

/** 读 skill 全文：SKILL.md + 全部附件（references/* 等），附件以「===== 文件名 =====」分节 */
function readFull(id) {
  const dir = path.join(skillsDir, id);
  const md = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(md)) return null;
  let out = fs.readFileSync(md, 'utf-8');
  const walk = (sub, label) => {
    const p = path.join(dir, sub);
    if (!fs.existsSync(p)) return;
    for (const f of fs.readdirSync(p)) {
      const fp = path.join(p, f);
      if (fs.statSync(fp).isDirectory()) walk(path.join(sub, f), label + '/' + f);
      else if (/\.(txt|md)$/i.test(f)) out += '\n\n===== ' + label + '/' + f + ' =====\n\n' + fs.readFileSync(fp, 'utf-8');
    }
  };
  walk('references', 'references');
  return out;
}

module.exports = { init, list, install, remove, setEnabled, readFull };
