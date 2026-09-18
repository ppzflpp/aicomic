'use strict';
/**
 * 统一日志总线（主进程）。
 *
 * 三路输出：
 *   1) 内存环形缓冲（最近 MAX 条）—— 渲染层打开日志面板时一次性拉取历史
 *   2) 落盘 软件目录\logs\studio-YYYY-MM-DD.log —— 事后排查 / 用户反馈
 *   3) webContents.send('log:line', entry) —— 实时推给日志面板
 *
 * 行格式：
 *   [2026-09-17 17:40:46] [阶段4 角色出图] llama-server 已停止（当前 14333 MiB）
 *
 * 「当前阶段标签」：orchestrator 在进入某阶段前 setTag('阶段4 角色出图')，
 * 之后所有模块（launcher / inference）打的日志都自动带上这个标签，
 * 这样 inference 里不必到处传阶段名。
 *
 * 级别：info | ok | warn | error | debug（debug 默认在面板里隐藏，可切换显示）
 */
const fs = require('fs');
const path = require('path');

const MAX = 3000;
const ring = [];
let db = null;
let getWin = null;
let stream = null;
let streamDay = '';
let currentTag = '系统';

function init(dbRef, getWinRef) {
  db = dbRef || null;
  getWin = getWinRef || null;
}

function pad(n) { return String(n).padStart(2, '0'); }

/** 'yyyy-MM-dd HH:mm:ss'（本地时间） */
function stamp(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function dayKey(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 日志目录：固定在软件目录 logs\ 下（与工作区设置无关，随软件走） */
function logsDir() {
  try {
    const dir = path.join(__dirname, '..', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (_) { return ''; }
}

function filePath() {
  const dir = logsDir();
  return dir ? path.join(dir, 'studio-' + dayKey() + '.log') : '';
}

/** 按天轮转的追加流（懒创建；跨天自动换文件） */
function writeFile(line) {
  try {
    const dir = logsDir();
    if (!dir) return;
    const day = dayKey();
    if (!stream || streamDay !== day) {
      try { if (stream) stream.end(); } catch (_) {}
      streamDay = day;
      stream = fs.createWriteStream(path.join(dir, 'studio-' + day + '.log'), { flags: 'a' });
      stream.on('error', () => { stream = null; });
    }
    stream.write(line + '\n');
  } catch (_) { /* 日志失败绝不影响主流程 */ }
}

function setTag(tag) { currentTag = tag || '系统'; return currentTag; }
function tag() { return currentTag; }

/** 写一条日志。tag 可选；不传用当前阶段标签 */
function log(msg, level = 'info', tagOverride) {
  const text = String(msg == null ? '' : msg);
  const tg = tagOverride || currentTag;
  const ts = stamp();
  const line = '[' + ts + '] [' + tg + '] ' + text;
  const entry = { ts, tag: tg, level, msg: text, line };

  ring.push(entry);
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);

  writeFile(line);

  try {
    const w = getWin ? getWin() : null;
    if (w && !w.isDestroyed() && w.webContents) w.webContents.send('log:line', entry);
  } catch (_) { /* 窗口没了就算了 */ }

  // 调试期也往控制台丢一份（打包后看不到，无所谓）
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  return entry;
}

const info = (m, t) => log(m, 'info', t);
const ok = (m, t) => log(m, 'ok', t);
const warn = (m, t) => log(m, 'warn', t);
const error = (m, t) => log(m, 'error', t);
const detail = (m, t) => log(m, 'debug', t);

/** 面板打开时拉历史 */
function recent(limit = 800) {
  return limit > 0 ? ring.slice(-limit) : ring.slice();
}

function clear() {
  ring.length = 0;
  return true;
}

/** 记一条「有耗时」的完成日志：'沈砚.png 生成完成（12.1s）' */
function done(msg, ms) {
  const s = ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
  return ok(msg + '（' + s + '）');
}

module.exports = {
  init, log, info, ok, warn, error, detail, done,
  setTag, tag, recent, clear, filePath, stamp
};
