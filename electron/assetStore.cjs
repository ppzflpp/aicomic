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

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'unnamed';
}

module.exports = { writeUnique, listFiles, sanitize };
