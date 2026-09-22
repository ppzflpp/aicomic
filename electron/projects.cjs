'use strict';
const path = require('path');
const fs = require('fs');
const { sanitize } = require('./assetStore.cjs');
const prompts = require('./prompts.cjs');

/* ---------- 路径工具 ---------- */

// 文件夹链（含自身）路径段
function folderChain(db, folderId) {
  const segs = [];
  let cur = folderId;
  let guard = 0;
  while (cur && guard++ < 32) {
    const f = db.raw.prepare('SELECT * FROM folders WHERE id=?').get(cur);
    if (!f) break;
    segs.unshift(sanitize(f.name));
    cur = f.parent_id;
  }
  return segs;
}

function episodeDir(db, workspace, ep) {
  const proj = db.raw.prepare('SELECT name FROM projects WHERE id=?').get(ep.project_id);
  const segs = [workspace, 'projects', sanitize(proj.name), ...folderChain(db, ep.folder_id), sanitize(ep.name)];
  return path.join(...segs);
}

function touchDir(db, workspace, ep) {
  const dir = episodeDir(db, workspace, ep);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------- 项目级目录（2026-09-20 重构：资产与媒体都归到项目下） ----------
 *
 *  <工作区>/projects/<项目>/
 *    assets/
 *      characters/<角色名>/      ← 角色图（项目内共享，跨集复用同一张脸）
 *      scenes/<场景名>/          ← 场景图（预留）
 *    分镜/<文件夹链>/<集名>/       ← 该集的全部镜头视频
 *    成片/<文件夹链>/<集名>/       ← 该集的全部成片
 *    <文件夹链>/<集名>/            ← 该集剧本工件（chapter/adapted/shots/chars/prompts）
 *
 *  分镜/成片仍按「集」分子目录：不同集的 shot_1 含义不同，必须隔离（防串号）。
 */

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

/** 某集的镜头视频目录：<项目>/分镜/<文件夹链>/<集名> */
function shotDir(db, workspace, ep) {
  const root = projectRoot(db, workspace, ep.project_id);
  if (!root) return null;
  return path.join(root, '分镜', ...folderChain(db, ep.folder_id), sanitize(ep.name));
}

/** 某集的成片目录：<项目>/成片/<文件夹链>/<集名> */
function filmDir(db, workspace, ep) {
  const root = projectRoot(db, workspace, ep.project_id);
  if (!root) return null;
  return path.join(root, '成片', ...folderChain(db, ep.folder_id), sanitize(ep.name));
}

/** 建好项目目录骨架（新建项目时调用；老项目打开时也补建，幂等） */
function ensureProjectDirs(db, workspace, projectId) {
  const root = projectRoot(db, workspace, projectId);
  if (!root) return null;
  const dirs = [
    path.join(root, 'assets', 'characters'),
    path.join(root, 'assets', 'scenes'),
    path.join(root, '分镜'),
    path.join(root, '成片')
  ];
  for (const d of dirs) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
  return root;
}

/** 项目下全部集（带三套目录），供左侧树的媒体节点列举使用 */
function listProjectEpisodes(db, workspace, projectId) {
  const rows = db.raw.prepare('SELECT * FROM episodes WHERE project_id=? ORDER BY id').all(projectId);
  return rows.map(ep => ({
    id: ep.id,
    name: ep.name,
    dir: episodeDir(db, workspace, ep),
    shotDir: shotDir(db, workspace, ep),
    filmDir: filmDir(db, workspace, ep)
  }));
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

/** 规整 {img,vid,out} 三元组；全部非法则返回 null */
function normResAll(res) {
  if (!res || typeof res !== 'object') return null;
  const img = normRes(res.img), vid = normRes(res.vid), out = normRes(res.out);
  if (!img && !vid && !out) return null;
  return { img, vid, out };
}

function readRes(row) {
  return { img: row.res_img, vid: row.res_vid, out: row.res_out };
}

/** 读项目分辨率（= 本项目下新建剧集的初始模板） */
function getProjectRes(db, projectId) {
  const p = db.raw.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  return p ? readRes(p) : null;
}

/**
 * 改项目分辨率。只影响之后新建的剧集（新建剧集时拷贝为初始值）；
 * 已创建剧集保持各自当前配置 —— 这里绝不回写 episodes。
 */
function setProjectRes(db, projectId, res) {
  const n = normResAll(res);
  if (!n) throw new Error('分辨率格式不合法（应为 宽x高，如 864x480）');
  db.raw.prepare('UPDATE projects SET res_img=COALESCE(?,res_img), res_vid=COALESCE(?,res_vid), res_out=COALESCE(?,res_out) WHERE id=?')
    .run(n.img, n.vid, n.out, projectId);
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
  const img = n.img || '1216x832', vid = n.vid || '864x480', out = n.out || '1920x1080';
  const info = db.raw.prepare('INSERT INTO projects(name,res_img,res_vid,res_out) VALUES(?,?,?,?)').run(clean, img, vid, out);
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
  const img = (p && p.res_img) || '1216x832', vid = (p && p.res_vid) || '864x480', out = (p && p.res_out) || '1920x1080';
  const info = db.raw.prepare('INSERT INTO episodes(project_id,folder_id,name,res_img,res_vid,res_out) VALUES(?,?,?,?,?,?)')
    .run(projectId, folderId, sanitize(name), img, vid, out);
  return { id: info.lastInsertRowid };
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
  const chapFile = path.join(dir, 'chapter.txt');
  const adapFile = path.join(dir, 'adapted.md');
  if (fs.existsSync(chapFile)) chapter = fs.readFileSync(chapFile, 'utf-8');
  if (fs.existsSync(adapFile)) adapted = fs.readFileSync(adapFile, 'utf-8');
  return { id: ep.id, name: ep.name, projectId: ep.project_id, dir, chapter, adapted, done: JSON.parse(ep.stage_done), activeStage: ep.active_stage, stageMeta: parseMeta(ep) };
}

function saveChapter(db, workspace, episodeId, text) {
  const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId);
  if (!ep) return false;
  const dir = touchDir(db, workspace, ep);
  fs.writeFileSync(path.join(dir, 'chapter.txt'), text, 'utf-8');
  db.raw.prepare('UPDATE episodes SET chapter_text=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(text, episodeId);
  // 章节变化 → 下游「改编稿」的脏标记依据（revs.chapter 自增；改编稿记的 adaptedChapter 与之不等就提示）
  const revs = bumpRevs(dir, r => { r.chapter = (r.chapter || 0) + 1 });
  return revs;
}

function saveAdapted(db, workspace, episodeId, text) {
  const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId);
  if (!ep) return false;
  const dir = touchDir(db, workspace, ep);
  fs.writeFileSync(path.join(dir, 'adapted.md'), text, 'utf-8');
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

function deleteEpisodeRows(db, workspace, epIds) {
  const { rmSync } = fs;
  for (const id of epIds) {
    const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(id);
    if (!ep) continue;
    // 删磁盘目录（先于删库，episodeDir 需要记录存在）
    try { rmSync(episodeDir(db, workspace, ep), { recursive: true, force: true }); } catch (_) {}
    db.raw.prepare('DELETE FROM episodes WHERE id=?').run(id);
  }
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

/** 脏标记计数器（revs.json，集目录级）：chapter/adapted 自增，下游据此判断「上游已变化」 */
function readRevs(dir) { return readJson(dir, 'revs.json', {}); }
function writeRevs(dir, revs) { writeJson(dir, 'revs.json', revs); }
function bumpRevs(dir, fn) {
  const r = readRevs(dir);
  fn(r);
  writeRevs(dir, r);
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
  const read = (n) => fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf-8') : '';
  // 项目级媒体目录（角色图 / 镜头视频 / 成片都归到项目下，见文件顶部目录说明）
  const pRoot = ensureProjectDirs(db, workspace, ep.project_id);
  const aRoot = assetsRoot(db, workspace, ep.project_id);
  const sDir = shotDir(db, workspace, ep);
  const fDir = filmDir(db, workspace, ep);
  try { fs.mkdirSync(sDir, { recursive: true }); } catch (_) {}
  const videosDir = sDir;
  const videoFiles = fs.existsSync(videosDir) ? fs.readdirSync(videosDir).filter(f => /\.(mp4|webm|mov)$/i.test(f)).sort() : [];
  const exportDir = fDir;
  const exportFiles = fs.existsSync(exportDir) ? fs.readdirSync(exportDir).filter(f => /\.mp4$/i.test(f)).sort() : [];
  return {
    id: ep.id, name: ep.name, projectId: ep.project_id, dir,
    projectDir: pRoot, assetsDir: aRoot, shotDir: sDir, filmDir: fDir,
    res: readRes(ep),
    chapter: read('chapter.txt'),
    adapted: read('adapted.md'),
    revs: readJson(dir, 'revs.json', {}),
    shots: readJson(dir, 'shots.json', []),
    chars: readJson(dir, 'chars.json', []),
    scenes: readJson(dir, 'scenes.json', []),
    prompts: readJson(dir, 'prompts.json', []),
    videoState: readJson(dir, 'videos.json', {}),
    videoFiles,
    exportFile: exportFiles.length ? exportFiles[exportFiles.length - 1] : null,
    done: JSON.parse(ep.stage_done), activeStage: ep.active_stage,
    stageMeta: parseMeta(ep)
  };
}

function saveArtifact(db, workspace, episodeId, kind, data) {
  const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId);
  if (!ep) return false;
  const dir = touchDir(db, workspace, ep);
  if (kind === 'adapted') {
    fs.writeFileSync(path.join(dir, 'adapted.md'), String(data), 'utf-8');
    // 改编稿变化（生成/编辑/确认都算）→ 下游「角色&场景 / 分镜」的脏标记依据
    return bumpRevs(dir, r => { r.adapted = (r.adapted || 0) + 1 });
  }
  if (kind === 'shots') writeJson(dir, 'shots.json', data);
  else if (kind === 'chars') writeJson(dir, 'chars.json', data);
  else if (kind === 'scenes') writeJson(dir, 'scenes.json', data);
  else if (kind === 'prompts') writeJson(dir, 'prompts.json', data);
  else if (kind === 'videoState') writeJson(dir, 'videos.json', data);
  else if (kind === 'revs') writeJson(dir, 'revs.json', data);
  db.raw.prepare('UPDATE episodes SET updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(episodeId);
  return true;
}

module.exports = {
  getTree, createProject, addFolder, addEpisode, getEpisode, saveChapter, saveAdapted, saveState, episodeDir,
  deleteProject, deleteFolder, deleteEpisode, getEpisodeFull, saveArtifact,
  getProjectRes, setProjectRes, getEpisodeRes, setEpisodeRes, normRes,
  // 项目级目录（资产 / 分镜 / 成片）
  projectRoot, assetsRoot, characterDir, sceneDir, shotDir, filmDir, ensureProjectDirs, listProjectEpisodes
};
