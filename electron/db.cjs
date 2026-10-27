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

  // 分辨率配置（2026-09-20）：项目级 = 新建剧集的初始模板；剧集级 = 实际生效值。
  // 格式统一为 '宽x高' 字符串（如 '864x480'），宽高比由前端选项文案标注。
  addColumn('projects', 'res_img', "TEXT NOT NULL DEFAULT '1920x1080'");
  addColumn('projects', 'res_vid', "TEXT NOT NULL DEFAULT '864x480'");
  // 成片分辨率：默认 'auto'（跟随第一个镜头的实际分辨率）——2026-10-19 起
  addColumn('projects', 'res_out', "TEXT NOT NULL DEFAULT 'auto'");
  addColumn('episodes', 'res_img', "TEXT NOT NULL DEFAULT '1920x1080'");
  addColumn('episodes', 'res_vid', "TEXT NOT NULL DEFAULT '864x480'");
  addColumn('episodes', 'res_out', "TEXT NOT NULL DEFAULT 'auto'");

  // 视频生成档位（2026-09-24）：项目级设置，在「新建项目 / 项目配置」里和分辨率一起选。
  // 与分辨率不同 —— 档位对本项目**所有剧集立即生效**（生成时实时读项目行），
  // 不做集级快照，因此只在 projects 上建列（episodes 无此列）。
  addColumn('projects', 'res_tier', "TEXT NOT NULL DEFAULT 'balanced'");

  // 风格包（2026-10-07）：项目级题材 / 画风（如古装 / 现代都市 / 二次元）。
  // 与档位同理 —— 对本项目**所有剧集立即生效**（渲染层每次读规范时实时读项目行），
  // 不做集级快照，因此只在 projects 上建列。默认值 = 改造前的唯一风格，
  // 存量项目自动落到它，行为与改造前一致（规范正文经风格包替换后逐字不变）。
  addColumn('projects', 'style', "TEXT NOT NULL DEFAULT 'guofeng-real'");

  // 单集目标时长（2026-10-13）：双轨配时的第二根轨 —— 镜数不再由字数推，而由
  // 「目标时长 T × 画面单元数 B」推（见 src/promptlib.js 的 pacingPlan）。
  // '0' = 未设置 → 整层惰性（老项目行为与改造前逐字不变）。
  // 与档位 / 风格同理 —— 项目级、对本项目所有剧集立即生效（生成时实时读项目行），不做集级快照。
  addColumn('projects', 'target_sec', "TEXT NOT NULL DEFAULT '0'");

  // 声音档位（2026-10-20）：项目级 'full' | 'dialogue'
  //   full     = 默认，保留 BGM 与环境底噪（rev17/18 的跨镜连续 + 让路那一整套）
  //   dialogue = 纯对白：提示词层让模型完全**不写** BGM 与环境音（H3 是单轨混音，事后分不出人声轨，
  //              所以只能在源头控制；overall_soundscape / non_diegetic_music 都写 N/A）
  // 与档位 / 风格同理 —— 项目级、对本项目所有剧集立即生效（生成提示词时实时读项目行），不做集级快照。
  addColumn('projects', 'audio_mode', "TEXT NOT NULL DEFAULT 'full'");

  // 自动填充首帧（2026-10-26）：项目级 '0' | '1'（布尔）
  //   0 = 默认，视频按各自提示词独立生成（改造前行为）
  //   1 = 每次生成视频（单镜 & 批量）时逐镜接力：取上一镜末帧填本镜首帧 → 重生成提示词 → 生成视频
  // 与档位 / 风格同理 —— 项目级、对本项目所有剧集立即生效，不做集级快照。
  addColumn('projects', 'auto_chain_first', "TEXT NOT NULL DEFAULT '0'");

  // 视频比例（2026-10-15）：项目级 '16:9' | '9:16'，是「档位 + 比例 → 三个分辨率推荐值」的两个上游输入之一。
  // 🔴 **可空、且不设默认值**：存量项目的这一列是 NULL，读时由 `readRes` 按 res_vid 的宽高推断
  //    （宽>高 → 16:9，宽<高 → 9:16），所以老项目打开配置弹窗时比例是**推断出来的**而非猜的，
  //    行为与改造前完全一致，也不会因为猜错比例而把老项目的分辨率改掉。
  //    只在用户**显式点了比例**时才写入（COALESCE 语义）。
  addColumn('projects', 'aspect', 'TEXT');

  // 成片分辨率改为「自动」为默认（2026-10-19，Dragon 要求）：
  // 存量库里的 '1920x1080' 全部来自当年列的默认值，不是用户人工选的 → 一次性改成 'auto'。
  // 🔴 用 settings 打标只跑一次：用户之后手动把某一集选回 1920×1080 时**不会**再被改回去。
  if (!getSetting('mig_res_out_auto')) {
    try {
      db.prepare("UPDATE projects SET res_out='auto' WHERE res_out='1920x1080'").run();
      db.prepare("UPDATE episodes SET res_out='auto' WHERE res_out='1920x1080'").run();
    } catch (_) { /* 迁移失败不阻塞启动：下拉里也能手动选「自动」 */ }
    setSetting('mig_res_out_auto', '1');
  }
  // 竖版同理：'1080x1920' 也是旧代码按比例自动填的推荐值（不是用户人工选的）。
  // 单独一个标记 —— 已经跑过上面那步的库也要再跑这一步。
  if (!getSetting('mig_res_out_auto_portrait')) {
    try {
      db.prepare("UPDATE projects SET res_out='auto' WHERE res_out='1080x1920'").run();
      db.prepare("UPDATE episodes SET res_out='auto' WHERE res_out='1080x1920'").run();
    } catch (_) { /* 同上 */ }
    setSetting('mig_res_out_auto_portrait', '1');
  }

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
