'use strict';
/**
 * 现场（会话）快照：软件退出时保存、下次启动原样恢复。
 *
 * 存进 settings 表的 `session.last`（JSON），两类内容：
 *   window  窗口位置 / 大小 / 是否最大化            —— 本模块（主进程侧）负责
 *   view / episodeId / expanded / scroll / logs    —— 渲染层 src/session.js 收集
 *
 * 设计取舍：界面一变就**防抖落库**（600ms），不赌「退出那一瞬间的钩子」——
 * 强杀进程、断电也不会把现场丢光；退出时再用 send 同步补一刀。
 */
const KEY = 'session.last';

/** 默认窗口几何（与 main.cjs 的 windowOptions 保持一致） */
const DEF = { width: 1500, height: 940, minWidth: 1200, minHeight: 760 };

let db = null;

function init(_db) { db = _db; }

function read() {
  if (!db) return {};
  try {
    const raw = db.getSetting(KEY);
    const o = raw ? JSON.parse(raw) : {};
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (_) { return {}; }
}

/** 合并式写入（只覆盖传入的字段，其余现场保留） */
function write(patch) {
  if (!db || !patch || typeof patch !== 'object') return read();
  const next = Object.assign(read(), patch);
  next.savedAt = stamp();
  try { db.setSetting(KEY, JSON.stringify(next)); } catch (_) { /* 磁盘异常不影响使用 */ }
  return next;
}

function clear() {
  if (!db) return;
  try { db.setSetting(KEY, '{}'); } catch (_) {}
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/**
 * 读回上次的窗口几何。
 * - 尺寸先夹到当前屏幕工作区内（换分辨率后不至于比屏幕还大）
 * - 位置做可见性校验：上次在副屏、而现在副屏拔了 → 丢弃坐标走系统默认，避免窗口跑到看不见的地方
 */
function windowState() {
  const out = { width: DEF.width, height: DEF.height, maximized: false };
  let area = null;
  try { area = require('electron').screen.getPrimaryDisplay().workArea; } catch (_) {}
  const w = read().window;
  if (!w || !Number.isFinite(w.width) || !Number.isFinite(w.height)) return out;

  const maxW = area ? Math.round(area.width) : 0;
  const maxH = area ? Math.round(area.height) : 0;
  out.width = Math.max(DEF.minWidth, Math.min(Math.round(w.width), maxW || Math.round(w.width)));
  out.height = Math.max(DEF.minHeight, Math.min(Math.round(w.height), maxH || Math.round(w.height)));
  out.maximized = !!w.maximized;

  if (Number.isFinite(w.x) && Number.isFinite(w.y)) {
    const x = Math.round(w.x), y = Math.round(w.y);
    let visible = false;
    try {
      visible = require('electron').screen.getAllDisplays().some(d => {
        const a = d.workArea;
        // 至少要有 80×40 的标题栏区域落在某块屏幕里，用户才抓得住窗口
        return x < a.x + a.width - 80 && x + out.width > a.x + 80 &&
               y < a.y + a.height - 40 && y + out.height > a.y + 20;
      });
    } catch (_) { visible = false; }
    if (visible) { out.x = x; out.y = y; }
  }
  return out;
}

/**
 * 让窗口在移动/缩放/最大化/关闭时把几何写回现场。
 * 返回一个「立即保存」函数，退出路径可以直接调。
 */
function trackWindow(win) {
  if (!win || !win.on) return () => {};
  let timer = null;

  const save = () => {
    try {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      // 最大化/全屏时 getBounds 会是整屏，用 getNormalBounds 记住「还原后」的大小
      const b = (win.isMaximized() || win.isFullScreen()) ? win.getNormalBounds() : win.getBounds();
      write({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() } });
    } catch (_) { /* 窗口正在销毁时忽略 */ }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 600); };

  win.on('resize', later);
  win.on('move', later);
  win.on('maximize', save);
  win.on('unmaximize', save);
  win.on('close', () => { clearTimeout(timer); save(); });
  win.on('closed', () => clearTimeout(timer));
  return save;
}

module.exports = { KEY, DEF, init, read, write, clear, windowState, trackWindow };
