/**
 * 主进程：窗口、IPC、剪贴板、导入导出。
 * 渲染进程不接触文件系统，也不接触明文密钥（除显式「显示」操作）。
 */
'use strict';

const { app, BrowserWindow, ipcMain, clipboard, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { encryptWithPassphrase, decryptWithPassphrase } = require('./crypto');

let win = null;
let store = null;

// 固定应用名：保证开发运行与打包后的 exe 使用同一个数据目录
app.setName('Okey Dokey');

const DATA_DIR = path.join(app.getPath('userData'), 'vault');
const BG_DIR = path.join(app.getPath('userData'), 'background');

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#F6F7FB',
    show: false,
    autoHideMenuBar: true,
    title: 'Okey Dokey',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // 外部链接一律用系统浏览器打开，不在应用内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  store = new Store(DATA_DIR);
  nativeTheme.themeSource = 'light';
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ------------------------------ IPC ------------------------------ */

const ok = (data) => ({ ok: true, data });
const fail = (err) => ({ ok: false, error: String((err && err.message) || err) });

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return ok(await fn(...args)); } catch (err) { return fail(err); }
  });
}

handle('vault:status', () => ({
  total: store.counts().total,
  dataDir: DATA_DIR,
  keyPath: store.keyPath,
  vaultPath: store.vaultPath,
  keyExists: fs.existsSync(store.keyPath)
}));

handle('vault:list', () => store.list());
handle('vault:get', (id) => store.get(id));
handle('vault:create', (payload) => store.create(payload || {}));
handle('vault:update', (id, payload) => store.update(id, payload || {}));
handle('vault:remove', (id) => store.remove(id));

handle('vault:copy', (id) => {
  const value = store.getCredential(id);
  if (!value) throw new Error('NOT_FOUND');
  clipboard.writeText(value);
  store.touch(id);
  // 30 秒后清空剪贴板（若内容仍是该密钥）
  setTimeout(() => {
    if (clipboard.readText() === value) clipboard.clear();
  }, 30000);
  return { copied: true, autoClearSeconds: 30 };
});

handle('vault:reveal', (id) => {
  const value = store.getCredential(id);
  if (value === null) throw new Error('NOT_FOUND');
  store.touch(id);
  return { value };
});

handle('settings:get', () => store.settings);
handle('settings:save', (patch) => store.saveSettings(patch));

/* 背景图：复制进应用数据目录，渲染层通过 IPC 取 data URL */
handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  platform: process.platform,
  dataDir: DATA_DIR,
  packaged: app.isPackaged,
  exePath: app.isPackaged ? process.execPath : ''
}));

handle('app:openExternal', async (url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('BAD_URL');
  await shell.openExternal(url);
  return true;
});

handle('app:showItem', (p) => {
  if (typeof p !== 'string' || !p) throw new Error('BAD_PATH');
  shell.showItemInFolder(p);
  return true;
});

/* 便携版没有安装程序，这里代劳创建快捷方式 */
handle('app:createShortcut', () => {
  if (!app.isPackaged) throw new Error('NOT_PACKAGED');
  const exe = process.execPath;
  const opts = { target: exe, description: 'LLM API key vault', icon: exe, iconIndex: 0 };
  const links = [
    { label: 'desktop', file: path.join(app.getPath('desktop'), 'Okey Dokey.lnk') },
    { label: 'startMenu', file: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Okey Dokey.lnk') }
  ];
  const created = [];
  for (const l of links) {
    try {
      fs.mkdirSync(path.dirname(l.file), { recursive: true });
      if (shell.writeShortcutLink(l.file, 'create', opts)) created.push(l.label);
    } catch (_) { /* 单个失败不影响其他 */ }
  }
  return { created, exe };
});

handle('bg:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择背景图片 / Choose background image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const src = res.filePaths[0];
  fs.mkdirSync(BG_DIR, { recursive: true });
  const ext = path.extname(src).toLowerCase() || '.png';
  const dest = path.join(BG_DIR, 'background' + ext);
  for (const f of fs.readdirSync(BG_DIR)) {
    if (f.startsWith('background')) { try { fs.unlinkSync(path.join(BG_DIR, f)); } catch (_) {} }
  }
  fs.copyFileSync(src, dest);
  store.saveSettings({ background: { image: dest } });
  return { path: dest, dataUrl: toDataUrl(dest) };
});

handle('bg:load', () => {
  const p = (store.settings.background && store.settings.background.image) || '';
  if (!p || !fs.existsSync(p)) return { dataUrl: '' };
  return { dataUrl: toDataUrl(p) };
});

handle('bg:clear', () => {
  store.saveSettings({ background: { image: '' } });
  if (fs.existsSync(BG_DIR)) {
    for (const f of fs.readdirSync(BG_DIR)) { try { fs.unlinkSync(path.join(BG_DIR, f)); } catch (_) {} }
  }
  return true;
});

/* 导出：加密包（口令）或明文 JSON（用户明确选择时） */
handle('vault:export', async (opts) => {
  const o = opts || {};
  const payload = store.dumpRaw();
  const stamp = new Date().toISOString().slice(0, 10);
  const encrypted = o.mode !== 'plain';
  const ext = encrypted ? 'okeyvault' : 'json';
  const res = await dialog.showSaveDialog(win, {
    title: encrypted ? '导出加密备份 / Export encrypted backup' : '导出明文 JSON / Export plaintext JSON',
    defaultPath: path.join(app.getPath('documents'), `okey-dokey-backup-${stamp}.${ext}`),
    filters: encrypted ? [{ name: 'OkeyVault', extensions: ['okeyvault', 'json'] }] : [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  if (encrypted) {
    if (!o.passphrase || String(o.passphrase).length < 6) throw new Error('WEAK_PASSPHRASE');
    const pkg = encryptWithPassphrase(payload, String(o.passphrase), {
      producer: 'okey-dokey-desktop',
      producerVersion: app.getVersion(),
      recordCount: payload.records.length
    });
    fs.writeFileSync(res.filePath, JSON.stringify(pkg, null, 2), 'utf8');
  } else {
    fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
  return { path: res.filePath, count: payload.records.length, encrypted };
});

handle('vault:import', async (opts) => {
  const o = opts || {};
  const res = await dialog.showOpenDialog(win, {
    title: '导入备份 / Import backup',
    properties: ['openFile'],
    filters: [{ name: 'Backup', extensions: ['okeyvault', 'json'] }]
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const raw = fs.readFileSync(res.filePaths[0], 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error('BAD_FILE');
  }
  let payload = parsed;
  if (parsed && parsed.format === 'okey-dokey-export') {
    if (!o.passphrase) throw new Error('PASSPHRASE_REQUIRED');
    payload = decryptWithPassphrase(parsed, String(o.passphrase));
  }
  const counts = store.replaceAll(payload, o.mode === 'replace' ? 'replace' : 'merge');
  return { counts, mode: o.mode === 'replace' ? 'replace' : 'merge' };
});

function toDataUrl(p) {
  try {
    const buf = fs.readFileSync(p);
    const ext = path.extname(p).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' ? 'jpeg' : (ext || 'png');
    return `data:image/${mime};base64,${buf.toString('base64')}`;
  } catch (_) {
    return '';
  }
}
