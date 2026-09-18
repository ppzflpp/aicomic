'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

const db = require('./db.cjs');
const models = require('./models.cjs');
const inference = require('./inference.cjs');
const launcher = require('./launcher.cjs');
const logger = require('./logger.cjs');
const metrics = require('./metrics.cjs');
const session = require('./session.cjs');
const { registerIpc } = require('./ipc.cjs');

const isDev = !!process.env.VITE_DEV;

// 无独显/远程/虚拟机环境兜底：禁用 GPU 合成，走软件渲染
if (process.env.COMIC_STUDIO_NO_GPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

let win = null;
/** 窗口几何的立即保存函数（退出路径兜底用，由 session.trackWindow 返回） */
let saveWinState = null;

// Windows 上用无边框 + 深色原生窗口控件，让标题栏与暗黑主题融为一体
const darkChrome = process.platform === 'win32'
  ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0a0d13', symbolColor: '#9aa6b8', height: 40 } }
  : {};

function createWindow() {
  // 窗口按上次退出时的位置/大小还原（越界或换屏后由 session.windowState() 自动回落）
  const ws = session.windowState();
  win = new BrowserWindow({
    width: ws.width,
    height: ws.height,
    ...(Number.isFinite(ws.x) ? { x: ws.x, y: ws.y } : {}),
    minWidth: session.DEF.minWidth,
    minHeight: session.DEF.minHeight,
    backgroundColor: '#0a0d13',
    ...darkChrome,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (ws.maximized) win.maximize();
  // 移动/缩放/最大化/关闭时把几何写回现场
  saveWinState = session.trackWindow(win);
  const ses = session.read();
  if (ses.savedAt) {
    logger.detail('载入上次现场（保存于 ' + ses.savedAt + '）' +
      (Number.isFinite(ses.episodeId) ? '，上次打开的集数 #' + ses.episodeId : ''));
  }
  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  db.init(app.getPath('userData'), app.getPath('documents'));
  models.init(db);
  inference.init(db);
  launcher.init(db);
  inference.ensureDefaultTemplates();
  registerIpc(db, () => win);

  createWindow();
  logger.info('飞鱼AI漫剧已启动（工作区 ' + db.getSetting('workspace') + '）');
  metrics.start(1500);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/**
 * 退出前收尾：llama-server 现在是**静默启动**（没有控制台窗口可以让用户手动关），
 * 若软件退出后它还常驻，就会白白占着约 10.6GB 显存。
 * 因此编排开启时（= 引擎生命周期交给软件管）随软件一起停掉；
 * 想让它常驻，可在设置页关掉「按阶段自动启停引擎」。
 */
app.on('before-quit', () => {
  try {
    // 先把现场（窗口几何）补一刀，退出后下次启动就能回到同样的位置
    if (saveWinState) saveWinState();
    const ses = session.read();
    logger.info('软件退出：现场已保存' + (ses.view ? '（' + (ses.view === 'settings' ? '设置页' : '工作区') + '）' : ''));
  } catch (_) { /* 退出路径不要阻塞 */ }
  try {
    if (db.getSetting('engine.autoOrchestrate') !== '0') {
      // 退出路径用同步版：进程马上要没了，必须保证 taskkill 真的跑完（这里卡一下无妨）
      const r = launcher.stopLlamaSync();
      if (!r.already) logger.info('软件退出：' + r.message);
    }
  } catch (_) { /* 退出路径不要阻塞 */ }
});
