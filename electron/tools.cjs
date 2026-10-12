'use strict';
/**
 * 内置工具定位（2026-10-12）：ffmpeg 与 llama.cpp 随软件一起分发，目标「开箱即用」。
 *
 * 目录约定（都在软件自带的 tools/ 下）：
 *   tools/ffmpeg/bin/ffmpeg.exe  ＋ ffprobe.exe（同目录）
 *   tools/llama/<任意一层子目录>/llama-server.exe
 *   （llama 的 CUDA 运行时要与 llama-server.exe 同级，Windows 才搜得到；cudart 包解压进同一目录）
 *
 * 打包后 tools/ 通过 electron-builder 的 extraResources 落到 <安装目录>\resources\tools\，
 * 所以定位顺序要同时覆盖「开发态」与「打包态」：
 *   1. 环境变量 COMIC_TOOLS_DIR（自测 / 排障时临时指路）
 *   2. process.resourcesPath\tools   ← 打包态（extraResources 的落点）
 *   3. <本文件>\..\tools             ← 开发态（仓库 comic-studio\tools）
 * 命中即用；一个都没命中返回空串，调用方再去走各自的兜底探测。
 */
const fs = require('fs');
const path = require('path');

const WIN = process.platform === 'win32';

function isFile(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

/** 在 dir 及最大 depth 层子目录里按文件名查找，返回第一个命中的绝对路径 */
function findFile(dir, name, depth = 2) {
  if (!dir || !isDir(dir)) return null;
  const want = name.toLowerCase();
  const stack = [{ d: dir, lv: 0 }];
  while (stack.length) {
    const { d, lv } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (e.isFile()) { if (e.name.toLowerCase() === want) return path.join(d, e.name); }
      else if (e.isDirectory() && lv < depth) stack.push({ d: path.join(d, e.name), lv: lv + 1 });
    }
  }
  return null;
}

let _root;   // undefined = 还没解析 / string（可能是空串）= 解析结果

/** 内置 tools 根目录（找不到返回空串）。结果在进程内缓存 —— 目录不会变。 */
function root() {
  if (_root !== undefined) return _root;
  const cands = [];
  if (process.env.COMIC_TOOLS_DIR) cands.push(process.env.COMIC_TOOLS_DIR);
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'tools'));
  cands.push(path.join(__dirname, '..', 'tools'));
  _root = '';
  for (const c of cands) { if (isDir(c)) { _root = c; break; } }
  return _root;
}

/** 内置 ffmpeg 可执行文件（找不到返回 null） */
function ffmpeg() {
  const r = root();
  if (!r) return null;
  const exe = WIN ? 'ffmpeg.exe' : 'ffmpeg';
  const direct = [
    path.join(r, 'ffmpeg', 'bin', exe),   // 官方 Windows 构建的标准布局
    path.join(r, 'ffmpeg', exe),
    path.join(r, exe)
  ];
  for (const p of direct) if (isFile(p)) return p;
  // 兜底：用户换了别的发行版（目录层次不同）也能找到
  return findFile(path.join(r, 'ffmpeg'), exe, 3);
}

/** 与 ffmpeg 同目录的 ffprobe（找不到返回 null）；也可传任意 ffmpeg 路径复用定位规则 */
function ffprobe(ffmpegPath) {
  const dir = ffmpegPath ? path.dirname(ffmpegPath) : '';
  if (!dir) return null;
  const p = path.join(dir, WIN ? 'ffprobe.exe' : 'ffprobe');
  return isFile(p) ? p : null;
}

/** 内置 llama-server 所在目录（即含 llama-server.exe 的那一层，CUDART 与它同级）；找不到返回空串 */
function llamaDir() {
  const r = root();
  if (!r) return '';
  const base = path.join(r, 'llama');
  if (!isDir(base)) return '';
  const exe = findFile(base, WIN ? 'llama-server.exe' : 'llama-server', 3);
  return exe ? path.dirname(exe) : '';
}

module.exports = { root, ffmpeg, ffprobe, llamaDir, findFile, isFile, isDir };
