'use strict';
const path = require('path');
const fs = require('fs');
const { sanitize } = require('./assetStore.cjs');

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

/* ---------- 项目树 ---------- */

function getTree(db, workspace) {
  const projects = db.raw.prepare('SELECT * FROM projects ORDER BY id').all();
  const folders = db.raw.prepare('SELECT * FROM folders ORDER BY id').all();
  const episodes = db.raw.prepare('SELECT id,project_id,folder_id,name,updated_at FROM episodes ORDER BY id').all();

  return projects.map(p => {
    const pf = folders.filter(f => f.project_id === p.id);
    // 递归构树
    const build = (parentId) => pf
      .filter(f => (f.parent_id || null) === parentId)
      .map(f => ({ id: f.id, name: f.name, folders: build(f.id), episodes: episodes.filter(e => e.folder_id === f.id) }));
    return {
      id: p.id,
      name: p.name,
      folders: build(null),
      episodes: episodes.filter(e => e.folder_id === null && e.project_id === p.id)
    };
  });
}

/* ---------- CRUD ---------- */

function createProject(db, workspace, name) {
  const clean = sanitize(name);
  const info = db.raw.prepare('INSERT INTO projects(name) VALUES(?)').run(clean);
  const pid = info.lastInsertRowid;
  db.raw.prepare('INSERT INTO episodes(project_id,folder_id,name) VALUES(?,NULL,?)').run(pid, '第1集');
  fs.mkdirSync(path.join(workspace, 'projects', clean), { recursive: true });
  return { id: pid };
}

function addFolder(db, workspace, projectId, parentId, name) {
  const info = db.raw.prepare('INSERT INTO folders(project_id,parent_id,name) VALUES(?,?,?)')
    .run(projectId, parentId, sanitize(name));
  return { id: info.lastInsertRowid };
}

function addEpisode(db, workspace, projectId, folderId, name) {
  const info = db.raw.prepare('INSERT INTO episodes(project_id,folder_id,name) VALUES(?,?,?)')
    .run(projectId, folderId, sanitize(name));
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
  return true;
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

function writeJson(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2), 'utf-8');
}

function getEpisodeFull(db, workspace, episodeId) {
  const ep = db.raw.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId);
  if (!ep) return null;
  const dir = touchDir(db, workspace, ep);
  const read = (n) => fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf-8') : '';
  // 视频产物：videos/ 下按镜头保存 shot_<id>_<n>.mp4
  const videosDir = path.join(dir, 'videos');
  const videoFiles = fs.existsSync(videosDir) ? fs.readdirSync(videosDir).filter(f => /\.(mp4|webm|mov)$/i.test(f)).sort() : [];
  const exportDir = path.join(dir, 'export');
  const exportFiles = fs.existsSync(exportDir) ? fs.readdirSync(exportDir).filter(f => /\.mp4$/i.test(f)).sort() : [];
  return {
    id: ep.id, name: ep.name, projectId: ep.project_id, dir,
    chapter: read('chapter.txt'),
    adapted: read('adapted.md'),
    shots: readJson(dir, 'shots.json', []),
    chars: readJson(dir, 'chars.json', []),
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
    return true;
  }
  if (kind === 'shots') writeJson(dir, 'shots.json', data);
  else if (kind === 'chars') writeJson(dir, 'chars.json', data);
  else if (kind === 'prompts') writeJson(dir, 'prompts.json', data);
  else if (kind === 'videoState') writeJson(dir, 'videos.json', data);
  db.raw.prepare('UPDATE episodes SET updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(episodeId);
  return true;
}

module.exports = {
  getTree, createProject, addFolder, addEpisode, getEpisode, saveChapter, saveAdapted, saveState, episodeDir,
  deleteProject, deleteFolder, deleteEpisode, getEpisodeFull, saveArtifact
};
