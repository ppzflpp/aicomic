'use strict';
/**
 * 素材文件指纹（2026-10-16）—— 回答「这个文件还是生成提示词时那个文件吗」。
 *
 * 解决什么问题：分镜页的脏标记（`.stale`）原本只看两样东西 —— 分镜版本号、以及
 * 「这张图出自哪张卡的哪个版本」（`_imgRev`）。可用户**手工换图**（拿另一张图覆盖掉
 * 原来的文件名、或把素材目录里的图换掉）时这两个数字都不动，于是提示词/视频明明
 * 已经和参考图对不上了，界面却一个字都不提示。
 *
 * 指纹 = `大小:修改时间(ms):头部哈希`，三层各有分工：
 *  - **大小**：换一张内容不同的图，字节数几乎必变（最便宜的一层）；
 *  - **修改时间**：覆盖写 / 另存 / 导出一定会变；
 *  - **头部 64KB 的 sha1**（2026-10-16 补，实测踩到才加的）：只靠前两层有个真窟窿 ——
 *    Windows 的复制**保留源文件的修改时间**（`fs.copyFileSync` 与资源管理器里拖拽粘贴
 *    都是这个行为），于是「拿另一张图覆盖」时新mtime = 源文件的mtime，与旧mtime 相撞
 *    并非不可能（自测里当场复现：两个夹具文件在同一毫秒里写出）。头部哈希把「内容确实
 *    换了」这件事变成直接证据，不再依赖时间戳的运气。
 *    只读前 64KB（不是全文件）是有意的：几百个素材 × 每次刷新都读，全文件读要几百 MB，
 *    头部 64KB 只要十几 MB（实测 ~几十毫秒）——而两张**大小、时间、头 64KB 全同**的图，
 *    已经不是「换图」而是刻意构造了。真需要到那一步，得每次对所有素材做全文件哈希。
 *
 * 🔴 故意**不做内存缓存**：缓存键只能又是「大小 + 修改时间」，而那恰好就是上面那个窟窿 ——
 *    为了让缓存命中，反而会把「同大小同时间但内容变了」的换图漏掉。每次调用都真读一遍。
 * 🔴 只读、不写、不抛：文件读不到（被删了 / 路径失效）→ 回空串。
 *    「空串 ≠ 有值」本身就是有用信号：素材被删掉时指纹也会变，提示词照样标脏。
 */
const fs = require('fs');
const crypto = require('crypto');

/** 头部哈希读取长度（见文件头注释：只读头部是刻意的取舍） */
const HEAD_BYTES = 64 * 1024;

/** 头部若干字节的短哈希（读不到 → 空串） */
function headHash(abs, size) {
  const n = Math.min(size, HEAD_BYTES);
  if (n <= 0) return 'empty';
  try {
    const buf = Buffer.allocUnsafe(n);
    const fd = fs.openSync(abs, 'r');
    try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
    return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  } catch (_) {
    return '';
  }
}

/** 单个文件的指纹；文件不存在 / 不可读 → '' */
function sigOne(abs) {
  if (!abs || typeof abs !== 'string') return '';
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return '';
    return st.size + ':' + Math.round(st.mtimeMs) + ':' + headHash(abs, st.size);
  } catch (_) {
    return '';
  }
}

/**
 * 批量取指纹：{ [绝对路径]: 指纹 }。
 * 输入里的重复路径只算一次；非字符串 / 空串直接跳过（调用方可能是「一堆可空的素材槽」）。
 */
function sigMany(files) {
  const out = {};
  if (!Array.isArray(files)) return out;
  for (const f of files) {
    if (!f || typeof f !== 'string') continue;
    if (out[f] !== undefined) continue;
    out[f] = sigOne(f);
  }
  return out;
}

module.exports = { sigOne, sigMany, headHash, HEAD_BYTES };
