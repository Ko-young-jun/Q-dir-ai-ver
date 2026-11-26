const { app, BrowserWindow, ipcMain, nativeImage, shell } = require('electron');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const APP_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.QDIR_AI_PORT || 4747);
const URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let serverProc = null;
let dragIcon = null;

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
  const iconPath = path.join(__dirname, 'drag-icon.png');
  if (!dragIcon || dragIcon.isEmpty()) {
    dragIcon = nativeImage.createFromPath(iconPath);
  }
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
