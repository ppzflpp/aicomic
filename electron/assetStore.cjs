'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 唯一的资产写入口：永不覆盖。
 * 目录不存在自动创建；同名文件自动编号 base.png → base_02.png → base_03.png ...
 * 返回实际写入的文件名。
 */
function writeUnique(dirPath, baseName, ext, buffer) {
  fs.mkdirSync(dirPath, { recursive: true });
  const cleanBase = sanitize(baseName);
  let name = `${cleanBase}.${ext}`;
  let i = 2;
  while (fs.existsSync(path.join(dirPath, name))) {
    name = `${cleanBase}_${String(i).padStart(2, '0')}.${ext}`;
    i++;
  }
  fs.writeFileSync(path.join(dirPath, name), buffer);
  return name;
}

/** 读取目录下已有的编号文件列表（按文件名排序），用于候选历史展示 */
function listFiles(dirPath, baseName) {
  if (!fs.existsSync(dirPath)) return [];
  const cleanBase = sanitize(baseName);
  return fs.readdirSync(dirPath)
    .filter(f => f.startsWith(cleanBase) && /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort();
}

/**
 * 递归复制目录内容：**只增不删**（同名覆盖，目标端多出来的文件保留）。
 * 用途：本集私有的图 ↔ 库条目目录之间同步（入库时推给库、按库更新时拉回本集）。
 * 源目录不存在时什么都不做（返回 0）。
 * @returns 实际复制的文件数
 */
function copyDir(fromDir, toDir) {
  if (!fromDir || !toDir || !fs.existsSync(fromDir)) return 0;
  let n = 0;
  try { fs.mkdirSync(toDir, { recursive: true }); } catch (_) { return 0; }
  let subs = [];
  try { subs = fs.readdirSync(fromDir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const d of subs) {
    const s = path.join(fromDir, d.name), t = path.join(toDir, d.name);
    if (d.isDirectory()) { n += copyDir(s, t); continue; }
    try { fs.copyFileSync(s, t); n++; } catch (_) { /* 单文件失败不挡其它 */ }
  }
  return n;
}

/** 允许导入的图片扩展名（与 file:pick 的图片过滤器保持一致） */
const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp'];

/**
 * 从本地任意位置导入一张图片：**复制**进目标目录，并按 baseName 唯一命名（规则同 writeUnique）。
 * 用途（2026-10-08）：用户手里已有满意的参考图（网上下载 / 自己拍 / 别的项目出的图），直接拿来当卡片参考图，
 * 不必靠模型抽卡。返回实际写入的文件名（如 驾驶者.png / 驾驶者_02.png），供渲染层并入 candidates。
 * 🔴 必须复制而不是只记源路径：源文件被移动或删除后，卡片的缩略图会静默断链（看着有图、实际打不开）。
 */
function importFile(dirPath, baseName, srcPath) {
  if (!srcPath || !fs.existsSync(srcPath)) throw new Error('源文件不存在：' + srcPath);
  const ext = (path.extname(srcPath).slice(1) || '').toLowerCase();
  if (IMG_EXT.indexOf(ext) < 0) throw new Error('只支持图片（' + IMG_EXT.join(' / ') + '）');
  return writeUnique(dirPath, baseName, ext, fs.readFileSync(srcPath));
}

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'unnamed';
}

module.exports = { writeUnique, listFiles, copyDir, importFile, sanitize };
