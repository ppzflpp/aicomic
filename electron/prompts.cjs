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
 *  - v1 时代的旧版内置文件（指令体，没有「## 适用范围」小节）直接删除重播
 *  - 用户改过的新版文件永远保留
 */
const fs = require('fs');
const path = require('path');

/** 内置提示词根目录（仓库内 comic-studio/skills/prompts/） */
const BUILTIN_DIR = path.join(__dirname, '..', 'skills', 'prompts');

/** v2 统一的规范结构标记：旧版（v1 指令体）文件不含此小节 */
const STRUCT_MARK = '## 适用范围';

/** 提示词规范文件：文件名固定（代码按名索引），title 用于界面展示 */
const FILES = {
  'adapt.md': '改编规范',
  'shots.md': '分镜规范',
  'chars.md': '角色规范',
  'scenes.md': '场景规范',
  'profile.md': '档案规范（角色 / 场景档案）',
  'h3.md': 'H3 提示词规范（基础模式）',
  'h3ref.md': 'H3 提示词规范（参考模式）'
};

function isKnown(name) { return Object.prototype.hasOwnProperty.call(FILES, name); }

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
 * 把内置规范播种到 <rootDir>/prompts/：
 *  - 缺失 → 补
 *  - 已存在但是旧版结构（v1 指令体）→ 删除重播（用户拍板：老项目直接删除重来）
 *  - 已存在且是新版结构 → 原样保留（可能是用户自己改过的）
 *  - 已存在但 rev 低于内置版（规范升级）→ 重播升级（用户拍板：官方规范升级必须跟上）
 */
function seedAt(rootDir) {
  if (!rootDir) return null;
  const dir = path.join(rootDir, 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(FILES)) {
    const dst = path.join(dir, name);
    const src = path.join(BUILTIN_DIR, name);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) {
      const cur = readSafe(dst);
      if (cur !== null && cur.indexOf(STRUCT_MARK) >= 0 && revOf(cur) >= revOf(readSafe(src))) continue;   // 新版且不落后于内置版，保留用户的修改
    }
    try { fs.copyFileSync(src, dst); } catch (_) {}
  }
  return dir;
}

/** 列出规范文件（含路径与大小；size/mtime 为 0 表示还没落盘） */
function listAt(rootDir) {
  const dir = path.join(rootDir || '', 'prompts');
  const out = [];
  for (const [name, title] of Object.entries(FILES)) {
    const p = path.join(dir, name);
    let size = 0, mtimeMs = 0;
    try { const st = fs.statSync(p); size = st.size; mtimeMs = st.mtimeMs; } catch (_) {}
    out.push({ name, title, path: p, size, mtimeMs });
  }
  return out;
}

/** 读项目里的规范文件；缺失 / 还是旧版结构 / rev 落后于内置版 → 先播种/重播再读 */
function readAt(rootDir, name) {
  if (!isKnown(name)) throw new Error('未知提示词文件：' + name);
  const p = path.join(rootDir, 'prompts', name);
  const srcText = readSafe(path.join(BUILTIN_DIR, name));
  const cur = fs.existsSync(p) ? readSafe(p) : null;
  if (cur === null || cur.indexOf(STRUCT_MARK) < 0 || (srcText && revOf(cur) < revOf(srcText))) seedAt(rootDir);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

/** 保存用户编辑后的规范文件 */
function saveAt(rootDir, name, content) {
  if (!isKnown(name)) throw new Error('未知提示词文件：' + name);
  const dir = seedAt(rootDir) || path.join(rootDir, 'prompts');
  fs.writeFileSync(path.join(dir, name), String(content), 'utf-8');
  return true;
}

module.exports = { BUILTIN_DIR, FILES, STRUCT_MARK, seedAt, listAt, readAt, saveAt };
