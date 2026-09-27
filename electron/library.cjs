'use strict';
/**
 * 项目角色场景库（<项目>/assets/library.json）
 *
 * 解决什么问题：多集出现同一人物时，旧逻辑每集独立提取 → 第1集一个「张伯」、第3集又一个「张伯」，
 * 各自一套图片目录、各自一张脸；在某一集改了服装，别的集完全不知道。
 *
 * 设计要点（2026-09-24 与 Dragon 拍板）：
 *  - **库就是项目自己的 assets**，不新建目录。条目 id = 名字（sanitize 后）→ 条目目录就是
 *    `assets/characters/<名字>/`，与本集卡片拼出来的路径**完全一致** → 入库零拷贝、零断链。
 *  - 🔴 **名字是唯一键**：贯穿 5 条链路（图片目录 / 分镜 chars / 对白锁人 / H3 参考图归属 / 一键填充）。
 *    所以库里名字必须唯一；真撞名（两个不同的人同名）时自动加「 (2)」后缀，并且**后缀进名字本身**
 *    （不是只改目录），否则分镜里写「张伯」就不知道指哪一个。
 *  - 同一人物的不同年龄 / 形态 / 重大状态 = **两个不同角色**，命名 `基础名-限定词`（`李白-少年` /
 *    `李白-老年`），变体解析只在角色上做（场景名本身可能含「-」，如「馄饨摊·外-晨」，不能当分隔符）。
 *  - 集内卡片永远保存**自己的副本**（写进 <集名>.chars.json），只记 `libId` + `libRevAt` 做来源标记；
 *    库里改了不会偷改历史集，必须先提示、用户确认才更新副本。
 *  - 本批不做删除（Dragon 定）。
 */
const path = require('path');
const fs = require('fs');
const { sanitize } = require('./assetStore.cjs');
const projects = require('./projects.cjs');

const IMG_RE = /\.(png|jpe?g|webp|bmp)$/i;

/** 条目目录名 = 名字（消毒后） */
function sanitizeId(name) { return sanitize(name) }

function kindDir(kind) { return kind === 'scene' ? 'scenes' : 'characters' }

/** 库条目目录：<项目>/assets/{characters|scenes}/<id> */
function entryDir(db, workspace, projectId, kind, id) {
  const a = projects.assetsRoot(db, workspace, projectId);
  return a ? path.join(a, kindDir(kind), sanitizeId(id)) : null;
}

/** 库文件：<项目>/assets/library.json */
function libraryPath(db, workspace, projectId) {
  const a = projects.assetsRoot(db, workspace, projectId);
  return a ? path.join(a, 'library.json') : null;
}

/* ---------- 名字工具 ---------- */

/**
 * 基础名（变体解析用，**只对角色**）：
 *   「李白-少年」→「李白」；「张伯 (2)」→「张伯」；「张伯」→「张伯」。
 * ⚠️ 场景名不能这么切（「江南小镇馄饨摊·外-晨」里的「-」是地名的一部分）。
 */
function baseNameOf(name) {
  const s = String(name || '').trim().replace(/\s*\(\d+\)$/, '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * 库里同一基础名的全部条目（含自己）；kind 传了才按类型过滤。
 * 变体**只对角色**生效（场景名里的「-」是地名的一部分，如「馄饨摊·外-晨」，不能当分隔符）。
 */
function variantsOf(lib, name, kind) {
  const list = (lib && lib.entries) || [];
  const base = baseNameOf(name);
  return list.filter(e => {
    if (kind && e.kind !== kind) return false;
    if (e.name === name) return true;
    return e.kind === 'character' && baseNameOf(e.name) === base;
  });
}

/** 库内同类型下的唯一名字：撞名自动加「 (2)」 */
function uniqueName(lib, kind, name) {
  const used = new Set(((lib && lib.entries) || []).filter(e => e.kind === kind).map(e => e.name));
  if (!used.has(name)) return name;
  let n = 2;
  while (used.has(name + ' (' + n + ')')) n++;
  return name + ' (' + n + ')';
}

/* ---------- 基础读写 ---------- */

function listImages(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch (_) { return []; }
  return files.filter(f => IMG_RE.test(f)).sort((a, b) => a.localeCompare(b, 'zh'));
}

function readJsonAt(p, fallback) {
  if (!p || !fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return fallback; }
}

function readLibrary(db, workspace, projectId) {
  const p = libraryPath(db, workspace, projectId);
  if (!p || !fs.existsSync(p)) return null;
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!o || !Array.isArray(o.entries)) return { rev: 1, entries: [] };
    o.rev = o.rev || 1;
    return o;
  } catch (_) { return { rev: 1, entries: [] }; }
}

function writeLibrary(db, workspace, projectId, lib) {
  const p = libraryPath(db, workspace, projectId);
  if (!p) return false;
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  fs.writeFileSync(p, JSON.stringify(lib, null, 2), 'utf-8');
  return true;
}

function entryOf(lib, id) {
  return ((lib && lib.entries) || []).find(e => e.id === id) || null;
}

function projectEps(db, projectId) {
  return db.raw.prepare('SELECT * FROM episodes WHERE project_id=? ORDER BY id').all(projectId);
}

/* ---------- 读取（含老项目自动迁移） ---------- */

/**
 * 新建项目时的**基线落盘**：写一个空库（**不迁移**）。
 *
 * 为什么必须有这一步：迁移的判据是「library.json 不存在 ⇒ 是老项目」，
 * 于是「第一次调用库接口的时刻」决定了哪些目录会被当成老资产入库。
 * 而那个时刻是**不可控**的（进第 4 块、展开左侧库节点、点开某集都可能触发），
 * 一旦发生在「用户已经生成过图之后」→ 本次会话新生成的图会被静默入库 →
 * 集内卡片当场变成「已同步到项目库」的只读态（e2e 实测踩到过）。
 *
 * 所以在**项目诞生那一刻**就把空库写下来，把「本项目从此刻开始用库」钉死：
 *   - 新项目 → 空库 → 之后永不迁移 → 资产只能靠用户点「保存到项目」入库 ✔
 *   - 老项目（没有 library.json）→ 首次访问时迁移一次 ✔
 */
function initLibrary(db, workspace, projectId) {
  const existed = readLibrary(db, workspace, projectId);
  if (existed) return existed;
  const lib = { rev: 1, entries: [] };
  writeLibrary(db, workspace, projectId, lib);
  return lib;
}

/**
 * 读库；没有 library.json 时**自动迁移**：
 * 扫 assets/{characters,scenes} 下已有图片的目录，各建一条库条目，
 * 档案取「最早引用它的那一集」的同名卡片（老项目的档案就存在各集 chars/scenes.json 里）。
 * 幂等：迁移过就写盘了，下次直接读。
 */
function ensureLibrary(db, workspace, projectId) {
  const existed = readLibrary(db, workspace, projectId);
  if (existed) return existed;
  const lib = { rev: 1, entries: [] };
  const aRoot = projects.assetsRoot(db, workspace, projectId);
  if (aRoot) {
    const eps = projectEps(db, projectId);
    for (const kind of ['character', 'scene']) {
      const root = path.join(aRoot, kindDir(kind));
      if (!fs.existsSync(root)) continue;
      let subs = [];
      try { subs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
      for (const d of subs) {
        if (!d.isDirectory()) continue;
        const dir = path.join(root, d.name);
        const images = listImages(dir);
        if (!images.length) continue;
        // 档案来源：最早引用它的那一集
        const cardFile = kind === 'character' ? 'chars.json' : 'scenes.json';
        let src = null, from = null;
        for (const ep of eps) {
          const arr = readJsonAt(projects.artifactPath(db, workspace, ep, cardFile), []);
          if (!Array.isArray(arr)) continue;
          const hit = arr.find(x => x && x.name && sanitizeId(x.name) === d.name);
          if (hit) { src = hit; from = { episodeId: ep.id, epName: ep.name }; break; }
        }
        let cur = (src && typeof src.cur === 'number') ? src.cur : images.length - 1;
        if (cur >= images.length) cur = images.length - 1;
        lib.entries.push({
          id: d.name, kind, name: (src && src.name) || d.name,
          role: (src && src.role) || (kind === 'scene' ? '场景' : '配角'),
          profile: (src && src.profile) || '',
          prompt: (src && src.prompt) || '',
          negative: (src && src.negative) || '',
          res: (src && src.res) || '',
          cur,
          promptMs: (src && src.promptMs) || 0, genMs: (src && src.genMs) || 0,
          promptAt: (src && src.promptAt) || 0,
          libRev: 1, createdAt: Date.now(), updatedAt: Date.now(),
          from, migrated: true
        });
      }
    }
  }
  writeLibrary(db, workspace, projectId, lib);
  return lib;
}

/** 库列表（图片实时扫目录，与磁盘永远一致；cur 越界自动回落） */
function listLibrary(db, workspace, projectId) {
  const lib = ensureLibrary(db, workspace, projectId);
  const entries = (lib.entries || []).map(e => {
    const dir = entryDir(db, workspace, projectId, e.kind, e.id);
    const images = listImages(dir);
    let cur = typeof e.cur === 'number' ? e.cur : -1;
    if (cur >= images.length) cur = images.length - 1;
    if (cur < -1) cur = -1;
    return { ...e, images, cur, dir, base: e.kind === 'character' ? baseNameOf(e.name) : '' };
  });
  return { rev: lib.rev || 1, entries };
}

/* ---------- 写入 ---------- */

/**
 * 入库 / 更新条目。
 * @param payload { kind, name, role, profile, prompt, negative, res, cur, from, updateId }
 *   - 传 updateId → 覆盖更新该条目（libRev +1）
 *   - 不传 → 新建（撞名自动加「 (2)」，并把序号返回给前端）
 * @returns 条目本体（含 id / name / created）
 */
function saveEntry(db, workspace, projectId, payload) {
  const lib = ensureLibrary(db, workspace, projectId);
  const p = payload || {};
  const kind = p.kind === 'scene' ? 'scene' : 'character';
  const pick = (v, d) => (v === undefined || v === null ? d : v);

  if (p.updateId) {
    const e = entryOf(lib, p.updateId);
    if (!e) throw new Error('库条目不存在：' + p.updateId);
    e.kind = kind;
    e.role = pick(p.role, e.role);
    e.profile = pick(p.profile, e.profile);
    e.prompt = pick(p.prompt, e.prompt);
    e.negative = pick(p.negative, e.negative);
    e.res = pick(p.res, e.res);
    if (typeof p.cur === 'number') e.cur = p.cur;
    if (p.from) e.from = p.from;
    e.libRev = (e.libRev || 1) + 1;
    e.updatedAt = Date.now();
    lib.rev = (lib.rev || 1) + 1;
    writeLibrary(db, workspace, projectId, lib);
    return { entry: e, created: false };
  }

  const rawName = String(p.name || '').trim();
  if (!rawName) throw new Error('条目名字不能为空');
  const name = uniqueName(lib, kind, rawName);
  const e = {
    id: sanitizeId(name), kind, name,
    role: pick(p.role, kind === 'scene' ? '场景' : '配角'),
    profile: pick(p.profile, ''),
    prompt: pick(p.prompt, ''),
    negative: pick(p.negative, ''),
    res: pick(p.res, ''),
    cur: typeof p.cur === 'number' ? p.cur : -1,
    promptMs: pick(p.promptMs, 0), genMs: pick(p.genMs, 0), promptAt: pick(p.promptAt, 0),
    libRev: 1, createdAt: Date.now(), updatedAt: Date.now(),
    from: p.from || null
  };
  lib.entries.push(e);
  lib.rev = (lib.rev || 1) + 1;
  // 新条目目录（图片可能已经在里面了——本集卡片就是从这儿拼路径的，所以通常已存在）
  const dir = entryDir(db, workspace, projectId, kind, e.id);
  if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }
  writeLibrary(db, workspace, projectId, lib);
  return { entry: e, created: true, renamed: name !== rawName };
}

/** 手动新增空条目（不靠 LLM 提取） */
function addEntry(db, workspace, projectId, kind, name) {
  return saveEntry(db, workspace, projectId, {
    kind, name, role: kind === 'scene' ? '场景' : '配角',
    profile: '', prompt: '', negative: '', res: '', cur: -1
  });
}

/** 更新库条目某个字段（编辑器里逐字段保存用） */
function patchEntry(db, workspace, projectId, id, patch) {
  return saveEntry(db, workspace, projectId, Object.assign({}, patch, { updateId: id }));
}

/* ---------- 改名（重命名目录 + 扫各集替换引用） ---------- */

/**
 * 改名：库条目名字改了，磁盘目录跟着改，同时扫全部集把旧名换成新名
 * （卡片档案 name/libId、分镜 chars / scene 字段、对白「人名：台词」的前缀）。
 * 对白必须一起改 —— 提示词生成时按冒号前的人名把台词钉给角色（shots.md 硬规则），
 * 名字对不上就会被模型随便分配。
 */
function renameInEpisodes(db, workspace, projectId, kind, oldName, newName, newId, onlyEpisodeId) {
  const out = [];
  const cardFile = kind === 'scene' ? 'scenes.json' : 'chars.json';
  for (const ep of projectEps(db, projectId)) {
    if (onlyEpisodeId != null && ep.id !== onlyEpisodeId) continue;
    let hit = 0;
    // ① 本集卡片档案
    const cpath = projects.artifactPath(db, workspace, ep, cardFile);
    const cards = readJsonAt(cpath, []);
    if (Array.isArray(cards)) {
      let changed = false;
      for (const c of cards) {
        if (c && c.name === oldName) { c.name = newName; c.libId = newId; changed = true; hit++; }
      }
      if (changed) { try { fs.writeFileSync(cpath, JSON.stringify(cards, null, 2), 'utf-8'); } catch (_) {} }
    }
    // ② 分镜里的名字
    const spath = projects.artifactPath(db, workspace, ep, 'shots.json');
    const shots = readJsonAt(spath, []);
    if (Array.isArray(shots) && shots.length) {
      let changed = false;
      for (const s of shots) {
        if (!s) continue;
        if (kind === 'scene') {
          if (String(s.scene || '').trim() === oldName) { s.scene = newName; changed = true; hit++; }
          continue;
        }
        const parts = String(s.chars || '').split(/[、,，/]/).map(x => x.trim()).filter(Boolean);
        if (parts.includes(oldName)) {
          s.chars = parts.map(x => (x === oldName ? newName : x)).join('、');
          changed = true; hit++;
        }
        const dia = String(s.dialogue || '');
        if (dia.includes(oldName + '：') || dia.includes(oldName + ':')) {
          s.dialogue = dia.split('\n').map(ln => {
            const m = /^(\s*)([^：:]{1,24})([：:])(.*)$/.exec(ln);
            if (m && m[2].trim() === oldName) return m[1] + newName + m[3] + m[4];
            return ln;
          }).join('\n');
          changed = true; hit++;
        }
      }
      if (changed) { try { fs.writeFileSync(spath, JSON.stringify(shots, null, 2), 'utf-8'); } catch (_) {} }
    }
    if (hit) out.push({ episodeId: ep.id, epName: ep.name, count: hit });
  }
  return out;
}

function renameEntry(db, workspace, projectId, id, newName) {
  const lib = ensureLibrary(db, workspace, projectId);
  const e = entryOf(lib, id);
  if (!e) throw new Error('库条目不存在：' + id);
  const clean = String(newName || '').trim();
  if (!clean) throw new Error('新名字不能为空');
  const nid = sanitizeId(clean);
  if (nid !== e.id && (lib.entries || []).some(x => x.id === nid)) throw new Error('库里已有同名条目：' + clean);

  const oldName = e.name;
  const oldDir = entryDir(db, workspace, projectId, e.kind, e.id);
  const newDir = entryDir(db, workspace, projectId, e.kind, nid);
  // 图片目录跟着改名（图片是跨集共享的，只动目录名，集内副本记录只改名字）
  if (oldDir && newDir && oldDir !== newDir && fs.existsSync(oldDir)) {
    try { fs.mkdirSync(path.dirname(newDir), { recursive: true }); fs.renameSync(oldDir, newDir); }
    catch (err) { throw new Error('重命名图片目录失败：' + err.message); }
  }
  e.id = nid; e.name = clean;
  e.libRev = (e.libRev || 1) + 1;
  e.updatedAt = Date.now();
  lib.rev = (lib.rev || 1) + 1;
  writeLibrary(db, workspace, projectId, lib);
  const touched = oldName === clean ? [] : renameInEpisodes(db, workspace, projectId, e.kind, oldName, clean, nid);
  return { entry: e, touched };
}

/**
 * 单集改名（「切换变体」用）：把**某一集**里旧名换成新名（卡片档案 / 分镜 chars·scene / 对白人名），
 * 不动库里任何条目、不动图片目录。用于「本集这个人物被系统判成了库里另一个变体」的纠正：
 * 换卡的同时必须把分镜与对白里的名字一起换掉，否则参考图归属与台词归属会错到别人头上。
 */
function renameInEpisode(db, workspace, projectId, episodeId, kind, oldName, newName, newId) {
  if (!oldName || !newName || oldName === newName) return []
  return renameInEpisodes(db, workspace, projectId, kind, oldName, newName, newId || sanitizeId(newName), episodeId)
}

/* ---------- 引用反查（谁在用这个库条目） ---------- */

/**
 * 反查某库条目被哪些集/哪些镜引用（不做索引，现扫 —— 避免索引与磁盘不一致）。
 * @returns [{ episodeId, epName, hasCard, shots: [镜头下标] , count }]
 */
function entryUsage(db, workspace, projectId, id) {
  const lib = ensureLibrary(db, workspace, projectId);
  const e = entryOf(lib, id);
  if (!e) return [];
  const out = [];
  for (const ep of projectEps(db, projectId)) {
    const cards = readJsonAt(projects.artifactPath(db, workspace, ep, e.kind === 'scene' ? 'scenes.json' : 'chars.json'), []);
    const hasCard = Array.isArray(cards) && cards.some(c => c && (c.libId === id || c.name === e.name));
    const shots = readJsonAt(projects.artifactPath(db, workspace, ep, 'shots.json'), []);
    const idx = [];
    if (Array.isArray(shots)) {
      shots.forEach((s, i) => {
        if (!s) return;
        if (e.kind === 'scene') {
          if (String(s.scene || '').trim() === e.name) idx.push(i);
        } else {
          const parts = String(s.chars || '').split(/[、,，/]/).map(x => x.trim());
          if (parts.includes(e.name)) idx.push(i);
        }
      });
    }
    if (hasCard || idx.length) {
      out.push({ episodeId: ep.id, epName: ep.name, hasCard, shots: idx, count: idx.length });
    }
  }
  return out;
}

/** 一条引用摘要文案：「第1集 镜2/镜5、第3集 镜1」 */
function usageText(usage) {
  return (usage || []).map(u => u.epName + (u.shots.length
    ? ' 镜' + u.shots.slice(0, 6).map(i => i + 1).join('/') + (u.shots.length > 6 ? '…' : '')
    : ' 档案卡')).join('、');
}

module.exports = {
  libraryPath, entryDir, kindDir, baseNameOf, variantsOf, uniqueName,
  ensureLibrary, initLibrary, listLibrary, saveEntry, addEntry, patchEntry, renameEntry, renameInEpisode,
  entryUsage, usageText, listImages
};
