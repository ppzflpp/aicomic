'use strict';
const { ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const projects = require('./projects.cjs');
const assetStore = require('./assetStore.cjs');
const models = require('./models.cjs');
const profiles = require('./profiles.cjs');
const modelImport = require('./modelImport.cjs');
const comfyProbe = require('./comfyProbe.cjs');
const comfySetup = require('./comfySetup.cjs');
const inference = require('./inference.cjs');
const launcher = require('./launcher.cjs');
const logger = require('./logger.cjs');
const metrics = require('./metrics.cjs');
const session = require('./session.cjs');
const orchestrator = require('./orchestrator.cjs');
const promptFiles = require('./prompts.cjs');
const styles = require('./styles.cjs');
const library = require('./library.cjs');
const outfits = require('./outfits.cjs');
const filesig = require('./filesig.cjs');
const videoTiers = require('./videoTiers.cjs');
const llmProvider = require('./llmProvider.cjs');
const { writeUnique } = require('./assetStore.cjs');

/** safeStorage 加解密包装（系统不支持时返回 null，llmProvider 会退化成 base64 存储） */
function safeStorageCrypto() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return {
      encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
      decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64'))
    };
  } catch (_) { return null; }
}

/** 注册全部 IPC。getWin 返回主窗口（用于目录选择对话框），测试环境可传 () => null。 */
function registerIpc(db, getWin, fallbackWorkspace) {
  // 日志总线与系统监控都要拿到窗口才能推事件；在这里统一初始化，
  // 冒烟测试（smoke-ui.cjs）只调 registerIpc 也能自动接上。
  logger.init(db, getWin);
  metrics.init(db, getWin);
  session.init(db);
  orchestrator.init(db);
  styles.init();        // 风格包（项目级题材 / 画风）：内置 electron/styles/ + <项目>/styles/ 覆盖
  // 大模型来源（本地 / 云端）：密钥用系统级 safeStorage 加密后再落库（拿不到就退化成 base64）
  llmProvider.init(db, safeStorageCrypto());
  logger.info('主进程已就绪，IPC 注册完成');
  // 换工作区 = 落库 + 清掉 inference 里缓存的旧工作区
  // （不清的话工作流模板 / tools/ffmpeg.exe 会一直认着旧目录）
  const setWorkspace = (dir) => {
    db.setSetting('workspace', dir);
    inference.forgetWorkspace();
    styles.reload();   // 换工作区 = 项目根解析结果变了（<项目>/styles/），按项目根的缓存必须整体作废
  };
  ipcMain.handle('workspace:get', () => db.getSetting('workspace'));
  ipcMain.handle('workspace:choose', async () => {
    const win = getWin ? getWin() : null;
    if (!win) {
      if (fallbackWorkspace) {
        setWorkspace(fallbackWorkspace);
        inference.ensureDefaultTemplates();
        return fallbackWorkspace;
      }
      return null;
    }
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    setWorkspace(r.filePaths[0]);
    inference.ensureDefaultTemplates();
    return r.filePaths[0];
  });

  ipcMain.handle('tree:get', (e, workspace) => projects.getTree(db, workspace));
  ipcMain.handle('project:create', (e, workspace, name, res) => {
    const p = projects.createProject(db, workspace, name, res);
    // 项目诞生即落一个空库（不迁移）：把「本项目从此刻开始用库」钉死。
    // 否则「老项目迁移」的触发时机不可控 —— 若发生在用户已生成图之后，
    // 本次会话新生成的图会被静默入库、集内卡片当场变只读（e2e 实测踩到）。
    try { library.initLibrary(db, workspace, p.id); } catch (_) {}
    return p;
  });
  ipcMain.handle('project:delete', (e, workspace, projectId) => projects.deleteProject(db, workspace, projectId));
  ipcMain.handle('folder:add', (e, workspace, projectId, parentId, name) => projects.addFolder(db, workspace, projectId, parentId, name));
  ipcMain.handle('folder:delete', (e, workspace, folderId) => projects.deleteFolder(db, workspace, folderId));
  ipcMain.handle('episode:add', (e, workspace, projectId, folderId, name) => projects.addEpisode(db, workspace, projectId, folderId, name));
  ipcMain.handle('episode:delete', (e, workspace, episodeId) => projects.deleteEpisode(db, workspace, episodeId));
  ipcMain.handle('episode:get', (e, workspace, episodeId) => projects.getEpisodeFull(db, workspace, episodeId));
  ipcMain.handle('episode:saveChapter', (e, workspace, episodeId, text) => projects.saveChapter(db, workspace, episodeId, text));
  ipcMain.handle('episode:saveState', (e, episodeId, done, active, meta) => projects.saveState(db, episodeId, done, active, meta));
  ipcMain.handle('episode:saveArtifact', (e, workspace, episodeId, kind, data) => projects.saveArtifact(db, workspace, episodeId, kind, data));

  /* ---- 项目媒体（左侧树：assets 角色图 / 分镜视频 / 成片视频），按需懒加载 ---- */

  /** 列举 root 下各子目录里的媒体文件（角色名/场景名 → 文件列表） */
  const listAssetGroups = (root, re) => {
    if (!root || !fs.existsSync(root)) return [];
    const out = [];
    let subs = [];
    try { subs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
    for (const d of subs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      let files = [];
      try { files = fs.readdirSync(dir); } catch (_) { continue; }
      const items = files.filter(f => re.test(f)).map(f => {
        const abs = path.join(dir, f);
        let st = null;
        try { st = fs.statSync(abs); } catch (_) {}
        return st ? { file: f, path: abs, size: st.size, mtimeMs: st.mtimeMs } : null;
      }).filter(Boolean).sort((a, b) => a.file.localeCompare(b.file, 'zh'));
      if (items.length) out.push({ name: d.name, dir, files: items });
    }
    return out;
  };

  // 项目资产：角色图（assets/characters/<角色名>/）+ 场景图（assets/scenes/<场景名>/）
  ipcMain.handle('project:assets', (e, workspace, projectId) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    if (!root) return { characters: [], scenes: [] };
    const re = /\.(png|jpg|jpeg|webp)$/i;
    return {
      characters: listAssetGroups(path.join(root, 'assets', 'characters'), re),
      scenes: listAssetGroups(path.join(root, 'assets', 'scenes'), re)
    };
  });

  // 镜头视频 / 成片：项目下「分镜/」「成片/」两个平铺目录，按**集名前缀**归到各集（扁平化后不再有集数子目录）
  const listEpisodeMedia = async (workspace, projectId, kind) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    if (!root) return [];
    const eps = projects.listProjectEpisodes(db, workspace, projectId);
    const dir = path.join(root, kind === 'film' ? '成片' : '分镜');
    let all = [];
    try { all = await inference.listVideosWithMeta(dir); } catch (_) { all = []; }
    // 长前缀优先匹配：要求「集名 + _」完整命中，所以「第1集下」不会被「第1集」误吞
    const sorted = eps.slice().sort((a, b) => b.prefix.length - a.prefix.length);
    const used = new Set();
    const out = [];
    for (const ep of sorted) {
      const files = all.filter(f => !used.has(f.file) && f.file.startsWith(ep.prefix + '_'));
      for (const f of files) used.add(f.file);
      if (files.length) out.push({ episodeId: ep.id, name: ep.name, dir, files });
    }
    out.sort((a, b) => a.episodeId - b.episodeId);   // 与左侧树集数顺序一致
    return out;
  };
  ipcMain.handle('project:shots', (e, workspace, projectId) => listEpisodeMedia(workspace, projectId, 'shot'));
  ipcMain.handle('project:films', (e, workspace, projectId) => listEpisodeMedia(workspace, projectId, 'film'));

  // 剧本工件：项目下「剧本/」平铺目录（章节原文 / 改编稿 / 分镜脚本 / 角色档案 / 场景档案），按集名前缀归集
  ipcMain.handle('project:scripts', (e, workspace, projectId) => projects.listProjectScripts(db, workspace, projectId));

  /* ---- 项目角色场景库（<项目>/assets/library.json）----
     跨集共享的角色/场景条目：命中即只读加载，本集新增的卡片可「保存到项目」入库。
     首次访问会自动迁移老项目（把 assets 下已有图片目录补成库条目）。 */
  ipcMain.handle('library:list', (e, workspace, projectId) => library.listLibrary(db, workspace, projectId));
  ipcMain.handle('library:save', (e, workspace, projectId, payload) => library.saveEntry(db, workspace, projectId, payload));
  ipcMain.handle('library:add', (e, workspace, projectId, kind, name) => library.addEntry(db, workspace, projectId, kind, name));
  ipcMain.handle('library:rename', (e, workspace, projectId, id, newName) => library.renameEntry(db, workspace, projectId, id, newName));
  ipcMain.handle('library:usage', (e, workspace, projectId, id) => library.entryUsage(db, workspace, projectId, id));
  // 删除库条目：opts.deleteFiles=true → 连同图片目录一起删；false → 仅移出库（图片留盘）
  ipcMain.handle('library:remove', (e, workspace, projectId, id, opts) => library.removeEntry(db, workspace, projectId, id, opts));
  // 全库引用快照：库视图整页铺卡时一次拿全部条目的「被哪些集/镜引用」（逐条查会 N×集 次读盘）
  ipcMain.handle('library:usageAll', (e, workspace, projectId) => library.usageAll(db, workspace, projectId));
  // 「切换变体」：把某一集里旧名换成新名（卡片 + 分镜 chars·scene + 对白人名），不动库条目
  ipcMain.handle('library:swap', (e, workspace, projectId, episodeId, kind, oldName, newName, newId) =>
    library.renameInEpisode(db, workspace, projectId, episodeId, kind, oldName, newName, newId));

  /* ---- 项目级装扮清单（<项目>/assets/outfits.json）----
     装扮 = 人物属性，不是某一集的私事：清单挂项目，识别时把已知装扮名下发给模型让它沿用，
     识别完把结果并回去（并集）→ 同一个装扮在第 3 集不会长成第二个名字、第二张卡。
     只有读 / 整份写两个动作，合并口径在渲染层纯函数（promptlib.mergeOutfitList）。 */
  ipcMain.handle('outfits:read', (e, workspace, projectId) => outfits.readOutfits(db, workspace, projectId));
  ipcMain.handle('outfits:put', (e, workspace, projectId, book) => outfits.putOutfits(db, workspace, projectId, book));

  // 素材目录复制（只增不删、不删源）：本集私有的图 ↔ 库条目目录之间的同步
  //   入库时「集 → 库」（让库条目拿到这份素材）、按库更新时「库 → 集」（把库的最新图拉进本集）
  ipcMain.handle('assets:copyDir', (e, from, to) => assetStore.copyDir(from, to));

  /* ---- 素材文件指纹（files:sig，2026-10-16）----
     分镜页的脏标记要知道「参考图还是生成提示词时那张吗」。以前只看「出自哪张卡的哪一版」，
     用户手工换图（覆盖同名文件）时那个数字不动 → 提示词过期了却不提示。这里按绝对路径回
     一个 `大小:修改时间` 指纹，渲染层把「参考图顺序 + 各自指纹」写进签名，换图即标脏。 */
  ipcMain.handle('files:sig', (e, files) => filesig.sigMany(files));

  // 从本地导入一张图当卡片参考图（2026-10-08）：复制进该卡的素材目录 + 按卡名唯一命名，
  // 返回实际文件名。用户自带图（下载/拍摄）不必经过模型抽卡；源文件之后移动/删除都不影响。
  ipcMain.handle('assets:importImage', (e, dir, baseName, src) => assetStore.importFile(dir, baseName, src));

  // 归档「重新生成分镜后不再出现的角色/场景」的图片目录（2026-10-07）：
  //   移到 <集私有素材根>/_trash/<时间戳>/ 而不是删掉 —— 图是花显卡时间出的，得能找回。
  //   items = [{kind:'character'|'scene', name}]，由渲染层按「旧档案有、新档案没有、且非库条目」筛出来。
  //   🔴 getEpisode 返回的是**渲染层 DTO**（字段名驼峰 projectId），而路径算法读的是 project_id ——
  //      直接把它丢进去会让 assetsRoot 拿不到项目、整个归档**静默返回空**（不报错，最难查的那种）。
  //      这里显式映射，别图省事。
  ipcMain.handle('assets:archiveOrphans', (e, workspace, episodeId, items) => {
    const ep = projects.getEpisode(db, workspace, episodeId);
    if (!ep) return { moved: [], failed: [], trashDir: null };
    return projects.archiveEpisodeAssets(db, workspace, { name: ep.name, project_id: ep.projectId }, items);
  });

  // 「重新生成分镜」的一键清空（2026-10-09，Dragon）：角色/场景图 + 镜头视频 + 首帧图 + 成片
  //   全部归档到**同一个** _trash/<时间戳>/（不删除，可找回）。
  //   items = 本集旧卡片里需要归档的角色/场景名（手动卡与库只读卡由渲染层排除）。
  //   与上面那条同样的 DTO 陷阱：必须显式映射 project_id。
  ipcMain.handle('assets:archiveEpisodeOutputs', (e, workspace, episodeId, items) => {
    const ep = projects.getEpisode(db, workspace, episodeId);
    if (!ep) return { moved: [], failed: [], trashDir: null };
    return projects.archiveEpisodeOutputs(db, workspace, { name: ep.name, project_id: ep.projectId }, items);
  });

  /* ---- 项目级提示词规范文件（<项目>/prompts/*.md）：五个模块的风格规范，用户可编辑；
          文件缺失 / 还是旧版结构时，主进程自动从内置 skills/prompts/ 补齐或重播 ---- */
  ipcMain.handle('prompt:list', (e, workspace, projectId) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    if (!root) return [];
    promptFiles.seedAt(root);          // 列表顺带播种（老项目打开树即完成升级）
    // 顺带把这个**项目当前体裁**要用的规范变体（如广告体裁的 adapt-ad.md）也列出来并按需播种，
    // 否则用户得先跑去生成一次分镜，配置中心里才看得到那份体裁规范、才能改它。
    return promptFiles.listAt(root, specFilesOf(workspace, projectId));
  });
  ipcMain.handle('prompt:read', (e, workspace, projectId, name) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    return root ? promptFiles.readAt(root, name) : '';
  });
  ipcMain.handle('prompt:save', (e, workspace, projectId, name, content) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    return root ? promptFiles.saveAt(root, name, content) : false;
  });
  // 恢复内置版：删掉项目副本 + 立刻重播（与 rev 升级同一条路径）
  ipcMain.handle('prompt:reset', (e, workspace, projectId, name) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    return root ? promptFiles.resetAt(root, name) : false;
  });

  /* ---- 成品覆写（<项目>/prompts/final/<用途>.md）----
          用户看到的是「合成出来的那一篇成品提示词」，这里让他直接改它，省得去理解
          「通用规范 + 模型专属 + 风格替换 + 风格说明」是怎么拼的。
          覆写存在 → 该用途直接下发覆写全文（不再合成，也不做风格替换）；删掉即恢复合成。
          🔴 代价是脱钩：改画风 / 换模型不再影响它 —— 界面必须显式标出来并给一键恢复。---- */
  ipcMain.handle('prompt:finalList', (e, workspace, projectId) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    return root ? promptFiles.listFinal(root) : {};
  });
  ipcMain.handle('prompt:finalRead', (e, workspace, projectId, taskId) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    return root ? promptFiles.readFinal(root, taskId) : null;
  });
  ipcMain.handle('prompt:finalSave', (e, workspace, projectId, taskId, content) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    return root ? promptFiles.saveFinal(root, taskId, content) : false;
  });
  ipcMain.handle('prompt:finalClear', (e, workspace, projectId, taskId) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    return root ? promptFiles.clearFinal(root, taskId) : false;
  });

  /* ---- 风格体系（四轴：画面风格 / 世界设定 / 内容体裁 / 制作调性）----
          规范正文里的 {{S.x}} 占位符由渲染层用这里的 vars 在内存里替换；
          磁盘上的项目 prompts/ 副本不含替换结果（所以 rev 播种与用户手改都不受影响）。
          🔴 get 会连 resolved 一起给：项目存的风格解析不了时**不静默回落**，
             由界面把 resolved.reason 显示出来（否则用户以为在用现代风格、实际出古风片）。---- */
  /* 🔴 2026-10-07 改造：风格覆盖已从工作区下沉到**项目**（<项目>/styles/），
     所以下面每个读写都要拿到项目根。没给项目（新建弹窗、设置页）→ '' = 纯用内置。---- */
  const projRootOf = (ws, pid) => {
    if (!ws || !pid) return '';
    try { return projects.projectRoot(db, ws, Number(pid)) || ''; } catch (_) { return ''; }
  };

  /** 本项目当前风格包声明的规范文件清单（逻辑名 → 文件列表）里出现过的真实文件名。
   *  这是「按体裁分流规范」的读取侧：提示词配置中心靠它把该体裁的变体列出来并按需播种，
   *  别的体裁的规范文件不会进这个项目的清单（剧集项目永远看不到广告体裁那几份）。 */
  const specFilesOf = (ws, pid) => {
    const root = projRootOf(ws, pid);
    if (!root) return [];
    let id = '';
    try { id = (db.raw.prepare('SELECT style FROM projects WHERE id=?').get(Number(pid)) || {}).style || ''; }
    catch (_) { id = ''; }
    let files = null;
    try { files = (styles.get(id || styles.defaultId(), root) || {}).files || null; }
    catch (_) { return []; }
    const out = [];
    for (const list of Object.values(files || {})) for (const n of (list || [])) if (out.indexOf(n) < 0) out.push(n);
    return out;
  };

  ipcMain.handle('styles:list', (e, ws, pid) => styles.list(projRootOf(ws, pid)));
  ipcMain.handle('styles:axes', (e, ws, pid) => styles.axes(projRootOf(ws, pid)));
  ipcMain.handle('styles:errors', (e, ws, pid) => {
    const root = projRootOf(ws, pid);
    return { errors: styles.errors(root), warnings: styles.warnings(root) };
  });
  ipcMain.handle('styles:get', (e, id, ws, pid) => {
    const p = styles.get(id, projRootOf(ws, pid));
    if (!p) return null;
    return {
      id: p.id, name: p.name, desc: p.desc, tags: p.tags, rev: p.rev,
      append: p.append, vars: p.vars, text: p.text,
      files: p.files,
      // 体裁裁剪（2026-10-09）：真实文件名 → 下发前按行丢弃的片段；
      // limits = 该体裁声明的程序侧校验参数（分镜自检用）。两项都从风格包原样透给渲染层。
      drop: p.drop, limits: p.limits,
      render: p.render, world: p.world, genre: p.genre, tone: p.tone,
      warnings: p.warnings, resolved: p.resolved
    };
  });
  /* ---- 风格文件（把 electron/styles/ 的结构摊开给界面看与改）----
          写一律落到 **项目** <项目>/styles/<rel>（同名覆盖内置），删掉即恢复内置。
          保存 / 恢复后必须 reload：下一次 axes/files/get 才是新的。---- */
  ipcMain.handle('styles:files', (e, ws, pid) => styles.fileList(projRootOf(ws, pid)));
  ipcMain.handle('styles:fileRead', (e, rel, ws, pid) => styles.readFile(rel, projRootOf(ws, pid)));
  ipcMain.handle('styles:fileSave', (e, rel, content, ws, pid) => {
    styles.saveFile(rel, content, projRootOf(ws, pid));   // JSON 语法错误会在这里抛出去，界面直接提示
    styles.reload();
    return true;
  });
  ipcMain.handle('styles:fileClear', (e, rel, ws, pid) => {
    const ok = styles.clearFile(rel, projRootOf(ws, pid));
    styles.reload();
    return ok;
  });

  /* ---- 分辨率 / 视频档位配置（项目级 = 新建剧集的初始模板；剧集级 = 本集生效值）---- */
  ipcMain.handle('res:options', () => models.resOptions());
  // 视频档位清单：渲染层下拉直接用主进程给的档位名渲染（UI 不硬编码、不出现模型信息）
  ipcMain.handle('res:tiers', () => videoTiers.list());
  ipcMain.handle('project:res:get', (e, projectId) => projects.getProjectRes(db, projectId));
  ipcMain.handle('project:res:set', (e, projectId, res) => projects.setProjectRes(db, projectId, res));
  ipcMain.handle('episode:res:set', (e, episodeId, kind, value) => projects.setEpisodeRes(db, episodeId, kind, value));

  /* ---- 设置 ---- */
  ipcMain.handle('models:check', () => models.check());

  /* ---- 模型方案（profile）：换生图 / 生视频模型只改配置 ----
     list 给设置页下拉；set 切换（返回最新环境检测）；reload 让用户在工作区丢了新方案后重扫；
     promptExtras 把方案自带的模型专属规范交给渲染层，拼在通用规范之后下发。 */
  ipcMain.handle('profiles:list', (e, kind) => profiles.list(kind));
  ipcMain.handle('profiles:set', (e, kind, id) => { profiles.set(kind, id); return models.check(); });
  ipcMain.handle('profiles:reload', () => {
    // 模型管家的槽位表由方案派生，方案重扫后要一并失效，否则新方案的模型仍然「不知道该放哪」
    modelImport.reloadSlots();
    return profiles.reload();
  });
  ipcMain.handle('profiles:promptExtras', (e, ws, pid) => profiles.promptExtras(projRootOf(ws, pid)));

  /* ---- 模型专属规范的读写（项目覆盖落在 <项目>/prompts/model/）----
          以前只能手改文件（连目录都没有），现在界面可编辑。
          🔴 保存 / 恢复后渲染层必须 clearPromptExtras()，否则缓存住的那份正文还在用。
          🔴 2026-10-07 改造：覆盖从工作区下沉到项目 —— 换模型写法只影响它所属的那部片子。---- */
  ipcMain.handle('profiles:promptList', (e, ws, pid) => profiles.extraList(projRootOf(ws, pid)));
  ipcMain.handle('profiles:promptRead', (e, name, ws, pid) => profiles.readExtra(name, projRootOf(ws, pid)));
  ipcMain.handle('profiles:promptSave', (e, name, content, ws, pid) => profiles.saveExtra(name, content, projRootOf(ws, pid)));
  ipcMain.handle('profiles:promptClear', (e, name, ws, pid) => profiles.clearExtra(name, projRootOf(ws, pid)));

  // ComfyUI 模型根目录（用户只需设置这一个）
  ipcMain.handle('models:setRoot', (e, dir) => models.setModelsRoot(dir));
  ipcMain.handle('models:detectRoot', () => {
    const r = models.redetect();
    return { detected: r.modelsRoot || '', state: r };
  });
  /* 模型根校验 + 从 ComfyUI 安装目录推导 models（2026-10-18 三次改版）
     🔴 用户只做一个动作：选「ComfyUI 安装目录」。models 由主进程推，不要求用户懂目录结构。
        推不出来 / 推错 → 直接报错，不做「大概能跑」的宽容判断。 */
  ipcMain.handle('comfy:resolveModels', (e, dir) => {
    try { return comfyProbe.resolveModelsFromInstall(dir); }
    catch (err) { return { ok: false, modelsRoot: '', source: '', reason: '推导失败：' + ((err && err.message) || err) }; }
  });
  ipcMain.handle('models:validateRoot', (e, dir) => {
    try { return comfyProbe.validateModelsRoot(dir, launcher.comfyInfo()); }
    catch (err) { return { level: 'warn', dir: dir || '', message: '校验失败：' + ((err && err.message) || err), hints: [] }; }
  });
  ipcMain.handle('models:pick', () => models.workflowModels());
  ipcMain.handle('models:chooseDir', async (e, key) => {
    const win = getWin ? getWin() : null;
    if (!win) return null;
    const def = models.resolveDir(key);
    const opts = { properties: ['openDirectory'] };
    if (def && fs.existsSync(def)) opts.defaultPath = def;
    const r = await dialog.showOpenDialog(win, opts);
    if (r.canceled || !r.filePaths.length) return null;
    return models.setPath(key, r.filePaths[0]);
  });
  ipcMain.handle('settings:get', (e, key) => db.getSetting(key));
  ipcMain.handle('settings:set', (e, key, value) => { db.setSetting(key, value); return true; });
  /* 通用「选一个文件」对话框（目前给 ffmpeg 用：用户自己指定 ffmpeg.exe 路径）。
     只回路径不落库 —— 界面上还要点「保存」才生效，用户可以先改了再改主意。 */
  ipcMain.handle('settings:pickFile', async (e, key, opts) => {
    const win = getWin ? getWin() : null;
    if (!win) return null;
    const cur = key ? db.getSetting(key) : '';
    const o = { properties: ['openFile'] };
    if (opts && opts.title) o.title = opts.title;
    if (opts && Array.isArray(opts.filters) && opts.filters.length) o.filters = opts.filters;
    if (cur) o.defaultPath = fs.existsSync(cur) ? cur : path.dirname(cur);
    const r = await dialog.showOpenDialog(win, o);
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  /* ---- 现场（会话快照）：退出时保存、启动时恢复到上次的页面 ---- */
  ipcMain.handle('session:get', () => session.read());
  ipcMain.handle('session:set', (e, patch) => session.write(patch));
  // 退出兜底：渲染层 beforeunload 里用 send 发（不等回包），主进程同步写库
  ipcMain.on('session:set', (e, patch) => session.write(patch));

  /* ---- 引擎安装位置 / 一键启动 ---- */
  ipcMain.handle('engine:info', () => ({ llama: launcher.llamaInfo(), comfyui: launcher.comfyInfo() }));
  ipcMain.handle('engine:setDir', (e, key, dir) => launcher.setDir(key, dir));
  ipcMain.handle('engine:chooseDir', async (e, key) => {
    const win = getWin ? getWin() : null;
    if (!win) return null;
    const cur = key === 'llama' ? launcher.llamaInfo().installDir : launcher.comfyInfo().installDir;
    const opts = { properties: ['openDirectory'] };
    if (cur && fs.existsSync(cur)) opts.defaultPath = cur;
    const r = await dialog.showOpenDialog(win, opts);
    if (r.canceled || !r.filePaths.length) return null;
    return launcher.setDir(key, r.filePaths[0]);
  });
  // 静默启动后没有控制台窗口可关，改由界面「停止」按钮停服务
  ipcMain.handle('engine:stop', async (e, key) => {
    if (key === 'comfyui') return { ok: true, message: 'ComfyUI 请用它自己的窗口退出（软件只按需装卸模型）。' };
    const r = await launcher.stopLlama();
    logger[r.ok ? 'info' : 'warn']('手动停止 llama-server：' + r.message);
    orchestrator.invalidate('llm');
    return r;
  });
  // 后台服务的输出日志（软件目录\logs\llama-server.log / comfyui.log）
  ipcMain.handle('engine:logs', () => launcher.serviceLogs());
  ipcMain.handle('engine:setArgs', (e, s) => launcher.setLlamaArgs(s));
  // 按阶段编排：进哪个阶段就启哪个引擎，用完让出显存（orchestrator.cjs）
  ipcMain.handle('engine:ensure', async (e, phaseIndex) => orchestrator.ensure(Number(phaseIndex) || 0));
  ipcMain.handle('engine:auto', (e, v) => (v === undefined ? orchestrator.auto() : orchestrator.setAuto(!!v)));
  ipcMain.handle('engine:release', async () => orchestrator.shutdownAll('手动释放'));

  /* ---- 模型管家：从别处把模型「拷贝」进模型根目录的正确子目录 ----
     用户只做「选文件」一个动作，分类与落点由主进程决定；拷贝全程推进度给渲染层。 */
  ipcMain.handle('models:slots', () => modelImport.slotsState(models));

  /* ---- ComfyUI 侧体检（只读）：软件扫到的模型目录 vs ComfyUI 真正读取的目录 ----
     2026-10-18：这两份清单从来没有对过账，于是出现
       `unet_name: 'xxx.safetensors' not in []`
     这种「软件看得见、ComfyUI 看不见」的报错。这里把两边并排摆出来。 */
  ipcMain.handle('comfy:diagnose', async () => {
    comfyProbe.forgetCache();     // 用户点「重新检测」时必须是当场的新数据
    try {
      return await comfyProbe.diagnose(launcher.comfyInfo(), { modelsRoot: models.modelsRoot() || '' });
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  });
  // 一键对齐：把 ComfyUI 的 base_path 写成软件正在用的模型根（写前备份，只动这一行）
  ipcMain.handle('comfy:alignModels', () => {
    const r = comfyProbe.alignModelsConfig(launcher.comfyInfo(), models.modelsRoot() || '');
    logger[r.ok ? 'info' : 'warn']('对齐 ComfyUI 模型目录：' + (r.message || '').replace(/\n/g, ' '));
    return r;
  });
  // 安装配套自定义节点（EmptyQwenImage21LatentImage）到 <ComfyUI>/custom_nodes
  ipcMain.handle('comfy:installNodes', () => {
    const info = launcher.comfyInfo();
    const r = comfySetup.ensureCustomNodes(info.installDir);
    logger[r.ok ? 'info' : 'warn']('安装配套节点：' + (r.message || '').replace(/\n/g, ' '));
    comfyProbe.forgetCache();
    return r;
  });
  /* 选好 ComfyUI 目录后就装一次节点（2026-10-18）：把「装节点」从"软件拉起 ComfyUI 时"
     提前到"用户配置路径时"，这样用户自己双击 Comfy Desktop 启动也能命中。
     🔴 失败时必须给出能解决问题的动作（权限 / 占用 / 路径错），不能笼统说"重启软件"。 */
  ipcMain.handle('comfy:provisionNodes', () => {
    const info = launcher.comfyInfo();
    let r;
    try {
      r = comfySetup.ensureCustomNodes(info.installDir);
    } catch (e) {
      r = { ok: false, changed: false, message: (e && e.message) || String(e), list: [] };
    }
    const reason = comfySetup.classifyInstallError(r);
    logger[r.ok ? 'info' : 'warn']('节点置备：' + (r.message || '').replace(/\n/g, ' '));
    comfyProbe.forgetCache();
    return { ...r, reason, installDir: info.installDir };
  });
  // 选源：mode='files' 多选文件；mode='dir' 选一个文件夹（递归扫描里面的模型文件）
  ipcMain.handle('models:importPick', async () => {
    const win = getWin ? getWin() : null;
    if (!win) return [];
    const r = await dialog.showOpenDialog(win, {
      title: '选择装着模型文件的文件夹（会递归扫描）',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths.length) return [];
    return r.filePaths;
  });
  // 扫描 + 分类（不拷贝）：返回 { items, unknown }，unknown 交界面让用户选用途
  ipcMain.handle('models:importScan', (e, paths) => modelImport.plan(paths));
  // 执行拷贝：tasks 已带 sub（目标子目录）；进度走 models:import-progress
  ipcMain.handle('models:importRun', async (e, payload) => {
    const p = payload || {};
    const win = getWin ? getWin() : null;
    const root = p.root || models.modelsRoot() || '';
    const push = (o) => {
      if (win && !win.isDestroyed() && win.webContents) win.webContents.send('models:import-progress', o);
    };
    const tasks = (p.tasks || []).map(t => ({
      src: t.src,
      name: t.name || path.basename(String(t.src || '')),
      sub: t.sub || (modelImport.slot(t.key) ? modelImport.slot(t.key).sub : ''),
      size: t.size
    })).filter(t => t.src && t.sub);
    logger.info(`模型导入开始：${tasks.length} 个文件 → ${root || '(未指定模型目录)'}`);
    const r = await modelImport.run({ root, tasks, onProgress: push });
    if (r.error) logger.warn('模型导入未执行：' + r.message);
    else logger[r.ok ? 'info' : 'warn'](
      `模型导入结束：成功 ${r.copied.length}，跳过 ${r.skipped.length}，冲突 ${r.conflicts.length}，失败 ${r.failed.length}，` +
      `共 ${modelImport.human(r.bytes)}，耗时 ${Math.round((r.elapsedMs || 0) / 1000)}s${r.cancelled ? '（已取消）' : ''}`);
    return r;
  });
  ipcMain.on('models:importCancel', () => { modelImport.cancel(); });

  /* ---- 日志 / 系统监控 ---- */
  // 渲染层推进来的业务日志（"正在生成角色1…/角色1完成，耗时xx"）：带明确的阶段标签
  ipcMain.on('log:ui', (e, tag, msg, level) => {
    try { logger.log(msg, level || 'info', tag || logger.tag()); } catch (_) {}
  });
  ipcMain.handle('log:recent', (e, limit) => logger.recent(Number(limit) || 800));
  ipcMain.handle('log:clear', () => logger.clear());
  ipcMain.handle('log:open', () => {
    const { shell } = require('electron');
    const p = logger.filePath();
    if (!p || !fs.existsSync(p)) return '日志文件还没生成';
    shell.showItemInFolder(p);
    return p;
  });
  ipcMain.handle('metrics:once', () => metrics.once());

  /* ---- 推理网关（带引擎守卫：调用前自动把对应引擎准备到正确状态） ---- */
  ipcMain.handle('infer:health', () => inference.health());
  ipcMain.handle('infer:llm', async (e, messages, opts) => {
    const o = opts || {};
    // 🔴 只有**本地**环节才去确保 / 拉起 llama-server：走云端的环节与本地引擎无关，
    //    以前无条件 ensure，会把「只想用云」的用户强行拖起 10GB 的本地模型。
    if (llmProvider.resolve(o.stage || o.label, o.providerOverride).kind === 'local') {
      await orchestrator.ensureLlm(o.label || logger.tag());
    }
    return inference.llmChat(messages, o);
  });

  /* ---- 大模型来源（本地 / 云端）：设置页是唯一持久入口 ---- */
  ipcMain.handle('llm:config:get', () => llmProvider.getConfig());
  ipcMain.handle('llm:config:set', (e, patch) => llmProvider.setCloud(patch || {}));
  ipcMain.handle('llm:stage:set', (e, id, provider) => llmProvider.setStage(id, provider));
  // 连通性测试：用「设置里当前这份云端配置」直接发一次最小请求，只回通/不通 + 原因
  ipcMain.handle('llm:test', async () => {
    const c = llmProvider.resolveCloud();
    if (!c.apiKey) return { ok: false, message: '还没填 API Key' };
    try {
      const r = await fetch(c.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
        body: JSON.stringify({
          model: c.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
          stream: false
        })
      });
      const txt = await r.text();
      if (!r.ok) return { ok: false, message: 'HTTP ' + r.status + '：' + txt.slice(0, 200) };
      return { ok: true, message: '连接正常（' + c.model + '）' };
    } catch (e) {
      return { ok: false, message: '连接失败：' + ((e && e.message) || e) };
    }
  });
  ipcMain.handle('comfy:generate', async (e, { templateKey, dir, baseName, params, label }) => {
    await orchestrator.ensureComfy(label || (templateKey === 'video' ? '阶段6 H3视频' : '阶段4 角色出图'));
    // 兜底闸门：自动编排被关 / 自动拉起失败时，上面不会报错但 ComfyUI 仍不在线
    // → 生成前再探一次，没起来就给用户明确出路，而不是让请求打到 8188 上连接挂死
    const h = await inference.health();
    if (!h.comfyui) {
      const m = 'ComfyUI 还没有启动。第一次使用请先手动打开 ComfyUI（双击 Comfy Desktop 图标或便携版启动 bat），等它完全启动后再回来重试。';
      logger.error(m);
      throw new Error(m);
    }
    const r = await inference.comfyGenerate({ templateKey, dir, baseName, params });
    return r;
  });
  // 强制停止生成（2026-10-09）：中断 ComfyUI 正在跑的任务 + 清排队 + 释放显存。
  // 必须是独立通道——点「停止生成」时 comfy:generate 那次 invoke 还挂着（要等它返回），
  // 没有这条路就插不进去任何指令。中断是 ComfyUI 全局级的（它没有"只中断某个 prompt"的接口）。
  // mode='skip' = 单镜跳过（只中断当前镜、保留模型不释放显存，下一镜接着跑）；默认 'full' 整批停止。
  ipcMain.handle('comfy:cancel', async (e, mode) => {
    logger.setTag('停止生成');
    return inference.cancelComfy(mode);
  });
  // 成片超分（SeedVR2 · ComfyUI 内置节点）：一条镜头视频 → 放大一档 → 落到 outDir。
  // 与生成同一条前置闸门：先确保 ComfyUI 起来、再探一次在线，缺了给明确出路。
  ipcMain.handle('comfy:upscale', async (e, { file, outDir, scale }) => {
    await orchestrator.ensureComfy('阶段7 超分');
    const h = await inference.health();
    if (!h.comfyui) {
      const m = 'ComfyUI 还没有启动，无法做超分。第一次使用请先手动打开 ComfyUI，等它完全启动后再试。';
      logger.error(m);
      throw new Error(m);
    }
    return inference.upscaleVideo({ file, outDir, scale });
  });
  ipcMain.handle('export:video', async (e, { outDir, outName, videos, subtitles, width, height, autoRes, scope, normalize }) => {
    logger.setTag('阶段7 组装成片');
    await orchestrator.ensure(6);
    // normalize：方案 D 逐镜响度归一（缺省按 true，老渲染层不传也走新行为）
    // autoRes：成片分辨率「自动」= 跟随第一个镜头的实际分辨率（缺省 false 保持老调用方行为）
    return inference.exportVideo(outDir, outName, videos, { subtitles, width, height, autoRes, scope, normalize });
  });
  ipcMain.handle('ffmpeg:find', () => inference.findFfmpeg());
  // 取「上一镜末帧」→ 图片（首帧接力，2026-10-09）：
  // 相邻镜头要画面接得上，唯一可靠的办法是把上一镜真实最后一帧当本镜首帧，
  // 而不是让 H3 各自从零开始猜（逐镜独立生成，接缝靠猜 = 漂移最大来源）。
  ipcMain.handle('video:lastFrame', async (e, { video, out, offset }) => {
    logger.setTag('首帧接力');
    const r = await inference.extractLastFrame(video, out, offset);
    if (r.ok) logger.info('已取上一镜末帧 → ' + path.basename(r.out));
    else if (r.error !== 'NOPATH') logger.warn('取末帧失败：' + r.error);
    return r;
  });
  // 文件签名（是否存在 / 大小 / mtime）：判断「首帧所依据的上一镜视频是否已被重新生成」
  // 上一镜出片后本镜首帧就过期了 —— 这个提示靠它，别指望用户自己记得。
  ipcMain.handle('file:stat', (e, abs) => {
    try {
      const st = fs.statSync(abs);
      return { exists: true, size: st.size, mtime: st.mtimeMs };
    } catch (_) {
      return { exists: false };
    }
  });
  // 组装成片模块：列出某目录全部视频（含生成时间/大小/分辨率，探测结果缓存）
  // prefix：只要文件名以该前缀开头的（扁平化后一个项目共用「成片/」目录，必须按集过滤）
  ipcMain.handle('media:list', async (e, dir, prefix) => {
    const all = await inference.listVideosWithMeta(dir);
    if (!prefix) return all;
    const pre = String(prefix) + '_';
    return (Array.isArray(all) ? all : []).filter(f => f.file.startsWith(pre));
  });
  /* 图片生成页：历史 = <workspace>/图片生成/<日期>/ 下的图片，按时间倒序，上限 120 张 */
  ipcMain.handle('imggen:history', (e, ws) => {
    const root = path.join(String(ws || ''), '图片生成');
    const out = [];
    let days = [];
    try { days = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse(); } catch (_) { return []; }
    for (const day of days) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, day)); } catch (_) { continue; }
      for (const f of files.filter(x => /\.(png|jpe?g|webp)$/i.test(x))) {
        const abs = path.join(root, day, f);
        let st = null; try { st = fs.statSync(abs); } catch (_) { continue; }
        // 旁车文件（<图片名>.json，由生成侧写入）里记着耗时 → 历史图也能显示「生成时长」；
        // 老图没有旁车就是 null，渲染层自然只显示分辨率，不做任何猜测
        let ms = null;
        try { const m = JSON.parse(fs.readFileSync(abs + '.json', 'utf8')); if (m && m.ms) ms = m.ms; } catch (_) {}
        out.push({ file: f, path: abs, mtimeMs: st.mtimeMs, ms });
      }
      if (out.length >= 240) break;
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 120);
  });
  /* 视频生成页：历史 = <workspace>/视频生成/<日期>/ 下的视频，按时间倒序，上限 120 条。
   * 每条带：file / path / mtimeMs / 旁车快照（snapshot，含提示词/参考图/参考视频/首尾帧/档位）
   *         以及用 ffprobe 探测的真实分辨率与时长（宽/高/秒）。
   * 探测失败（无 ffmpeg / 文件损坏）不致命，返回 0，渲染层只显示拿得到的信息。 */
  ipcMain.handle('vidgen:history', async (e, ws) => {
    const root = path.join(String(ws || ''), '视频生成');
    const out = [];
    let days = [];
    try { days = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse(); } catch (_) { return []; }
    for (const day of days) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, day)); } catch (_) { continue; }
      for (const f of files.filter(x => /\.(mp4|webm|mov|mkv)$/i.test(x))) {
        const abs = path.join(root, day, f);
        let st = null; try { st = fs.statSync(abs); } catch (_) { continue; }
        // 旁车文件（<视频名>.json，由生成侧写入）里带生成耗时 + 完整生成快照
        let ms = null, snapshot = null;
        try {
          const m = JSON.parse(fs.readFileSync(abs + '.json', 'utf8'));
          if (m && m.ms) ms = m.ms;
          if (m && m.snapshot) snapshot = m.snapshot;
        } catch (_) {}
        // 真实分辨率/时长（ffprobe 探测；失败 = 0，不阻断）
        let w = 0, h = 0, dur = 0;
        try {
          const meta = await inference.probeVideo(abs);
          if (meta) { w = meta.width || 0; h = meta.height || 0; dur = meta.durationSec || 0; }
        } catch (_) {}
        out.push({ file: f, path: abs, mtimeMs: st.mtimeMs, ms, snapshot, width: w, height: h, durationSec: dur });
      }
      if (out.length >= 240) break;
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 120);
  });
  /* ---- 提示词反推（图片 → 正向提示词）----
   * 默认走本地 Qwen3.5-9B + mmproj（视觉模式 llama-server）。
   * 🔴 独立通道：要读图片文件、且必须先确保 llama 带着视觉投影器启动，
   *    不能复用 infer:llm（那里只保证「文本模式在线」，没有读图能力）。
   * 返回 { text, ms }；失败直接抛错，由渲染层提示，不静默降级。 */
  ipcMain.handle('imggen:reverse', async (e, file, opts) => {
    const o = opts || {};
    const prov = llmProvider.resolve('reverse', o.providerOverride);
    if (prov.kind === 'local') await orchestrator.ensureVisionLlm('提示词反推');
    return inference.reversePrompt(file, o);
  });

  ipcMain.handle('file:readBase64', (e, abs) => {
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs).toString('base64');
  });
  ipcMain.handle('file:delete', (e, abs) => { fs.rmSync(abs, { force: true }); return true; });
  // 选参考素材（图片/视频）：返回绝对路径数组，取消返回空数组
  ipcMain.handle('file:pick', async (e, kind) => {
    const win = getWin ? getWin() : null;
    if (!win) return [];
    const isVideo = kind === 'video';
    const r = await dialog.showOpenDialog(win, {
      title: isVideo ? '选择参考视频' : '选择参考图',
      properties: ['openFile', 'multiSelections'],
      filters: isVideo
        ? [{ name: '视频', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] }]
        : [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    });
    if (r.canceled || !r.filePaths.length) return [];
    return r.filePaths;
  });
  ipcMain.handle('file:openPath', (e, p) => {
    const { shell } = require('electron');
    if (!p || !fs.existsSync(p)) return '路径不存在';
    return shell.openPath(p);
  });
  ipcMain.handle('file:reveal', (e, abs) => {
    const { shell } = require('electron');
    if (fs.existsSync(abs)) shell.showItemInFolder(abs);
    return true;
  });
  // 打开固定外链（白名单，避免渲染进程随便调 openExternal 打开任意 URL）
  ipcMain.handle('app:openUrl', async (e, url) => {
    const u = String(url || '');
    if (!/^https:\/\/(www\.)?comfy\.org(\/|$)/i.test(u) && !/^https:\/\/github\.com\//i.test(u)) {
      return { ok: false, message: '不允许的链接' };
    }
    const { shell } = require('electron');
    await shell.openExternal(u);
    return { ok: true };
  });
}

module.exports = { registerIpc };
