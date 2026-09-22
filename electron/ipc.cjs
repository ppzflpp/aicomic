'use strict';
const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const projects = require('./projects.cjs');
const models = require('./models.cjs');
const inference = require('./inference.cjs');
const launcher = require('./launcher.cjs');
const logger = require('./logger.cjs');
const metrics = require('./metrics.cjs');
const session = require('./session.cjs');
const orchestrator = require('./orchestrator.cjs');
const skills = require('./skills.cjs');
const promptFiles = require('./prompts.cjs');
const { writeUnique } = require('./assetStore.cjs');

/** 注册全部 IPC。getWin 返回主窗口（用于目录选择对话框），测试环境可传 () => null。 */
function registerIpc(db, getWin, fallbackWorkspace) {
  // 日志总线与系统监控都要拿到窗口才能推事件；在这里统一初始化，
  // 冒烟测试（smoke-ui.cjs）只调 registerIpc 也能自动接上。
  logger.init(db, getWin);
  metrics.init(db, getWin);
  session.init(db);
  orchestrator.init(db);
  logger.info('主进程已就绪，IPC 注册完成');
  // 换工作区 = 落库 + 清掉 inference 里缓存的旧工作区
  // （不清的话工作流模板 / tools/ffmpeg.exe 会一直认着旧目录）
  const setWorkspace = (dir) => {
    db.setSetting('workspace', dir);
    inference.forgetWorkspace();
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
  ipcMain.handle('project:create', (e, workspace, name, res) => projects.createProject(db, workspace, name, res));
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

  // 镜头视频 / 成片：项目下各集目录（<项目>/分镜/<集>/、<项目>/成片/<集>/），带分辨率与时长
  const listEpisodeMedia = async (workspace, projectId, kind) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    if (!root) return [];
    const eps = projects.listProjectEpisodes(db, workspace, projectId);
    const out = [];
    for (const ep of eps) {
      const dir = kind === 'film' ? ep.filmDir : ep.shotDir;
      let files = [];
      try { files = await inference.listVideosWithMeta(dir); } catch (_) { files = []; }
      if (files.length) out.push({ episodeId: ep.id, name: ep.name, dir, files });
    }
    return out;
  };
  ipcMain.handle('project:shots', (e, workspace, projectId) => listEpisodeMedia(workspace, projectId, 'shot'));
  ipcMain.handle('project:films', (e, workspace, projectId) => listEpisodeMedia(workspace, projectId, 'film'));

  /* ---- 项目级提示词规范文件（<项目>/prompts/*.md）：五个模块的风格规范，用户可编辑；
          文件缺失 / 还是旧版结构时，主进程自动从内置 skills/prompts/ 补齐或重播 ---- */
  ipcMain.handle('prompt:list', (e, workspace, projectId) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    if (!root) return [];
    promptFiles.seedAt(root);          // 列表顺带播种（老项目打开树即完成升级）
    return promptFiles.listAt(root);
  });
  ipcMain.handle('prompt:read', (e, workspace, projectId, name) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    return root ? promptFiles.readAt(root, name) : '';
  });
  ipcMain.handle('prompt:save', (e, workspace, projectId, name, content) => {
    const root = projects.ensureProjectDirs(db, workspace, projectId);
    return root ? promptFiles.saveAt(root, name, content) : false;
  });

  /* ---- 分辨率配置（项目级 = 新建剧集的初始模板；剧集级 = 本集生效值）---- */
  ipcMain.handle('res:options', () => models.resOptions());
  ipcMain.handle('project:res:get', (e, projectId) => projects.getProjectRes(db, projectId));
  ipcMain.handle('project:res:set', (e, projectId, res) => projects.setProjectRes(db, projectId, res));
  ipcMain.handle('episode:res:get', (e, episodeId) => projects.getEpisodeRes(db, episodeId));
  ipcMain.handle('episode:res:set', (e, episodeId, kind, value) => projects.setEpisodeRes(db, episodeId, kind, value));

  /* ---- 第三方 Skill（提示词扩展）---- */
  ipcMain.handle('skill:list', () => skills.list(db));
  ipcMain.handle('skill:install', async () => {
    const win = getWin ? getWin() : null;
    if (!win) throw new Error('没有可用窗口');
    const r = await dialog.showOpenDialog(win, {
      title: '安装 Skill（选择含 SKILL.md 的文件夹）',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths.length) return null;
    const id = skills.install(r.filePaths[0]);
    logger.info('已安装第三方 skill：' + id);
    return id;
  });
  ipcMain.handle('skill:remove', (e, id) => skills.remove(db, id));
  ipcMain.handle('skill:toggle', (e, id, on) => skills.setEnabled(db, id, on));
  ipcMain.handle('skill:read', (e, id) => skills.readFull(id));

  /* ---- 设置 / 环境检测 ---- */
  ipcMain.handle('models:check', () => models.check());
  ipcMain.handle('models:setPath', (e, key, dir) => models.setPath(key, dir));
  // 生图工作流模板：列表（含激活标记）与切换（切换后返回最新环境检测结果）
  ipcMain.handle('models:imageTemplates', () => models.imageTemplates());
  ipcMain.handle('models:setImageTemplate', (e, key) => {
    if (!models.IMAGE_TEMPLATES[key]) throw new Error('未知生图工作流模板：' + key);
    db.setSetting('imageTemplate', key);
    return models.check();
  });
  // ComfyUI 模型根目录（用户只需设置这一个）
  ipcMain.handle('models:setRoot', (e, dir) => models.setModelsRoot(dir));
  ipcMain.handle('models:detectRoot', () => {
    const r = models.redetect();
    return { detected: r.modelsRoot || '', state: r };
  });
  ipcMain.handle('models:listFiles', (e, key) => models.listFiles(key));
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

  /* ---- 现场（会话快照）：退出时保存、启动时恢复到上次的页面 ---- */
  ipcMain.handle('session:get', () => session.read());
  ipcMain.handle('session:set', (e, patch) => session.write(patch));
  ipcMain.handle('session:clear', () => { session.clear(); return true; });
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
  ipcMain.handle('engine:start', async (e, key) => {
    return key === 'llama' ? launcher.startLlama() : launcher.startComfy();
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
  ipcMain.handle('engine:getArgs', () => launcher.getLlamaArgs());
  ipcMain.handle('engine:setArgs', (e, s) => launcher.setLlamaArgs(s));
  // 按阶段编排：进哪个阶段就启哪个引擎，用完让出显存（orchestrator.cjs）
  ipcMain.handle('engine:ensure', async (e, phaseIndex) => orchestrator.ensure(Number(phaseIndex) || 0));
  ipcMain.handle('engine:auto', (e, v) => (v === undefined ? orchestrator.auto() : orchestrator.setAuto(!!v)));
  ipcMain.handle('engine:release', async () => orchestrator.shutdownAll('手动释放'));

  /* ---- 日志 / 系统监控 ---- */
  // 渲染层推进来的业务日志（"正在生成角色1…/角色1完成，耗时xx"）：带明确的阶段标签
  ipcMain.on('log:ui', (e, tag, msg, level) => {
    try { logger.log(msg, level || 'info', tag || logger.tag()); } catch (_) {}
  });
  ipcMain.handle('log:recent', (e, limit) => logger.recent(Number(limit) || 800));
  ipcMain.handle('log:clear', () => logger.clear());
  ipcMain.handle('log:path', () => logger.filePath());
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
    await orchestrator.ensureLlm((opts && opts.label) || logger.tag());
    return inference.llmChat(messages, opts || {});
  });
  ipcMain.handle('comfy:generate', async (e, { templateKey, dir, baseName, params, label }) => {
    await orchestrator.ensureComfy(label || (templateKey === 'video' ? '阶段6 H3视频' : '阶段4 角色出图'));
    const r = await inference.comfyGenerate({ templateKey, dir, baseName, params });
    return r;
  });
  ipcMain.handle('export:video', async (e, { outDir, outName, videos, subtitles, width, height }) => {
    logger.setTag('阶段7 组装成片');
    await orchestrator.ensure(6);
    return inference.exportVideo(outDir, outName, videos, { subtitles, width, height });
  });
  ipcMain.handle('ffmpeg:find', () => inference.findFfmpeg());
  // 组装成片模块：列出某目录全部视频（含生成时间/大小/分辨率，探测结果缓存）
  ipcMain.handle('media:list', (e, dir) => inference.listVideosWithMeta(dir));
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
}

module.exports = { registerIpc };
