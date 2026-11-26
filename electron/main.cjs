const { app, BrowserWindow, ipcMain, nativeImage, shell } = require('electron');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const APP_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.QDIR_AI_PORT || 4747);
const URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let serverProc = null;

// 24x24 crisp blue document icon for native OS drag preview
const DRAG_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <rect x="4" y="2" width="24" height="28" rx="4" fill="#2563eb"/>
  <path d="M10 11h12M10 16h12M10 21h8" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;
const dragIcon = nativeImage.createFromDataURL(
  'data:image/svg+xml;base64,' + Buffer.from(DRAG_ICON_SVG).toString('base64')
);

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/drives`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(600, () => { req.destroy(); resolve(false); });
  });
}

async function ensureServerRunning() {
  if (await checkServer()) return;
  const nodeBin = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : 'node';
  const serverScript = path.join(APP_DIR, 'src', 'server.mjs');
  serverProc = spawn(nodeBin, [serverScript], {
    cwd: APP_DIR,
    stdio: 'ignore',
    windowsHide: true
  });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await checkServer()) return;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    title: 'Q-Dir AI — Quad File Explorer',
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadURL(URL);

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.on('ondragstart', (event, filePaths) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return;
  const valid = filePaths.filter((p) => typeof p === 'string' && p.length > 0);
  if (!valid.length) return;
  event.sender.startDrag({
    file: valid[0],
    files: valid,
    icon: dragIcon
  });
});

app.whenReady().then(async () => {
  await ensureServerRunning();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill(); } catch {}
  }
  if (process.platform !== 'darwin') app.quit();
});
