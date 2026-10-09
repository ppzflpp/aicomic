'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),

  getTree: (ws) => ipcRenderer.invoke('tree:get', ws),
  createProject: (ws, name, res) => ipcRenderer.invoke('project:create', ws, name, res),
  deleteProject: (ws, id) => ipcRenderer.invoke('project:delete', ws, id),
  addFolder: (ws, projectId, parentId, name) => ipcRenderer.invoke('folder:add', ws, projectId, parentId, name),
  deleteFolder: (ws, id) => ipcRenderer.invoke('folder:delete', ws, id),
  addEpisode: (ws, projectId, folderId, name) => ipcRenderer.invoke('episode:add', ws, projectId, folderId, name),
  deleteEpisode: (ws, id) => ipcRenderer.invoke('episode:delete', ws, id),
  getEpisode: (ws, id) => ipcRenderer.invoke('episode:get', ws, id),
  saveChapter: (ws, id, text) => ipcRenderer.invoke('episode:saveChapter', ws, id, text),
  saveState: (id, done, active, meta) => ipcRenderer.invoke('episode:saveState', id, done, active, meta),
  saveArtifact: (ws, id, kind, data) => ipcRenderer.invoke('episode:saveArtifact', ws, id, kind, data),

  // 项目媒体（左侧树懒加载）：角色图/场景图、各集镜头视频、各集成片、各集剧本工件
  projectAssets: (ws, projectId) => ipcRenderer.invoke('project:assets', ws, projectId),
  projectShots: (ws, projectId) => ipcRenderer.invoke('project:shots', ws, projectId),
  projectFilms: (ws, projectId) => ipcRenderer.invoke('project:films', ws, projectId),
  projectScripts: (ws, projectId) => ipcRenderer.invoke('project:scripts', ws, projectId),

  // 项目角色场景库（跨集共享的角色/场景条目）：命中即只读加载，本集新增可「保存到项目」
  libraryList: (ws, projectId) => ipcRenderer.invoke('library:list', ws, projectId),
  librarySave: (ws, projectId, payload) => ipcRenderer.invoke('library:save', ws, projectId, payload),
  libraryAdd: (ws, projectId, kind, name) => ipcRenderer.invoke('library:add', ws, projectId, kind, name),
  libraryRename: (ws, projectId, id, newName) => ipcRenderer.invoke('library:rename', ws, projectId, id, newName),
  libraryUsage: (ws, projectId, id) => ipcRenderer.invoke('library:usage', ws, projectId, id),
  libraryRemove: (ws, projectId, id, opts) => ipcRenderer.invoke('library:remove', ws, projectId, id, opts),
  libraryUsageAll: (ws, projectId) => ipcRenderer.invoke('library:usageAll', ws, projectId),
  librarySwap: (ws, projectId, episodeId, kind, oldName, newName, newId) =>
    ipcRenderer.invoke('library:swap', ws, projectId, episodeId, kind, oldName, newName, newId),
  // 素材目录复制（只增不删）：本集私有图 ↔ 库条目目录，入库 / 按库更新时同步
  copyDir: (from, to) => ipcRenderer.invoke('assets:copyDir', from, to),
  // 从本地选一张图导入该卡素材目录（复制 + 按卡名唯一命名），返回实际文件名
  importImage: (dir, baseName, src) => ipcRenderer.invoke('assets:importImage', dir, baseName, src),
  // 归档「重新生成分镜后不再出现的角色/场景」的图（移到 _trash/<时间戳>/，不删）
  archiveOrphans: (ws, episodeId, items) => ipcRenderer.invoke('assets:archiveOrphans', ws, episodeId, items),

  // 项目级提示词文件（<项目>/prompts/*.md）：四个模块的提示词，可编辑；缺失自动补内置版
  promptsList: (ws, projectId) => ipcRenderer.invoke('prompt:list', ws, projectId),
  readPrompt: (ws, projectId, name) => ipcRenderer.invoke('prompt:read', ws, projectId, name),
  savePrompt: (ws, projectId, name, content) => ipcRenderer.invoke('prompt:save', ws, projectId, name, content),
  promptReset: (ws, projectId, name) => ipcRenderer.invoke('prompt:reset', ws, projectId, name),
  // 成品覆写（<项目>/prompts/final/<用途>.md）：整段替换该用途下发的提示词，删掉即恢复合成
  promptFinalList: (ws, projectId) => ipcRenderer.invoke('prompt:finalList', ws, projectId),
  promptFinalRead: (ws, projectId, taskId) => ipcRenderer.invoke('prompt:finalRead', ws, projectId, taskId),
  promptFinalSave: (ws, projectId, taskId, content) => ipcRenderer.invoke('prompt:finalSave', ws, projectId, taskId, content),
  promptFinalClear: (ws, projectId, taskId) => ipcRenderer.invoke('prompt:finalClear', ws, projectId, taskId),

  // 分辨率配置：项目级（新建剧集的初始模板）/ 剧集级（本集生效）+ 按模型过滤的档位
  resOptions: () => ipcRenderer.invoke('res:options'),
  // 视频档位清单（[速度优先/平衡/质量优先]，只给档位名与说明，不含任何模型信息）
  resTiers: () => ipcRenderer.invoke('res:tiers'),
  getProjectRes: (projectId) => ipcRenderer.invoke('project:res:get', projectId),
  setProjectRes: (projectId, res) => ipcRenderer.invoke('project:res:set', projectId, res),
  setEpisodeRes: (episodeId, kind, value) => ipcRenderer.invoke('episode:res:set', episodeId, kind, value),

  checkModels: () => ipcRenderer.invoke('models:check'),
  // 模型方案（profile）：换生图 / 生视频模型只改配置，UI 从下拉里选
  profileList: (kind) => ipcRenderer.invoke('profiles:list', kind),
  profileSet: (kind, id) => ipcRenderer.invoke('profiles:set', kind, id),
  profileReload: () => ipcRenderer.invoke('profiles:reload'),
  profilePromptExtras: (ws, pid) => ipcRenderer.invoke('profiles:promptExtras', ws, pid),
  // 模型专属规范（electron/profiles/prompts/*.md）：项目覆盖落在 <项目>/prompts/model/，删掉即恢复内置
  profilePromptList: (ws, pid) => ipcRenderer.invoke('profiles:promptList', ws, pid),
  profilePromptRead: (name, ws, pid) => ipcRenderer.invoke('profiles:promptRead', name, ws, pid),
  profilePromptSave: (name, content, ws, pid) => ipcRenderer.invoke('profiles:promptSave', name, content, ws, pid),
  profilePromptClear: (name, ws, pid) => ipcRenderer.invoke('profiles:promptClear', name, ws, pid),
  // 风格体系（四轴：画面风格 / 世界设定 / 内容体裁 / 制作调性）：规范正文里的 {{S.x}} 由渲染层用 vars 在内存里替换
  // 🔴 覆盖已下沉到项目：带 pid 才能读到该项目的词表覆盖；不带（新建弹窗、设置页）= 纯用内置
  styleList: (ws, pid) => ipcRenderer.invoke('styles:list', ws, pid),
  styleAxes: (ws, pid) => ipcRenderer.invoke('styles:axes', ws, pid),
  styleErrors: (ws, pid) => ipcRenderer.invoke('styles:errors', ws, pid),
  styleGet: (id, ws, pid) => ipcRenderer.invoke('styles:get', id, ws, pid),
  // 风格文件（electron/styles/ 的结构）：清单 / 读 / 写（落项目覆盖）/ 恢复内置
  styleFiles: (ws, pid) => ipcRenderer.invoke('styles:files', ws, pid),
  styleFileRead: (rel, ws, pid) => ipcRenderer.invoke('styles:fileRead', rel, ws, pid),
  styleFileSave: (rel, content, ws, pid) => ipcRenderer.invoke('styles:fileSave', rel, content, ws, pid),
  styleFileClear: (rel, ws, pid) => ipcRenderer.invoke('styles:fileClear', rel, ws, pid),
  chooseModelDir: (key) => ipcRenderer.invoke('models:chooseDir', key),
  setModelsRoot: (dir) => ipcRenderer.invoke('models:setRoot', dir),
  detectModelsRoot: () => ipcRenderer.invoke('models:detectRoot'),
  pickModels: () => ipcRenderer.invoke('models:pick'),

  // 模型管家：把模型从别处拷贝进模型根目录的正确子目录（自动分类 + 进度条）
  modelSlots: () => ipcRenderer.invoke('models:slots'),
  modelImportPick: () => ipcRenderer.invoke('models:importPick'),
  modelImportScan: (paths) => ipcRenderer.invoke('models:importScan', paths),
  modelImportRun: (payload) => ipcRenderer.invoke('models:importRun', payload),
  modelImportCancel: () => { try { ipcRenderer.send('models:importCancel'); } catch (_) {} },
  onModelImportProgress: (cb) => {
    const h = (_e, o) => cb(o);
    ipcRenderer.on('models:import-progress', h);
    return () => ipcRenderer.removeListener('models:import-progress', h);
  },
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  pickFile: (key, opts) => ipcRenderer.invoke('settings:pickFile', key, opts),

  // 现场（会话快照）：退出保存 / 启动恢复上次的页面
  getSession: () => ipcRenderer.invoke('session:get'),
  saveSession: (patch) => ipcRenderer.invoke('session:set', patch),
  // 退出兜底：beforeunload 里不等回包，主进程同步落库
  saveSessionNow: (patch) => { try { ipcRenderer.send('session:set', patch); } catch (_) {} },

  engineInfo: () => ipcRenderer.invoke('engine:info'),
  setEngineDir: (key, dir) => ipcRenderer.invoke('engine:setDir', key, dir),
  chooseEngineDir: (key) => ipcRenderer.invoke('engine:chooseDir', key),
  stopEngine: (key) => ipcRenderer.invoke('engine:stop', key),
  serviceLogs: () => ipcRenderer.invoke('engine:logs'),
  setLlamaArgs: (s) => ipcRenderer.invoke('engine:setArgs', s),
  // 阶段编排：进哪个阶段就启哪个引擎（phaseIndex 0-6 对应界面第 1-7 块）
  ensureEngine: (phaseIndex) => ipcRenderer.invoke('engine:ensure', phaseIndex),
  getAutoOrchestrate: () => ipcRenderer.invoke('engine:auto'),
  setAutoOrchestrate: (v) => ipcRenderer.invoke('engine:auto', v),
  releaseEngines: () => ipcRenderer.invoke('engine:release'),

  // 日志总线
  // 渲染层业务日志：每个动作开始/完成/失败都推一条，带耗时（fire-and-forget）
  logUi: (tag, msg, level) => { try { ipcRenderer.send('log:ui', tag, msg, level); } catch (_) {} },
  logRecent: (limit) => ipcRenderer.invoke('log:recent', limit),
  logClear: () => ipcRenderer.invoke('log:clear'),
  logOpenFile: () => ipcRenderer.invoke('log:open'),
  onLog: (cb) => {
    const h = (_e, entry) => cb(entry);
    ipcRenderer.on('log:line', h);
    return () => ipcRenderer.removeListener('log:line', h);
  },

  // 系统监控
  metricsOnce: () => ipcRenderer.invoke('metrics:once'),
  onMetrics: (cb) => {
    const h = (_e, snap) => cb(snap);
    ipcRenderer.on('metrics:tick', h);
    return () => ipcRenderer.removeListener('metrics:tick', h);
  },

  inferHealth: () => ipcRenderer.invoke('infer:health'),
  llmChat: (messages, opts) => ipcRenderer.invoke('infer:llm', messages, opts),
  comfyGenerate: (args) => ipcRenderer.invoke('comfy:generate', args),
  exportVideo: (args) => ipcRenderer.invoke('export:video', args),
  findFfmpeg: () => ipcRenderer.invoke('ffmpeg:find'),
  listMedia: (dir, prefix) => ipcRenderer.invoke('media:list', dir, prefix),
  readFileBase64: (abs) => ipcRenderer.invoke('file:readBase64', abs),
  deleteFile: (abs) => ipcRenderer.invoke('file:delete', abs),
  pickFiles: (kind) => ipcRenderer.invoke('file:pick', kind),
  openPath: (p) => ipcRenderer.invoke('file:openPath', p),
  revealFile: (abs) => ipcRenderer.invoke('file:reveal', abs)
});
