'use strict';
/**
 * 配套自定义节点的安装（2026-10-18；2026-10-18 二次改造：支持任意多个包）
 *
 * 【为什么要自动装】
 *   Qwen-Image 2.1 的工作流用到 `EmptyQwenImage21LatentImage` —— 官方没有，
 *   由 `electron/comfy_nodes/comic_studio_qwen21/` 提供。用户机器上没这包时，
 *   提交工作流会被 ComfyUI 拒：`Node 'EmptyQwenImage21LatentImage' not found`。
 *
 * 【规则】
 *   1. `electron/comfy_nodes/` 下**每个含 __init__.py 的子目录**都算一个自定义节点包，
 *      打包时整目录进 resources/comfy_nodes（见 package.json extraResources），
 *      运行时逐个装进 ComfyUI 的 custom_nodes —— 新增节点包不需要改本文件。
 *   2. 目标目录优先「ComfyUI 实例自己的 custom_nodes」（实例 = 含 main.py 的目录），
 *      这是 ComfyUI 真正扫描的位置；Desktop 的 %APPDATA%\ComfyUI\custom_nodes 只作兜底。
 *   3. 幂等：内容一致跳过（不刷 mtime）；内容变了先 .bak-时间戳 备份再覆盖。
 *   4. 只碰自己这几个包，不动 custom_nodes 里别人的东西。
 *
 * 【何时生效】
 *   ComfyUI 只在启动时扫 custom_nodes —— 装完必须重启。
 *   launcher.startComfy() 在拉起 ComfyUI 之前调用 ensureCustomNodes()，
 *   用户感知就是「第一次出图前它自己装好了」。
 */

const fs = require('fs');
const path = require('path');

/** 旧包名（保留导出，测试与旧代码还在引用） */
const PKG = 'comic_studio_qwen21';

/* ------------------------------------------------------------------ *
 * 源：软件自带的节点包
 * ------------------------------------------------------------------ */

/** 节点包根目录：打包后在 resources/comfy_nodes；开发时在 electron/comfy_nodes */
function sourceRoot() {
  const cands = [];
  // 测试 / 调试用：直接指定节点包目录（不污染 electron/comfy_nodes）
  if (process.env.COMIC_STUDIO_COMFY_NODES) cands.push(process.env.COMIC_STUDIO_COMFY_NODES);
  try {
    if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'comfy_nodes'));
  } catch (_) { /* 非 Electron 环境 */ }
  cands.push(path.join(__dirname, 'comfy_nodes'));
  for (const c of cands) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch (_) { /* next */ }
  }
  return '';
}

/** 所有节点包：[{ name, dir }]（只认含 __init__.py 的子目录） */
function packages() {
  const root = sourceRoot();
  if (!root) return [];
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try { if (!fs.statSync(path.join(dir, '__init__.py')).isFile()) continue; } catch (_) { continue; }
    out.push({ name: e.name, dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 兼容旧接口：第一个包的源目录（没有就空） */
function sourceDir() {
  const p = packages()[0];
  return p ? p.dir : '';
}

/* ------------------------------------------------------------------ *
 * 目标：ComfyUI 的 custom_nodes
 * ------------------------------------------------------------------ */

const isDir = d => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } };

/**
 * Comfy Desktop 的本地实例清单（权威定位，2026-10-18）。
 *
 * 【为什么需要】用户可能把「安装目录」选成 Desktop 应用目录（有 exe 那层），也可能选到
 *   还没落地实例的空目录。这时靠扫目录找不到实例，但 Desktop 自己的台账是准的：
 *     %APPDATA%\Comfy Desktop\installations.json → 每项 installPath
 *     installPath = <根>\ComfyUI-Installs\<实例名>，本体在其下的 ComfyUI\main.py
 *
 * 🔴 只认 installPath 且 `ComfyUI\main.py` 真实存在的条目：cloud 实例没有本地路径，
 *    创建中断 / 已删除的实例目录也不该算 —— 算进去就会往一个不存在的目录里装。
 * 🔴 **实例名不参与任何判断**：叫「飞鱼AI」还是「学习」完全一样，命名不是前置条件。
 *
 * @returns {{appRoot:string, file:string, hasApp:boolean, list:Array<{id,name,installPath,comfyRoot,version}>}}
 */
function desktopInstances() {
  const appData = process.env.APPDATA || '';
  const appRoot = appData ? path.join(appData, 'Comfy Desktop') : '';
  const file = appRoot ? path.join(appRoot, 'installations.json') : '';
  const out = { appRoot, file, hasApp: !!appRoot && isDir(appRoot), list: [] };
  if (!file) return out;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return out; }
  if (!Array.isArray(raw)) return out;
  for (const it of raw) {
    if (!it || !it.installPath) continue;
    if (String(it.sourceId || '').toLowerCase() === 'cloud') continue;
    const installPath = String(it.installPath);
    let comfyRoot = '';
    if (fs.existsSync(path.join(installPath, 'ComfyUI', 'main.py'))) comfyRoot = path.join(installPath, 'ComfyUI');
    else if (fs.existsSync(path.join(installPath, 'main.py'))) comfyRoot = installPath;
    if (!comfyRoot) continue;
    out.list.push({
      id: it.id || '',
      name: it.name || '',
      installPath,
      comfyRoot,
      version: (it.comfyVersion && it.comfyVersion.baseTag) || it.version || ''
    });
  }
  return out;
}

/**
 * 候选 custom_nodes（去重，按可信度排序）。
 *   kind: 'instance' = 含 main.py 的 ComfyUI 本体（ComfyUI 真正扫这里）
 */
function customNodesCandidates(installDir) {
  const out = [];
  const push = (comfyRoot, kind) => {
    if (!comfyRoot) return;
    const dir = path.join(comfyRoot, 'custom_nodes');
    if (out.some(x => x.dir.toLowerCase() === dir.toLowerCase())) return;
    out.push({ dir, comfyRoot, kind });
  };
  // ⓪ Desktop 台账里的实例最准：即使 installDir 选成应用目录 / 空目录也能命中
  try { for (const it of desktopInstances().list) push(it.comfyRoot, 'instance'); } catch (_) { /* 台账读不到就扫目录 */ }
  const scan = (root, depth) => {
    if (!root || depth < 0) return;
    // 便携 python 形态：installDir 是包根，本体在 <root>\ComfyUI\main.py
    if (fs.existsSync(path.join(root, 'ComfyUI', 'main.py'))) push(path.join(root, 'ComfyUI'), 'instance');
    // Desktop / 源码形态：installDir 直接就是 ComfyUI
    if (fs.existsSync(path.join(root, 'main.py'))) push(root, 'instance');
    if (depth === 0) return;
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()); } catch (_) { return; }
    for (const e of ents) {
      // 🔴 跳过又大又不可能装 ComfyUI 本体的目录（ComfyUI-Shared 里是几十上百 GB 模型）
      if (/^(node_modules|\.git|models|custom_nodes|venv|\.venv|python_embeded|python_embeded|ComfyUI-Shared|ComfyUI-Cache|__pycache__)$/i.test(e.name)) continue;
      scan(path.join(root, e.name), depth - 1);
    }
  };
  // 深度 2 是必须的：Comfy Desktop 的布局是 <Desktop 根>\ComfyUI-Installs\<实例名>\ComfyUI\main.py，
  // 而 launcher 返回的 installDir 是「Comfy Desktop.exe 所在目录」→ 深度 1 扫不到实例。
  const isComfyRoot = fs.existsSync(path.join(installDir, 'main.py'))
    || fs.existsSync(path.join(installDir, 'ComfyUI', 'main.py'));
  // 🔴 本机实测：Comfy Desktop 的 installDir = <Desktop 根>\Comfy Desktop（应用目录），
  //    实例在**上一级**的 ComfyUI-Installs 里。不扫父目录 → dirs=[] → 一个都装不上。
  const parent = path.dirname(installDir);
  const parentHasInstalls = !!parent && parent !== installDir
    && fs.existsSync(path.join(parent, 'ComfyUI-Installs'));
  if (isComfyRoot || !parentHasInstalls) scan(installDir, 2);
  if (parentHasInstalls) scan(parent, 2);

  // 🔴 没有 `%APPDATA%\ComfyUI\custom_nodes` 兜底：新版 Desktop 根本不扫那里
  //    （本机实测该目录不存在）。写进去只会"显示已置备、实际不生效"，
  //    正是用户明确否掉的"兼容错误方式"。
  return out;
}

/** 只返回**已存在**的候选目录（旧接口保留） */
function customNodesDirs(installDir) {
  return customNodesCandidates(installDir).filter(c => isDir(c.dir)).map(c => c.dir);
}

/**
 * 安装目标（可能多个）：
 *   机器上常有多个 ComfyUI 实例（Desktop 可以建好几个）。**不能猜哪个是活跃的** ——
 *   Desktop 的 config.json 只记 basePath，不记当前实例；猜错就等于没装。
 *   节点包只有几十 KB，所以「所有存在的实例都装一份」是这里最稳的策略：
 *   无论用户从哪个实例启动 ComfyUI，节点都在。
 *
 * 🔴 一个实例都没有 → 返回空数组，**不写任何东西**。
 *    没有实例就没有真实存在的 custom_nodes；装到"兜底目录"等于装进空气，
 *    还会让界面误以为已置备。这里必须让调用方拿到失败，去提示用户先建实例。
 */
function targetDirs(installDir) {
  const cands = customNodesCandidates(installDir);
  const out = [];
  for (const c of cands) {
    if (c.kind !== 'instance') continue;
    if (!isDir(c.comfyRoot)) continue;          // 实例本体存在才算
    if (out.some(d => d.toLowerCase() === c.dir.toLowerCase())) continue;
    out.push(c.dir);
  }
  return out;
}

/** 首选目标（兼容单目录调用方：展示用） */
function targetDir(installDir) {
  return targetDirs(installDir)[0] || '';
}

/* ------------------------------------------------------------------ *
 * 状态 / 安装
 * ------------------------------------------------------------------ */

function readText(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
}

/**
 * 只保留「代码本体」：去掉 docstring、# 注释与空白。
 * 🔴 用途只是判断「要不要重装」——注释变化不该触发写盘，也不该让界面一直显示"非最新"。
 *    宁可误判为"不同"（多装一次，安全），也不能误判为"相同"（漏装代码改动）。
 */
function stripComments(s) {
  let t = String(s || '');
  t = t.replace(/"""[\s\S]*?"""/g, '');
  t = t.replace(/'''[\s\S]*?'''/g, '');
  t = t.split(/\r?\n/).map(l => l.replace(/(^|[^\\])#.*$/, '$1')).join('\n');
  return t.replace(/\s+/g, ' ').trim();
}

/** 两份 __init__.py 是否功能等价（注释差异不算差异） */
function sameCode(a, b) {
  if (a == null || b == null) return false;
  if (a === b) return true;
  return stripComments(a) === stripComments(b);
}

/**
 * 整个节点包的「代码指纹」：把所有 .py（含子目录）+ pyproject.toml 的代码本体
 * 归一化后拼成一个字符串，用来判断「要不要重装」。
 *
 * 🔴 为什么不能只比 __init__.py：新版 ComfyUI 插件（如 comic_studio_h3_t8）的
 *    __init__.py 只有一行 `from .nodes import comfy_entrypoint`，真正的节点逻辑在
 *    nodes.py / h3_block_cache.py 里 —— 只比 __init__.py 会在升级插件（改了 nodes.py）
 *    时误判「已最新」、漏装。老式单文件包（qwen21）逻辑全在 __init__.py，行为不变。
 * 🔴 只认 .py / pyproject.toml：README/LICENSE/.gitignore 这些不该触发重装。
 *    文件缺失（源有、目标无）也会体现在指纹不同（源串更长/不同）→ 判为需重装。
 */
function pkgCode(dir) {
  if (!dir) return '';
  const parts = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));   // 顺序稳定，避免遍历序差异误判
    for (const e of ents) {
      if (/^(__pycache__|\.git)$/i.test(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.py$/i.test(e.name) || /^pyproject\.toml$/i.test(e.name)) {
        const txt = readText(p);
        if (txt != null) parts.push(e.name + ':' + stripComments(txt));
      }
    }
  };
  walk(dir);
  return parts.join('|');
}

/** 递归拷贝（不用 fs.cpSync：Windows 中文路径上见过段错误） */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (/^(__pycache__|\.git)$/i.test(e.name) || /\.pyc$/i.test(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 只读体检：每个包装没装、是不是最新。
 * 兼容旧字段：installed / upToDate / dir / available 是所有包的**聚合**。
 */
function nodePkgsState(installDir) {
  const pkgs = packages();
  const dirs = targetDirs(installDir);
  const list = pkgs.map(p => {
    const srcCode = pkgCode(p.dir);
    const targets = dirs.map(d => {
      const dst = path.join(d, p.name);
      const dstCode = pkgCode(dst);
      const dstBody = readText(path.join(dst, '__init__.py'));
      return {
        dir: dst,
        installed: !!dstBody,
        upToDate: sameCode(srcCode, dstCode)
      };
    });
    return {
      name: p.name,
      dir: targets.length ? targets[0].dir : '',
      dirs: targets.map(t => t.dir),
      targets,
      // 聚合语义：**每个**实例都得有、都得最新，才算就绪
      installed: targets.length > 0 && targets.every(t => t.installed),
      upToDate: targets.length > 0 && targets.every(t => t.upToDate)
    };
  });
  const pending = list.filter(x => !x.upToDate).map(x => x.name);
  return {
    available: list.length > 0,
    count: list.length,
    dir: dirs[0] || '',
    dirs,
    installed: list.length > 0 && list.every(x => x.installed),
    upToDate: list.length > 0 && list.every(x => x.upToDate),
    list,
    pending
  };
}

/** 兼容旧名字（只关心第一个包的老调用方） */
function nodePkgState(installDir) {
  const s = nodePkgsState(installDir);
  const first = s.list[0] || null;
  return {
    available: s.available,
    dir: first ? first.dir : '',
    installed: first ? first.installed : false,
    upToDate: first ? first.upToDate : false,
    source: sourceDir()
  };
}

/**
 * 安装全部节点包（幂等）。
 * @returns {{ok:boolean, changed:boolean, needRestart:boolean, dir:string,
 *            installed:string[], updated:string[], list:Array, message:string}}
 */
function ensureCustomNodes(installDir) {
  const pkgs = packages();
  if (!pkgs.length) {
    return { ok: false, code: 'nopkg', changed: false, needRestart: false, dir: '', installed: [], updated: [], list: [], message: '软件里没找到自定义节点包（resources/comfy_nodes）。' };
  }

  const dirs = targetDirs(installDir);
  if (!dirs.length) {
    // 区分两种"没地方装"：① Desktop 装了但一个实例都没有（最常见）② 路径不是 ComfyUI
    const desk = desktopInstances();
    const noInst = desk.hasApp && desk.list.length === 0;
    return {
      ok: false,
      code: noInst ? 'noinstance' : 'nodir',
      changed: false, needRestart: false, dir: '', installed: [], updated: [], list: [],
      message: noInst
        ? 'ComfyUI Desktop 已安装，但还没有创建实例。请打开 ComfyUI Desktop，新建并启动一个实例，再回来设置一次。'
        : '没找到 ComfyUI 的 custom_nodes 目录。请选「Comfy Desktop.exe 所在文件夹」，或实例里含 main.py 的 ComfyUI 文件夹。'
    };
  }

  const installed = [];
  const updated = [];
  const failed = [];
  for (const dstRoot of dirs) {
    for (const p of pkgs) {
      const dst = path.join(dstRoot, p.name);
      const srcCode = pkgCode(p.dir);
      const dstFile = path.join(dst, '__init__.py');
      const dstBody = readText(dstFile);
      const dstCode = pkgCode(dst);
      if (sameCode(srcCode, dstCode)) continue;          // 功能等价（注释差异不算），不写盘
      try {
        if (dstBody != null) {
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
          try { fs.copyFileSync(dstFile, dstFile + '.bak-' + stamp); } catch (_) { /* 备份失败不阻断 */ }
        }
        copyDir(p.dir, dst);
        const bucket = dstBody != null ? updated : installed;
        if (!bucket.includes(p.name)) bucket.push(p.name);
      } catch (e) {
        failed.push(p.name + ' → ' + dstRoot + '：' + ((e && e.message) || e));
      }
    }
  }

  const changed = installed.length + updated.length > 0;
  const where = dirs.length > 1 ? ('（' + dirs.length + ' 个 ComfyUI 实例各装一份）') : '';
  if (failed.length) {
    return {
      ok: false, code: 'write', changed, needRestart: changed, dir: dirs[0], installed, updated,
      list: nodePkgsState(installDir).list,
      message: '部分节点包安装失败：' + failed.join('；')
    };
  }
  return {
    ok: true, code: 'ok', changed, needRestart: changed, dir: dirs[0], installed, updated,
    list: nodePkgsState(installDir).list,
    message: changed
      ? ('已安装节点包：' + [...installed, ...updated].join('、') + where + '。ComfyUI 需重启一次才会加载。')
      : ('节点包已是最新（' + pkgs.length + ' 个：' + pkgs.map(p => p.name).join('、') + '）' + where + '。')
  };
}

/**
 * 把 ensureCustomNodes 的失败翻译成「用户能照着做」的原因。
 * 🔴 不要笼统说「重启软件、重新设置路径」：权限问题重启一百次也没用，
 *    占用问题重设路径也没用 —— 提示必须指向真正能解决它的那个动作。
 * @returns {null|{code:'permission'|'busy'|'nodir'|'nopkg'|'other', text:string}}
 */
function classifyInstallError(res) {
  // 优先看结构化 code：文案正则只作老调用方的兜底
  if (res && res.code === 'noinstance') {
    return {
      code: 'noinstance',
      text: '还没创建 ComfyUI 实例。请打开 ComfyUI Desktop，新建并启动一个实例，然后回来再点一次「选择 ComfyUI 安装目录…」。'
    };
  }
  if (!res || res.ok) return null;
  const msg = String(res.message || '');
  if (res.code === 'nodir' || /没找到 ComfyUI 的 custom_nodes|ENOENT/i.test(msg)) {
    return {
      code: 'nodir',
      text: '没找到 ComfyUI 实例。请选「Comfy Desktop.exe 所在文件夹」，或实例里含 main.py 的 ComfyUI 文件夹。'
    };
  }
  if (/EACCES|EPERM|permission denied|拒绝访问/i.test(msg)) {
    return {
      code: 'permission',
      text: '没有写入权限，节点装不进去。请右键本软件 →「以管理员身份运行」，再点一次重试。'
    };
  }
  if (/EBUSY|EPERM.*locked|being used|正在使用|占用/i.test(msg)) {
    return {
      code: 'busy',
      text: '文件被占用（多为杀毒软件正在扫描）。请暂时关闭杀毒软件保护后点重试。'
    };
  }
  if (/没找到自定义节点包/i.test(msg)) {
    return { code: 'nopkg', text: '安装包里的节点文件缺失，请重新安装本软件。' };
  }
  return { code: 'other', text: '节点安装失败：' + msg };
}

module.exports = {
  PKG, sourceRoot, packages, sourceDir,
  desktopInstances,
  customNodesCandidates, customNodesDirs, targetDir, targetDirs,
  nodePkgsState, nodePkgState, ensureCustomNodes, classifyInstallError
};
