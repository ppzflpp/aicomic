'use strict';
const path = require('path');
const fs = require('fs');
const { sanitize, copyDir: copyDirTree } = require('./assetStore.cjs');
const prompts = require('./prompts.cjs');
const videoTiers = require('./videoTiers.cjs');
const styles = require('./styles.cjs');

/* ---------- 路径工具（2026-09-24 扁平化：项目下只留 剧本/分镜/成片 三个平铺目录） ----------
 *
 *  <工作区>/projects/<项目>/
 *    剧本/    <集名>.chapter.txt / <集名>.adapted.md / <集名>.shots.json / <集名>.chars.json
 *             / <集名>.scenes.json / <集名>.prompts.json / <集名>.videos.json / <集名>.revs.json
 *    分镜/    <集名>_shot_1.mp4（同集多版本追加 _02；换集靠文件名前缀区分）
 *    成片/    <集名>_<时间戳>.mp4
 *    assets/  角色图 / 场景图（项目级资产：跨集共用同一张脸）
 *    prompts/ 项目级提示词规范 md
 *
 *  集与集在磁盘上**只靠文件名前缀（集名）区分**，不再有集数子目录。
 *  ⚠️ 因此同一项目内集名必须唯一（addEpisode 会校验），否则文件会互相覆盖。
 *  ⚠️「文件夹」仍存在于数据库与左侧树（用于归类集数），但不再映射到磁盘目录。
 */

/** 文件名前缀 = 集名（消毒后） */
function epPrefix(ep) { return sanitize(ep.name) }

/** 剧本工件目录：<项目>/剧本（全项目的剧本工件都平铺在这里） */
function episodeDir(db, workspace, ep) {
  const root = projectRoot(db, workspace, ep.project_id);
  return root ? path.join(root, '剧本') : null;
}

/** 某集某个工件的完整路径：<项目>/剧本/<集名>.shots.json */
function artifactPath(db, workspace, ep, name) {
  const dir = episodeDir(db, workspace, ep);
  return dir ? path.join(dir, epPrefix(ep) + '.' + name) : null;
}

function touchDir(db, workspace, ep) {
  const dir = episodeDir(db, workspace, ep);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------- 项目根 / 资产 / 媒体目录 ---------- */

/** 项目根目录：<工作区>/projects/<项目名> */
function projectRoot(db, workspace, projectId) {
  const p = db.raw.prepare('SELECT name FROM projects WHERE id=?').get(projectId);
  if (!p) return null;
  return path.join(workspace, 'projects', sanitize(p.name));
}

/** 项目资产根：<项目>/assets */
function assetsRoot(db, workspace, projectId) {
  const r = projectRoot(db, workspace, projectId);
  return r ? path.join(r, 'assets') : null;
}

/** 角色图目录：<项目>/assets/characters/<角色名> */
function characterDir(db, workspace, projectId, charName) {
  const a = assetsRoot(db, workspace, projectId);
  return a ? path.join(a, 'characters', sanitize(charName)) : null;
}

/** 场景图目录：<项目>/assets/scenes/<场景名> */
function sceneDir(db, workspace, projectId, sceneName) {
  const a = assetsRoot(db, workspace, projectId);
  return a ? path.join(a, 'scenes', sanitize(sceneName)) : null;
}

/**
 * 集私有素材根：<项目>/assets/episodes/<集名前缀>
 * 🔴 集名在项目内唯一且不可改（addEpisode 保证唯一；没有改名功能）→ 可安全当目录名。
 * 分工：assets/{characters,scenes}/ = 项目角色场景库的**共享素材**（libReadonly=true 的卡看这里）；
 *      assets/episodes/<集>/ = **本集自己的素材**（libReadonly=false 的卡看这里，跨集互不污染）。
 */
function episodeAssetsRoot(db, workspace, ep) {
  const a = assetsRoot(db, workspace, ep.project_id);
  return a ? path.join(a, 'episodes', sanitize(ep.name)) : null;
}

/** 集私有素材下的类型目录：<集私有根>/characters 或 /scenes */
function episodeKindDir(db, workspace, ep, kind) {
  const r = episodeAssetsRoot(db, workspace, ep);
  return r ? path.join(r, kind === 'scene' ? 'scenes' : 'characters') : null;
}

/**
 * 归档「不再出现的角色 / 场景」的图片目录（2026-10-07）。
 *
 * 重新生成分镜的语义是**从零开始**：新分镜里没提到的角色/场景，档案与卡片都不该留。
 * 但那些图是花显卡时间出的，不能一声不吭删掉 → **移动**到
 *   <集私有素材根>/_trash/<时间戳>/{characters,scenes}/<名字>/
 * UI 上干干净净，想找回时去 _trash 里按时间戳翻。
 *
 * 🔴 只处理**集私有**素材（card.libReadonly !== true 的那批）。库条目的图是跨集共享的，
 *    归档它会连带毁掉别的集 → 调用方负责过滤，这里只按传进来的名字动手。
 * 🔴 禁用 fs.cpSync（中文路径段错误）→ renameSync 优先，失败退回 copyDir 手写拷贝 + 删源。
 *
 * @param {Array<{kind:'character'|'scene', name:string}>} items 要归档的名字
 * @returns {{moved:string[], failed:string[], trashDir:string|null}}
 */
function archiveEpisodeAssets(db, workspace, ep, items) {
  const out = { moved: [], failed: [], trashDir: null };
  const list = (Array.isArray(items) ? items : []).filter(x => x && x.name);
  if (!list.length || !ep) return out;
  const root = episodeAssetsRoot(db, workspace, ep);
  if (!root) return out;
  const trashDir = path.join(root, '_trash', String(Date.now()));
  for (const it of list) {
    const kind = it.kind === 'scene' ? 'scene' : 'character';
    const from = path.join(episodeKindDir(db, workspace, ep, kind), sanitize(it.name));
    if (!fs.existsSync(from)) continue;          // 本来就没图（没出过图）→ 无图可归档
    const to = path.join(trashDir, kind === 'scene' ? 'scenes' : 'characters', sanitize(it.name));
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      try {
        fs.renameSync(from, to);                 // 同盘：瞬间完成
      } catch (_) {
        const n = copyDirTree(from, to);         // 跨盘 / 被占用 → 手写拷贝（绕开 cpSync 的段错误）
        if (!n) throw new Error('拷贝失败');
        fs.rmSync(from, { recursive: true, force: true });
      }
      out.moved.push((kind === 'scene' ? 'scenes/' : 'characters/') + it.name);
    } catch (err) {
      out.failed.push(it.name + '（' + ((err && err.message) || err) + '）');
    }
  }
  out.trashDir = out.moved.length ? trashDir : null;
  return out;
}

/**
 * 幂等迁移：把「本集自己的卡」（chars/scenes.json 里 libReadonly !== true 的卡）的图目录
 * 从项目共享素材目录**复制**到集私有目录。
 *   - libReadonly === true 的卡 = 库条目的只读视图 → 图归库，原地不动
 *   - 其它卡（手动新增的、入库后本集仍可编辑的）→ 图归本集
 * 🔴 只复制、不删原目录 —— 要回退就删掉 assets/episodes 目录，图一份没少。
 * 🔴 复制走 assetStore.copyDir，**不要用 fs.cpSync**：Node 在 Windows 上对中文路径
 *    （「路人甲」这种）调 cpSync 会直接段错误把进程干掉（2026-10-07 实测）。
 * @returns 实际搬动的 "<类型>/<名字>" 列表
 */
function migrateEpisodePrivateAssets(db, workspace, ep) {
  const aRoot = assetsRoot(db, workspace, ep.project_id);
  if (!aRoot) return [];
  const eName = sanitize(ep.name);
  const moved = [];
  for (const [file, sub] of [['chars.json', 'characters'], ['scenes.json', 'scenes']]) {
    const p = artifactPath(db, workspace, ep, file);
    if (!p || !fs.existsSync(p)) continue;
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { continue; }
    if (!Array.isArray(arr)) continue;
    for (const c of arr) {
      if (!c || !c.name) continue;
      if (c.libReadonly === true) continue;            // 库条目的只读视图：图归库
      const id = sanitize(c.name);
      const src = path.join(aRoot, sub, id);
      const dst = path.join(aRoot, 'episodes', eName, sub, id);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      const n = copyDirTree(src, dst);                 // 单条失败返回 0，不挡其它
      if (n > 0) moved.push(sub + '/' + id);
    }
  }
  return moved;
}

/** 镜头视频目录（项目级共享，不再按集建子目录）：<项目>/分镜 */
function shotDir(db, workspace, ep) {
  const root = projectRoot(db, workspace, ep.project_id);
  return root ? path.join(root, '分镜') : null;
}

/** 成片目录（项目级共享）：<项目>/成片 */
function filmDir(db, workspace, ep) {
  const root = projectRoot(db, workspace, ep.project_id);
  return root ? path.join(root, '成片') : null;
}

/** 建好项目目录骨架（新建项目时调用；老项目打开时也补建，幂等） */
function ensureProjectDirs(db, workspace, projectId) {
  const root = projectRoot(db, workspace, projectId);
  if (!root) return null;
  const dirs = [
    path.join(root, '剧本'),
    path.join(root, 'assets', 'characters'),
    path.join(root, 'assets', 'scenes'),
    path.join(root, '分镜'),
    path.join(root, '成片')
  ];
  for (const d of dirs) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
  return root;
}

/** 项目下全部集（带三套目录 + 文件名前缀），供左侧树的媒体节点列举使用 */
function listProjectEpisodes(db, workspace, projectId) {
  const rows = db.raw.prepare('SELECT * FROM episodes WHERE project_id=? ORDER BY id').all(projectId);
  return rows.map(ep => ({
    id: ep.id,
    name: ep.name,
    prefix: epPrefix(ep),
    dir: episodeDir(db, workspace, ep),
    shotDir: shotDir(db, workspace, ep),
    filmDir: filmDir(db, workspace, ep)
  }));
}

/* ---------- 左侧树「剧本」节点：列举剧本工件 ---------- */

/**
 * 「剧本」节点要展示的工件（顺序 = 显示顺序）。
 * 只列用户看得懂、有意义的工件；revs.json / prompts.json / videos.json 是纯机器状态
 * （脏标记计数、每镜提示词、每镜视频记录），功能区里都能看到，不在这里外露。
 */
const SCRIPT_KINDS = [
  { name: 'chapter.txt', label: '章节原文', ico: '📄' },
  { name: 'adapted.md', label: '改编稿', ico: '📝' },
  { name: 'shots.json', label: '分镜脚本', ico: '🎬' },
  { name: 'chars.json', label: '角色档案', ico: '🧑' },
  { name: 'scenes.json', label: '场景档案', ico: '🏞' }
];

/**
 * 按集列举「剧本」目录下的工件文件（扁平化后一个目录平铺全项目工件，靠**集名前缀**归集）。
 * 🔴 只报磁盘上真实存在的文件（没生成过的不显示）→ 树里看到的和磁盘完全一致。
 * 返回：[{ episodeId, name, dir, files: [{file, path, label, ico, size, mtimeMs}] }]
 */
function listProjectScripts(db, workspace, projectId) {
  const root = ensureProjectDirs(db, workspace, projectId);
  if (!root) return [];
  const dir = path.join(root, '剧本');
  const out = [];
  for (const ep of listProjectEpisodes(db, workspace, projectId)) {
    const files = [];
    for (const k of SCRIPT_KINDS) {
      const file = ep.prefix + '.' + k.name;
      const abs = path.join(dir, file);
      let st = null;
      try { st = fs.statSync(abs); } catch (_) { continue; }
      files.push({ file, path: abs, label: k.label, ico: k.ico, size: st.size, mtimeMs: st.mtimeMs });
    }
    if (files.length) out.push({ episodeId: ep.id, name: ep.name, dir, files });
  }
  return out;
}

/* ---------- 分辨率配置 ---------- */

/** 规整一个分辨率值：'宽x高'，非法时返回 null */
function normRes(v) {
  const m = /^(\d{2,5})x(\d{2,5})$/i.exec(String(v || '').trim());
  if (!m) return null;
  const w = +m[1], h = +m[2];
  if (w < 16 || h < 16 || w > 8192 || h > 8192) return null;
  return w + 'x' + h;
}

/** 规整 {img,vid,out,tier} 四元组；分辨率全部非法则返回 null（tier 非法 → 回默认档） */
function normResAll(res) {
  if (!res || typeof res !== 'object') return null;
  const img = normRes(res.img), vid = normRes(res.vid), out = normRes(res.out);
  // style 与分辨率同路提交，但它**不是分辨率** —— 所以不能进那个「三个都空就返回 null」的判断
  const style = res.style == null ? null : (String(res.style).trim() || null);
  if (!img && !vid && !out && !style) return null;
  // tier 是项目级视频档位，与分辨率同路存取（渲染层一次提交四个值）
  const tier = res.tier == null ? null : videoTiers.normalizeTier(res.tier);
  return { img, vid, out, tier, style };
}

function readRes(row) {
  const r = { img: row.res_img, vid: row.res_vid, out: row.res_out };
  // 只有 projects 有 res_tier 列（剧集不带档位，生成时实时读所属项目）
  if (row.res_tier != null) r.tier = videoTiers.normalizeTier(row.res_tier);
  // 同理只有 projects 有 style 列：剧集的风格在「读提示词规范」时实时读所属项目，
  // 不做集级快照 —— 改风格对本项目全部剧集立即生效（跟档位一致）
  if (row.style != null) r.style = String(row.style || '').trim() || styles.defaultId();
  return r;
}

/** 读项目级配置：分辨率（= 新建剧集的初始模板）+ 视频档位（对本项目全部剧集立即生效） */
function getProjectRes(db, projectId) {
  const p = db.raw.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  return p ? readRes(p) : null;
}

/**
 * 改项目配置（分辨率 + 视频档位）。
 * - 分辨率：只影响之后新建的剧集（新建剧集时拷贝为初始值），绝不回写 episodes；
 * - 视频档位：项目级，**对本项目现有全部剧集立即生效**（生成时实时读项目行）。
 */
function setProjectRes(db, projectId, res) {
  const n = normResAll(res);
  if (!n) throw new Error('分辨率格式不合法（应为 宽x高，如 864x480）');
  db.raw.prepare('UPDATE projects SET res_img=COALESCE(?,res_img), res_vid=COALESCE(?,res_vid), res_out=COALESCE(?,res_out), res_tier=COALESCE(?,res_tier), style=COALESCE(?,style) WHERE id=?')
    .run(n.img, n.vid, n.out, n.tier, n.style, projectId);
  return getProjectRes(db, projectId);
}

/** 读剧集当前生效的分辨率 */
function getEpisodeRes(db, episodeId) {
  const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId);
  return ep ? readRes(ep) : null;
}

/** 改剧集某一类分辨率（kind: img|vid|out），只影响本集后续生成 */
function setEpisodeRes(db, episodeId, kind, value) {
  const col = { img: 'res_img', vid: 'res_vid', out: 'res_out' }[kind];
  if (!col) throw new Error('未知的分辨率类型：' + kind);
  const v = normRes(value);
  if (!v) throw new Error('分辨率格式不合法（应为 宽x高，如 864x480）');
  db.raw.prepare('UPDATE episodes SET ' + col + '=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(v, episodeId);
  return getEpisodeRes(db, episodeId);
}

/* ---------- 项目树 ---------- */

function getTree(db, workspace) {
  const projects = db.raw.prepare('SELECT * FROM projects ORDER BY id').all();
  const folders = db.raw.prepare('SELECT * FROM folders ORDER BY id').all();
  const episodes = db.raw.prepare('SELECT id,project_id,folder_id,name,updated_at FROM episodes ORDER BY id').all();

  return projects.map(p => {
    // 顺手把项目目录骨架补齐（新建项目已建；直接放在工作区里的老项目靠这里兜底）
    ensureProjectDirs(db, workspace, p.id);
    const pf = folders.filter(f => f.project_id === p.id);
    // 递归构树
    const build = (parentId) => pf
      .filter(f => (f.parent_id || null) === parentId)
      .map(f => ({ id: f.id, name: f.name, folders: build(f.id), episodes: episodes.filter(e => e.folder_id === f.id) }));
    return {
      id: p.id,
      name: p.name,
      res: readRes(p),
      folders: build(null),
      episodes: episodes.filter(e => e.folder_id === null && e.project_id === p.id)
    };
  });
}

/* ---------- CRUD ---------- */

function createProject(db, workspace, name, res) {
  const clean = sanitize(name);
  const n = normResAll(res) || {};
  const img = n.img || '1920x1080', vid = n.vid || '864x480', out = n.out || '1920x1080';
  const tier = n.tier || videoTiers.DEFAULT_TIER;   // 视频档位：项目级，随项目一起落库
  const style = n.style || styles.defaultId();      // 风格包：项目级，新建时选定
  const info = db.raw.prepare('INSERT INTO projects(name,res_img,res_vid,res_out,res_tier,style) VALUES(?,?,?,?,?,?)')
    .run(clean, img, vid, out, tier, style);
  const pid = info.lastInsertRowid;
  // 第一集：直接用刚创建的项目分辨率初始化
  db.raw.prepare('INSERT INTO episodes(project_id,folder_id,name,res_img,res_vid,res_out) VALUES(?,NULL,?,?,?,?)').run(pid, '第1集', img, vid, out);
  // 项目目录骨架：assets/characters、assets/scenes、分镜、成片
  ensureProjectDirs(db, workspace, pid);
  // 项目级提示词文件（<项目>/prompts/*.md）：新建项目即播种一份可编辑拷贝
  try { prompts.seedAt(ensureProjectDirs(db, workspace, pid)); } catch (_) {}
  return { id: pid };
}

function addFolder(db, workspace, projectId, parentId, name) {
  const info = db.raw.prepare('INSERT INTO folders(project_id,parent_id,name) VALUES(?,?,?)')
    .run(projectId, parentId, sanitize(name));
  return { id: info.lastInsertRowid };
}

function addEpisode(db, workspace, projectId, folderId, name) {
  // 新建剧集：分辨率用项目当前配置初始化（项目配置改了只影响从现在起新建的剧集）
  const p = db.raw.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  const img = (p && p.res_img) || '1920x1080', vid = (p && p.res_vid) || '864x480', out = (p && p.res_out) || '1920x1080';
  // 🔴 扁平化后集名就是磁盘文件名前缀：同项目内必须唯一，否则两集的 shots / 视频会互相覆盖。
  //    重名自动加序号（「第1集」→「第1集 (2)」），并把最终名字返回给渲染层。
  const base = sanitize(name);
  const taken = new Set(db.raw.prepare('SELECT name FROM episodes WHERE project_id=?').all(projectId).map(r => r.name));
  let final = base, n = 2;
  while (taken.has(final)) { final = base + ' (' + (n++) + ')'; }
  const info = db.raw.prepare('INSERT INTO episodes(project_id,folder_id,name,res_img,res_vid,res_out) VALUES(?,?,?,?,?,?)')
    .run(projectId, folderId, final, img, vid, out);
  return { id: info.lastInsertRowid, name: final };
}

/** 阶段耗时/生成耗时元数据（存在 episodes.stage_meta，JSON） */
function parseMeta(ep) {
  try { return JSON.parse((ep && ep.stage_meta) || '{}') || {}; } catch (_) { return {}; }
}

function getEpisode(db, workspace, episodeId) {
  const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId);
  if (!ep) return null;
  const dir = touchDir(db, workspace, ep);
  let chapter = ep.chapter_text || '';
  let adapted = '';
  const chapFile = artifactPath(db, workspace, ep, 'chapter.txt');
  const adapFile = artifactPath(db, workspace, ep, 'adapted.md');
  if (chapFile && fs.existsSync(chapFile)) chapter = fs.readFileSync(chapFile, 'utf-8');
  if (adapFile && fs.existsSync(adapFile)) adapted = fs.readFileSync(adapFile, 'utf-8');
  return { id: ep.id, name: ep.name, projectId: ep.project_id, dir, prefix: epPrefix(ep), chapter, adapted, done: JSON.parse(ep.stage_done), activeStage: ep.active_stage, stageMeta: parseMeta(ep) };
}

function saveChapter(db, workspace, episodeId, text) {
  const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId);
  if (!ep) return false;
  touchDir(db, workspace, ep);
  fs.writeFileSync(artifactPath(db, workspace, ep, 'chapter.txt'), text, 'utf-8');
  db.raw.prepare('UPDATE episodes SET chapter_text=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(text, episodeId);
  // 章节变化 → 下游「改编稿」的脏标记依据（revs.chapter 自增；改编稿记的 adaptedChapter 与之不等就提示）
  const revs = bumpRevs(db, workspace, ep, r => { r.chapter = (r.chapter || 0) + 1 });
  return revs;
}

function saveAdapted(db, workspace, episodeId, text) {
  const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId);
  if (!ep) return false;
  touchDir(db, workspace, ep);
  fs.writeFileSync(artifactPath(db, workspace, ep, 'adapted.md'), text, 'utf-8');
  return true;
}

function saveState(db, episodeId, done, active, meta) {
  db.raw.prepare('UPDATE episodes SET stage_done=?, active_stage=?, stage_meta=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
    .run(JSON.stringify(done), active, JSON.stringify(meta || {}), episodeId);
  return true;
}

/* ---------- 删除 ---------- */

function folderIdsUnder(db, folderId) {
  const out = [folderId];
  const walk = (pid) => {
    for (const f of db.raw.prepare('SELECT id FROM folders WHERE parent_id=?').all(pid)) {
      out.push(f.id);
      walk(f.id);
    }
  };
  walk(folderId);
  return out;
}

/**
 * 删集：扁平化后**不能**删目录（剧本/分镜/成片 是全项目共用的），
 * 只删「以该集名为前缀」的工件与媒体文件（<集名>.* / <集名>_*.mp4）。
 * 封面缓存 .<文件名>.poster.jpg 一起删；成片元信息 .meta.json 里的对应键也清掉。
 */
function deleteEpisodeRows(db, workspace, epIds) {
  for (const id of epIds) {
    const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(id);
    if (!ep) continue;
    const pre = epPrefix(ep);
    const targets = [
      { dir: episodeDir(db, workspace, ep), re: new RegExp('^' + escRe(pre) + '\\.') },
      { dir: shotDir(db, workspace, ep), re: new RegExp('^' + escRe(pre) + '_') },
      { dir: filmDir(db, workspace, ep), re: new RegExp('^' + escRe(pre) + '_') }
    ];
    for (const t of targets) {
      if (!t.dir || !fs.existsSync(t.dir)) continue;
      let files = [];
      try { files = fs.readdirSync(t.dir); } catch (_) { continue; }
      for (const f of files) {
        if (f === '.meta.json') { pruneMeta(t.dir, t.re, f); continue; }
        if (!t.re.test(f)) continue;
        try { fs.rmSync(path.join(t.dir, f), { force: true }); } catch (_) {}
        try { fs.rmSync(path.join(t.dir, '.' + f + '.poster.jpg'), { force: true }); } catch (_) {}
      }
    }
    db.raw.prepare('DELETE FROM episodes WHERE id=?').run(id);
  }
}

/** 正则元字符转义（集名可能含 ( ) . 等） */
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 成片目录元信息缓存：清掉被删文件名对应的键（文件已删，留着会变成幽灵记录） */
function pruneMeta(dir, re, metaName) {
  const p = path.join(dir, metaName);
  try {
    const cache = JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
    let hit = false;
    for (const k of Object.keys(cache)) { if (re.test(k)) { delete cache[k]; hit = true; } }
    if (hit) fs.writeFileSync(p, JSON.stringify(cache), 'utf-8');
  } catch (_) { /* 读不到/写不了都不影响删集 */ }
}

function deleteEpisode(db, workspace, episodeId) {
  deleteEpisodeRows(db, workspace, [episodeId]);
  return true;
}

function deleteFolder(db, workspace, folderId) {
  const ids = folderIdsUnder(db, folderId);
  const epIds = db.raw.prepare(
    `SELECT id FROM episodes WHERE folder_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids).map(r => r.id);
  deleteEpisodeRows(db, workspace, epIds);
  for (const id of ids) db.raw.prepare('DELETE FROM folders WHERE id=?').run(id);
  return true;
}

function deleteProject(db, workspace, projectId) {
  const proj = db.raw.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!proj) return false;
  const folderIds = db.raw.prepare('SELECT id FROM folders WHERE project_id=?').all(projectId).map(r => r.id);
  const epIds = db.raw.prepare('SELECT id FROM episodes WHERE project_id=?').all(projectId).map(r => r.id);
  deleteEpisodeRows(db, workspace, epIds);
  for (const id of folderIds) db.raw.prepare('DELETE FROM folders WHERE id=?').run(id);
  db.raw.prepare('DELETE FROM projects WHERE id=?').run(projectId);
  try { fs.rmSync(path.join(workspace, 'projects', sanitize(proj.name)), { recursive: true, force: true }); } catch (_) {}
  return true;
}

/* ---------- 集数全量工件 ---------- */

function readJson(dir, name, fallback) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return fallback; }
}

/** 脏标记计数器（<集名>.revs.json）：chapter/adapted 自增，下游据此判断「上游已变化」 */
function readRevs(db, workspace, ep) { return readJson(episodeDir(db, workspace, ep), epPrefix(ep) + '.revs.json', {}); }
function writeRevs(db, workspace, ep, revs) { writeJson(episodeDir(db, workspace, ep), epPrefix(ep) + '.revs.json', revs); }
function bumpRevs(db, workspace, ep, fn) {
  const r = readRevs(db, workspace, ep);
  fn(r);
  writeRevs(db, workspace, ep, r);
  return r;
}

function writeJson(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2), 'utf-8');
}

function getEpisodeFull(db, workspace, episodeId) {
  const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId);
  if (!ep) return null;
  const dir = touchDir(db, workspace, ep);
  const pre = epPrefix(ep);
  const read = (n) => {
    const p = artifactPath(db, workspace, ep, n);
    return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  };
  // 项目级媒体目录（角色图 / 镜头视频 / 成片都归到项目下，见文件顶部目录说明）
  const pRoot = ensureProjectDirs(db, workspace, ep.project_id);
  const aRoot = assetsRoot(db, workspace, ep.project_id);
  const sDir = shotDir(db, workspace, ep);
  const fDir = filmDir(db, workspace, ep);
  try { fs.mkdirSync(sDir, { recursive: true }); } catch (_) {}
  // 集私有素材目录：本集自己的卡（libReadonly !== true）看这里；库共享素材仍在 aRoot 下。
  // 老项目第一次打开时做一次幂等迁移（把本集卡的图从共享目录**复制**过来，只复制不删）。
  const epRoot = episodeAssetsRoot(db, workspace, ep);
  if (epRoot && !fs.existsSync(epRoot)) {
    migrateEpisodePrivateAssets(db, workspace, ep);
    try { fs.mkdirSync(epRoot, { recursive: true }); } catch (_) {}
  }
  // 🔴 分镜/成片目录是全项目共用的 → 只挑「本集前缀」的文件（<集名>_shot_1.mp4 / <集名>_时间戳.mp4）
  const mine = (dirPath, re) => {
    if (!dirPath || !fs.existsSync(dirPath)) return [];
    let files = [];
    try { files = fs.readdirSync(dirPath); } catch (_) { return []; }
    return files.filter(f => re.test(f)).sort();
  };
  const videoFiles = mine(sDir, new RegExp('^' + escRe(pre) + '_', 'i'));
  const exportFiles = mine(fDir, new RegExp('^' + escRe(pre) + '_' + '.*\\.mp4$', 'i'));
  return {
    id: ep.id, name: ep.name, projectId: ep.project_id, dir, prefix: pre,
    projectDir: pRoot, assetsDir: aRoot, epAssetsDir: epRoot, shotDir: sDir, filmDir: fDir,
    // 风格包（项目级）：渲染层每次读提示词规范都要用它，所以随集对象一起下发 ——
    // 免得每读一份规范都回主进程查一次项目行。
    style: (db.raw.prepare('SELECT style FROM projects WHERE id=?').get(ep.project_id) || {}).style || styles.defaultId(),
    res: readRes(ep),
    chapter: read('chapter.txt'),
    adapted: read('adapted.md'),
    revs: readJson(dir, pre + '.revs.json', {}),
    shots: readJson(dir, pre + '.shots.json', []),
    chars: readJson(dir, pre + '.chars.json', []),
    scenes: readJson(dir, pre + '.scenes.json', []),
    prompts: readJson(dir, pre + '.prompts.json', []),
    videoState: readJson(dir, pre + '.videos.json', {}),
    videoFiles,
    exportFile: exportFiles.length ? exportFiles[exportFiles.length - 1] : null,
    done: JSON.parse(ep.stage_done), activeStage: ep.active_stage,
    stageMeta: parseMeta(ep)
  };
}

function saveArtifact(db, workspace, episodeId, kind, data) {
  const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId);
  if (!ep) return false;
  touchDir(db, workspace, ep);
  if (kind === 'adapted') {
    fs.writeFileSync(artifactPath(db, workspace, ep, 'adapted.md'), String(data), 'utf-8');
    // 改编稿变化（生成/编辑/确认都算）→ 下游「角色&场景 / 分镜」的脏标记依据
    return bumpRevs(db, workspace, ep, r => { r.adapted = (r.adapted || 0) + 1 });
  }
  const write = (n) => writeJson(episodeDir(db, workspace, ep), epPrefix(ep) + '.' + n, data);
  if (kind === 'shots') write('shots.json');
  else if (kind === 'chars') write('chars.json');
  else if (kind === 'scenes') write('scenes.json');
  else if (kind === 'prompts') write('prompts.json');
  else if (kind === 'videoState') write('videos.json');
  else if (kind === 'revs') write('revs.json');
  db.raw.prepare('UPDATE episodes SET updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(episodeId);
  return true;
}

module.exports = {
  getTree, createProject, addFolder, addEpisode, getEpisode, saveChapter, saveAdapted, saveState, episodeDir, artifactPath, epPrefix,
  deleteProject, deleteFolder, deleteEpisode, getEpisodeFull, saveArtifact,
  getProjectRes, setProjectRes, getEpisodeRes, setEpisodeRes, normRes,
  // 项目级目录（资产 / 分镜 / 成片）
  projectRoot, assetsRoot, characterDir, sceneDir, shotDir, filmDir, ensureProjectDirs, listProjectEpisodes,
  // 集私有素材（本集自己的角色/场景图）：与库共享素材分开，跨集互不污染
  episodeAssetsRoot, episodeKindDir, migrateEpisodePrivateAssets, archiveEpisodeAssets,
  // 左侧树「剧本」节点：按集列举剧本工件
  listProjectScripts, SCRIPT_KINDS
};
