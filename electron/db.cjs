'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;
let documentsDir = '';

/** 默认工作区（跟随用户文档目录，纯英文文件名；llama.cpp / ComfyUI / ffmpeg 对中文路径支持差） */
function defaultWorkspace() {
  return path.join(documentsDir || require('os').homedir(), 'AIComic-workspace');
}

/** 目录迁移映射：旧前缀 → 新前缀。以后改路径在这里追加一行即可。 */
const PATH_MIGRATIONS = [];

function init(userDataDir, documents) {
  documentsDir = documents;
  fs.mkdirSync(userDataDir, { recursive: true });
  db = new Database(path.join(userDataDir, 'studio.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY, value TEXT
    );
    CREATE TABLE IF NOT EXISTS projects(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS folders(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      parent_id INTEGER REFERENCES folders(id),
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS episodes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      folder_id INTEGER REFERENCES folders(id),
      name TEXT NOT NULL,
      stage_done TEXT NOT NULL DEFAULT '[false,false,false,false,false,false,false]',
      active_stage INTEGER NOT NULL DEFAULT 0,
      chapter_text TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // 表结构升级（老库也要能跑）：新增列用「先查 pragma 再 ALTER」的方式
  addColumn('episodes', 'stage_meta', "TEXT NOT NULL DEFAULT '{}'");

  // 历史路径迁移（目录改为纯英文路径后，把库里残留的旧路径改写成新路径）
  migratePaths();

  // 默认工作区（可在应用内更改）
  if (!getSetting('workspace')) {
    fs.mkdirSync(defaultWorkspace(), { recursive: true });
    setSetting('workspace', defaultWorkspace());
  } else {
    // 目录被外部删除时兜底重建，避免应用起来就报错
    try { fs.mkdirSync(getSetting('workspace'), { recursive: true }); } catch (_) {}
  }
}

/** 新增列（幂等）：兼容已有数据库文件，不需要用户删库重来 */
function addColumn(table, col, def) {
  try {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);
    if (!cols.includes(col)) db.prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + def).run();
  } catch (_) { /* 升级失败不阻塞启动 */ }
}

/** 把库里残留的旧路径（中文目录/独立 runtime 目录）改写为新前缀 */function migratePaths() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  for (const r of rows) {
    const v = String(r.value || '');
    for (const [from, to] of PATH_MIGRATIONS) {
      if (v.toLowerCase().startsWith(from.toLowerCase())) {
        const nv = to + v.slice(from.length);
        setSetting(r.key, nv);
        break;
      }
    }
  }
}

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

module.exports = {
  init, getSetting, setSetting,
  get raw() { return db; },
  get documentsDir() { return documentsDir; }
};
