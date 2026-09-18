'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1500, height: 940, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const lines = [];
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) lines.push('CONSOLE ' + msg); });
  await win.loadFile(path.join(__dirname, '../dist/index.html'));
  await new Promise(r => setTimeout(r, 1500));
  // 建项目并打开集数
  await win.webContents.executeJavaScript(`window.__pinia._s.get('project').createProject('诊断')`);
  await new Promise(r => setTimeout(r, 1200));
  await win.webContents.executeJavaScript(`window.__pinia._s.get('project').openEpisode(window.__pinia._s.get('project').tree[0].episodes[0].id)`);
  await new Promise(r => setTimeout(r, 1000));
  await win.webContents.executeJavaScript(`
    const ta = document.querySelector('.stage-body textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, '测试'.repeat(30));
    ta.dispatchEvent(new Event('input', {bubbles:true}));
    ta.dispatchEvent(new Event('change', {bubbles:true}));
    'set'
  `);
  await new Promise(r => setTimeout(r, 500));
  const clicked = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.stage')][0]?.querySelector('button')?.click(); 'clicked'
  `);
  await new Promise(r => setTimeout(r, 1000));
  lines.push('confirm1: ' + clicked);
  const c2 = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('生成改编稿'))?.click(); 'gen-clicked'
  `);
  lines.push('gen: ' + c2);
  for (let t = 1; t <= 6; t++) {
    await new Promise(r => setTimeout(r, 1000));
    const st = await win.webContents.executeJavaScript(`JSON.stringify({
      err: window.__pinia._s.get('project').error,
      toast: document.querySelector('.toast') ? document.querySelector('.toast').textContent : null,
      busy: !!document.querySelector('.bar')
    })`).catch(e => 'EXEC-ERR ' + e.message);
    lines.push('t' + t + 's: ' + st);
  }
  fs.writeFileSync(path.join(__dirname, '..', 'diag-out.txt'), lines.join('\n'), 'utf-8');
  app.exit(0);
});
