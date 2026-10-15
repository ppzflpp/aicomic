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
 * 归档「本集旧的角色 / 场景」的图片目录（2026-10-07；2026-10-09 起调用方传全量清单）。
 *
 * 重新生成分镜的语义是**从零开始**：旧档案与卡片一律不留（同名也重建 → 图片一并归档，
 * 见 StageShots 的 buildArchive / orphanAssets）。但那些图是花显卡时间出的，不能一声不吭删掉
 * → **移动**到
 *   <集私有素材根>/_trash/<时间戳>/{characters,scenes}/<名字>/
 *     （镜头视频 / 首帧 / 成片走 archiveEpisodeMedia，落同一个 _trash/<时间戳>/{分镜,成片}/）
 * UI 上干干净净，想找回时去 _trash 里按时间戳翻。
 *
 * 🔴 只处理**集私有**素材（card.libReadonly !== true 的那批）。库条目的图是跨集共享的，
 *    归档它会连带毁掉别的集 → 调用方负责过滤，这里只按传进来的名字动手。
 * 🔴 禁用 fs.cpSync（中文路径段错误）→ renameSync 优先，失败退回 copyDir 手写拷贝 + 删源。
 *
 * @param {Array<{kind:'character'|'scene', name:string}>} items 要归档的名字
 * @param {string} [trashDirIn] 指定归档落点（archiveEpisodeOutputs 用：与媒体归档共用同一个
 *        时间戳目录，一次「重新生成分镜」= 一个文件夹，用户翻起来不用对时间戳）
 * @returns {{moved:string[], failed:string[], trashDir:string|null}}
 */
function archiveEpisodeAssets(db, workspace, ep, items, trashDirIn) {
  const out = { moved: [], failed: [], trashDir: null };
  const list = (Array.isArray(items) ? items : []).filter(x => x && x.name);
  if (!list.length || !ep) return out;
  const root = episodeAssetsRoot(db, workspace, ep);
  if (!root) return out;
  const trashDir = trashDirIn || path.join(root, '_trash', String(Date.now()));
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
 * 归档「本集的镜头视频 / 首帧图 / 成片」（2026-10-09，Dragon）。
 *
 * 「重新生成分镜」= 从零重来：分镜换了，提示词与视频记录也清了，但**磁盘上的文件**还留着
 *   <项目>/分镜/<集名>_shot_N.mp4（多版本 _02/_03）、<集名>_shot_N_first.png、
 *   <项目>/成片/<集名>_<时间戳>.mp4
 * 它们与当前分镜早已不对应，界面（左侧树「分镜」「成片」、成片格）却照样列出来 ——
 * 用户看到的就是「点完生成分镜，旧东西还在」。
 *
 * 处理与角色图同一套路：**移动到** <集私有素材根>/_trash/<时间戳>/{分镜,成片}/，不删除。
 *
 * 🔴 分镜/成片目录是**全项目共用**的（靠文件名前缀=集名归集）→ 只动文件名以「<集名>_」开头的，
 *    别的集的文件一个都不能碰。
 * 🔴 隐藏封面 .<文件名>.poster.jpg 去掉前导点后同样以集名前缀开头 → 一并搬走。
 * 🔴 .meta.json（分辨率/耗时缓存）是**目录级**的（只此一份，装着所有集的键）→ 不能整体搬，
 *    只清掉本集那几个键，否则别的集的缓存会被连坐。
 *
 * @param {string} [trashDirIn] 指定归档落点（见 archiveEpisodeOutputs）
 * @returns {{moved:string[], failed:string[], trashDir:string|null}}
 */
function archiveEpisodeMedia(db, workspace, ep, trashDirIn) {
  const out = { moved: [], failed: [], trashDir: null };
  if (!ep) return out;
  const root = episodeAssetsRoot(db, workspace, ep);
  if (!root) return out;
  const trashDir = trashDirIn || path.join(root, '_trash', String(Date.now()));
  const re = new RegExp('^' + escRe(epPrefix(ep)) + '_');
  const jobs = [
    { sub: '分镜', dir: shotDir(db, workspace, ep) },
    { sub: '成片', dir: filmDir(db, workspace, ep) }
  ];
  for (const j of jobs) {
    if (!j.dir || !fs.existsSync(j.dir)) continue;
    let files = [];
    try { files = fs.readdirSync(j.dir); } catch (_) { continue; }
    for (const f of files) {
      if (f === '.meta.json') { pruneMeta(j.dir, re, f); continue; }
      const bare = f[0] === '.' ? f.slice(1) : f;   // 隐藏封面：去掉前导点再按同一前缀判定
      if (!re.test(bare)) continue;
      const from = path.join(j.dir, f);
      const to = path.join(trashDir, j.sub, f);
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        try {
          fs.renameSync(from, to);                   // 同盘：瞬间完成
        } catch (_) {
          const st = fs.statSync(from);
          if (st.isDirectory()) {
            if (!copyDirTree(from, to)) throw new Error('拷贝失败');
          } else {
            fs.copyFileSync(from, to);
          }
          fs.rmSync(from, { recursive: true, force: true });
        }
        out.moved.push(j.sub + '/' + f);
      } catch (err) {
        out.failed.push(j.sub + '/' + f + '（' + ((err && err.message) || err) + '）');
      }
    }
  }
  out.trashDir = out.moved.length ? trashDir : null;
  return out;
}

/**
 * 「重新生成分镜」的一键清空（2026-10-09，Dragon）：角色/场景图 + 镜头视频 + 首帧图 + 成片
 * 全部归档到**同一个** _trash/<时间戳>/ 下。
 *
 * 单独包一层的原因就是「同一个时间戳目录」：分两次调用会各自建一个时间戳文件夹，
 * 用户想找回「上次那批」时得对时间戳翻两次。
 *
 * @param {Array<{kind:'character'|'scene', name:string}>} items 要归档的角色/场景名
 *        （调用方已排除 _manual 手动卡与库只读卡）
 * @returns {{moved:string[], failed:string[], trashDir:string|null}}
 */
function archiveEpisodeOutputs(db, workspace, ep, items) {
  const out = { moved: [], failed: [], trashDir: null };
  if (!ep) return out;
  const root = episodeAssetsRoot(db, workspace, ep);
  if (!root) return out;
  const trashDir = path.join(root, '_trash', String(Date.now()));
  const a = archiveEpisodeAssets(db, workspace, ep, items, trashDir);
  const m = archiveEpisodeMedia(db, workspace, ep, trashDir);
  out.moved = a.moved.concat(m.moved);
  out.failed = a.failed.concat(m.failed);
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

/**
 * 视频比例（2026-10-15）：只有 16:9 与 9:16 两档（1:1 已按 Dragon 要求去掉）。
 *   它是「档位 + 比例 → 图片 / 视频 / 成片三个分辨率推荐值」的两个上游输入之一。
 */
const ASPECTS = ['16:9', '9:16'];
function normAspect(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return ASPECTS.includes(s) ? s : null;
}
/** 按分辨率宽高推断比例（存量项目 aspect 列为 NULL 时用）：宽>高 → 横版；宽<高 → 竖版 */
function inferAspect(resStr) {
  const m = /^(\d{2,5})x(\d{2,5})$/i.exec(String(resStr || '').trim());
  if (!m) return null;
  return (+m[1]) > (+m[2]) ? '16:9' : '9:16';
}

/**
 * 单集目标时长（秒，2026-10-13）：双轨配时的输入。
 *   0 / 空 = 未设置（整层惰性，行为与改造前一致）；合理区间 5~1800 秒。
 * 🔴 越界一律当「没填」而不是夹取 —— 夹取会把 99999 悄悄变成 1800，用户以为存上了。
 */
function normTargetSec(v) {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 1800) return null;
  return n;
}

/** 规整 {img,vid,out,tier,targetSec} 五元组；全部非法则返回 null（tier 非法 → 回默认档） */
function normResAll(res) {
  if (!res || typeof res !== 'object') return null;
  const img = normRes(res.img), vid = normRes(res.vid), out = normRes(res.out);
  // style 与分辨率同路提交，但它**不是分辨率** —— 所以不能进那个「三个都空就返回 null」的判断
  const style = res.style == null ? null : (String(res.style).trim() || null);
  // 目标时长同理走同一条提交路径（渲染层一次提交多个项目级设置）
  const targetSec = normTargetSec(res.targetSec);
  if (!img && !vid && !out && !style && targetSec == null) return null;
  // tier 是项目级视频档位，与分辨率同路存取（渲染层一次提交多个项目级设置）
  const tier = res.tier == null ? null : videoTiers.normalizeTier(res.tier);
  // 比例（2026-10-15）：只有用户在弹窗里**显式点过**才写；缺省 = null（读时按 res_vid 推断）
  const aspect = normAspect(res.aspect);
  if (!img && !vid && !out && !style && targetSec == null && !aspect) return null;
  return { img, vid, out, tier, style, targetSec, aspect };
}

function readRes(row) {
  const r = { img: row.res_img, vid: row.res_vid, out: row.res_out };
  // 只有 projects 有 res_tier 列（剧集不带档位，生成时实时读所属项目）
  if (row.res_tier != null) r.tier = videoTiers.normalizeTier(row.res_tier);
  // 同理只有 projects 有 style 列：剧集的风格在「读提示词规范」时实时读所属项目，
  // 不做集级快照 —— 改风格对本项目全部剧集立即生效（跟档位一致）
  if (row.style != null) r.style = String(row.style || '').trim() || styles.defaultId();
  // 同理只有 projects 有 target_sec 列（单集目标时长，双轨配时用）
  if (row.target_sec != null) r.targetSec = Math.max(0, Math.round(Number(row.target_sec) || 0));
  // 同理只有 projects 有 aspect 列（视频比例 16:9 / 9:16）。
  // 🔴 存量项目该列为 NULL → **按 res_vid 的宽高推断**，而不是给个默认值：
  //    这样老项目打开配置弹窗时看到的是它实际在用的比例，且老项目行不会被迁移改写。
  const saved = normAspect(row.aspect);
  if (saved) r.aspect = saved;
  else { const inf = inferAspect(row.res_vid); if (inf) r.aspect = inf; }
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
  if (!n) throw new Error('项目配置格式不合法：分辨率应为 宽x高（如 864x480），单集目标时长应为 0~1800 的整数秒');
  db.raw.prepare('UPDATE projects SET res_img=COALESCE(?,res_img), res_vid=COALESCE(?,res_vid), res_out=COALESCE(?,res_out), res_tier=COALESCE(?,res_tier), style=COALESCE(?,style), target_sec=COALESCE(?,target_sec), aspect=COALESCE(?,aspect) WHERE id=?')
    .run(n.img, n.vid, n.out, n.tier, n.style, n.targetSec, n.aspect, projectId);
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
  // 视频比例（2026-10-15）：null = 用户没选 → 读时按 res_vid 推断（存量行为不变）
  const aspect = n.aspect || null;
  const portrait = aspect === '9:16';
  // 🔴 兜底默认值必须**与比例自洽**：比例选了 9:16 却把 vid 落成横版，后续联动推荐就会打架。
  const img = n.img || (portrait ? '480x864' : '1920x1080');
  const vid = n.vid || (portrait ? '480x864' : '864x480');
  const out = n.out || (portrait ? '1080x1920' : '1920x1080');
  const tier = n.tier || videoTiers.DEFAULT_TIER;   // 视频档位：项目级，随项目一起落库
  const style = n.style || styles.defaultId();      // 风格包：项目级，新建时选定
  const targetSec = n.targetSec == null ? 0 : n.targetSec;   // 单集目标时长：项目级，0 = 不启用双轨配时
  const info = db.raw.prepare('INSERT INTO projects(name,res_img,res_vid,res_out,res_tier,style,target_sec,aspect) VALUES(?,?,?,?,?,?,?,?)')
    .run(clean, img, vid, out, tier, style, targetSec, aspect);
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
    // 成片文件名 = <集名>_<13 位时间戳>.mp4 → sort 后取最后一个 = 最新一版
    // （2026-10-09 起多次导出各自留档，目录里会有多版；这里只回答「最近一次导出的那个」）
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
  // 视频比例（2026-10-15）：ASPECTS = 可选值清单，normAspect = 校验规整，inferAspect = 按分辨率宽高推断
  ASPECTS, normAspect, inferAspect,
  // 项目级目录（资产 / 分镜 / 成片）
  projectRoot, assetsRoot, characterDir, sceneDir, shotDir, filmDir, ensureProjectDirs, listProjectEpisodes,
  // 集私有素材（本集自己的角色/场景图）：与库共享素材分开，跨集互不污染
  episodeAssetsRoot, episodeKindDir, migrateEpisodePrivateAssets,
  archiveEpisodeAssets, archiveEpisodeMedia, archiveEpisodeOutputs,
  // 左侧树「剧本」节点：按集列举剧本工件
  listProjectScripts, SCRIPT_KINDS
};
