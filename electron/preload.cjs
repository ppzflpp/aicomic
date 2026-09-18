'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),

  getTree: (ws) => ipcRenderer.invoke('tree:get', ws),
  createProject: (ws, name) => ipcRenderer.invoke('project:create', ws, name),
  deleteProject: (ws, id) => ipcRenderer.invoke('project:delete', ws, id),
  addFolder: (ws, projectId, parentId, name) => ipcRenderer.invoke('folder:add', ws, projectId, parentId, name),
  deleteFolder: (ws, id) => ipcRenderer.invoke('folder:delete', ws, id),
  addEpisode: (ws, projectId, folderId, name) => ipcRenderer.invoke('episode:add', ws, projectId, folderId, name),
  deleteEpisode: (ws, id) => ipcRenderer.invoke('episode:delete', ws, id),
  getEpisode: (ws, id) => ipcRenderer.invoke('episode:get', ws, id),
  saveChapter: (ws, id, text) => ipcRenderer.invoke('episode:saveChapter', ws, id, text),
  saveState: (id, done, active, meta) => ipcRenderer.invoke('episode:saveState', id, done, active, meta),
  saveArtifact: (ws, id, kind, data) => ipcRenderer.invoke('episode:saveArtifact', ws, id, kind, data),

  checkModels: () => ipcRenderer.invoke('models:check'),
  setModelPath: (key, dir) => ipcRenderer.invoke('models:setPath', key, dir),
  chooseModelDir: (key) => ipcRenderer.invoke('models:chooseDir', key),
  setModelsRoot: (dir) => ipcRenderer.invoke('models:setRoot', dir),
  detectModelsRoot: () => ipcRenderer.invoke('models:detectRoot'),
  listModelFiles: (key) => ipcRenderer.invoke('models:listFiles', key),
  pickModels: () => ipcRenderer.invoke('models:pick'),
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),

  // 现场（会话快照）：退出保存 / 启动恢复上次的页面
  getSession: () => ipcRenderer.invoke('session:get'),
  saveSession: (patch) => ipcRenderer.invoke('session:set', patch),
  // 退出兜底：beforeunload 里不等回包，主进程同步落库
  saveSessionNow: (patch) => { try { ipcRenderer.send('session:set', patch); } catch (_) {} },
  clearSession: () => ipcRenderer.invoke('session:clear'),

  engineInfo: () => ipcRenderer.invoke('engine:info'),
  setEngineDir: (key, dir) => ipcRenderer.invoke('engine:setDir', key, dir),
  chooseEngineDir: (key) => ipcRenderer.invoke('engine:chooseDir', key),
  startEngine: (key) => ipcRenderer.invoke('engine:start', key),
  stopEngine: (key) => ipcRenderer.invoke('engine:stop', key),
  serviceLogs: () => ipcRenderer.invoke('engine:logs'),
  getLlamaArgs: () => ipcRenderer.invoke('engine:getArgs'),
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
  logPath: () => ipcRenderer.invoke('log:path'),
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
  readFileBase64: (abs) => ipcRenderer.invoke('file:readBase64', abs),
  deleteFile: (abs) => ipcRenderer.invoke('file:delete', abs),
  pickFiles: (kind) => ipcRenderer.invoke('file:pick', kind),
  openPath: (p) => ipcRenderer.invoke('file:openPath', p),
  revealFile: (abs) => ipcRenderer.invoke('file:reveal', abs)
});
