import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

function resolvePythonBin() {
  if (process.env.QDIR_PYTHON && fs.existsSync(process.env.QDIR_PYTHON)) {
    return process.env.QDIR_PYTHON;
  }
  const codexPy = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  if (fs.existsSync(codexPy)) return codexPy;
  return 'python';
}

const PYTHON_EXE = resolvePythonBin();
import {
  DEFAULT_COLOR_FILTERS,
  parseQDirIniFilters,
  parseStartQdr,
  matchColorFilter,
  wildcardMatch
} from './qdir-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '..', 'data');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');

export const LAYOUTS = ['quad', 'dual-h', 'dual-v', 'triple-left', 'triple-top', 'single'];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function listDrives() {
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/' }];
  }
  const drives = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const drivePath = `${letter}:\\`;
    try {
      if (fs.existsSync(drivePath)) {
        drives.push({ name: `${letter}:`, path: drivePath });
      }
    } catch {
      // skip inaccessible drive
    }
  }
  return drives;
}

function defaultPanePaths() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    process.cwd()
  ];
  return candidates.map((p) => (fs.existsSync(p) ? p : home));
}

function makeDefaultPane(id, initialPath) {
  return {
    id,
    activeTab: 0,
    tabs: [
      {
        id: `tab-${id}-0`,
        path: initialPath,
        history: [initialPath],
        historyIndex: 0,
        filter: '',
        sortBy: 'name',
        sortDir: 'asc',
        showHidden: false
      }
    ]
  };
}

export function createInitialState() {
  const paths = defaultPanePaths();
  const ini = parseQDirIniFilters();
  const qdr = parseStartQdr();
  const home = os.homedir();

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: 'init',
    layout: 'quad',
    activePane: qdr.focus ?? 0,
    showPreview: Boolean(qdr.preview),
    previewPath: null,
    theme: 'light',
    colorFilters: ini.filters || DEFAULT_COLOR_FILTERS,
    colorFilterSource: ini.source,
    pinnedForAi: [],
    aiWorkedFiles: [],
    favorites: [
      { name: 'Desktop', path: path.join(home, 'Desktop') },
      { name: 'Downloads', path: path.join(home, 'Downloads') },
      { name: 'Documents', path: path.join(home, 'Documents') },
      { name: 'User Home', path: home }
    ].filter((f) => fs.existsSync(f.path)),
    panes: [0, 1, 2, 3].map((id) => makeDefaultPane(id, paths[id]))
  };
}

export function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const initial = createInitialState();
    saveState(initial, 'init');
    return initial;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.panes || parsed.panes.length !== 4) {
      const initial = createInitialState();
      saveState(initial, 'reset');
      return initial;
    }
    return parsed;
  } catch {
    const initial = createInitialState();
    saveState(initial, 'recover');
    return initial;
  }
}

export function saveState(state, updatedBy = 'system') {
  ensureDataDir();
  state.updatedAt = new Date().toISOString();
  state.updatedBy = updatedBy;
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
  return state;
}

export function normalizeTargetPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('Path is required');
  }
  let p = targetPath.trim();
  if (/^[A-Za-z]:$/.test(p)) {
    p = `${p}\\`;
  }
  return path.resolve(p);
}

export function getActiveTab(state, paneId) {
  const idx = Number(paneId);
  if (Number.isNaN(idx) || idx < 0 || idx > 3) {
    throw new Error(`Invalid pane id: ${paneId} (must be 0..3)`);
  }
  const pane = state.panes[idx];
  const tab = pane.tabs[pane.activeTab] || pane.tabs[0];
  return { pane, tab };
}

export async function listDirectory(targetPath, options = {}) {
  const resolved = normalizeTargetPath(targetPath);
  const {
    filter = '',
    sortBy = 'name',
    sortDir = 'asc',
    showHidden = false,
    colorFilters = DEFAULT_COLOR_FILTERS
  } = options;

  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }

  const dirents = await fsp.readdir(resolved, { withFileTypes: true });
  const entries = [];

  for (const dirent of dirents) {
    const name = dirent.name;
    const isHidden = name.startsWith('.') || name.startsWith('~$');
    if (!showHidden && isHidden) continue;

    if (filter) {
      const hasGlob = filter.includes('*') || filter.includes('?');
      const matched = hasGlob
        ? wildcardMatch(name, filter)
        : name.toLowerCase().includes(filter.toLowerCase());
      if (!matched) continue;
    }

    const fullPath = path.join(resolved, name);
    let size = 0;
    let mtimeMs = 0;
    let isDirectory = dirent.isDirectory();

    try {
      const s = await fsp.stat(fullPath);
      size = s.size;
      mtimeMs = s.mtimeMs;
      isDirectory = s.isDirectory();
    } catch {
      // Keep basic info for locked/system items
    }

    const ext = isDirectory ? '' : path.extname(name).toLowerCase();
    const entry = {
      name,
      path: fullPath,
      isDirectory,
      ext,
      size,
      mtime: mtimeMs ? new Date(mtimeMs).toISOString() : null,
      mtimeMs,
      hidden: isHidden
    };

    const colorMatch = matchColorFilter(entry, colorFilters);
    entry.color = colorMatch.color;
    entry.colorRule = colorMatch.rule;
    entries.push(entry);
  }

  const dirMultiplier = sortDir === 'desc' ? -1 : 1;
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let cmp = 0;
    if (sortBy === 'size') cmp = a.size - b.size;
    else if (sortBy === 'mtime') cmp = a.mtimeMs - b.mtimeMs;
    else if (sortBy === 'ext') cmp = a.ext.localeCompare(b.ext) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    else cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return cmp * dirMultiplier;
  });

  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent !== resolved ? parent : null,
    totalCount: entries.length,
    folderCount: entries.filter((e) => e.isDirectory).length,
    fileCount: entries.filter((e) => !e.isDirectory).length,
    totalBytes: entries.reduce((sum, e) => sum + (e.isDirectory ? 0 : e.size), 0),
    entries
  };
}

export function navigatePane(paneId, targetPath, { newTab = false, updatedBy = 'api' } = {}) {
  const resolved = normalizeTargetPath(targetPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  const state = loadState();
  const { pane, tab } = getActiveTab(state, paneId);

  if (newTab) {
    const created = {
      id: `tab-${paneId}-${Date.now()}`,
      path: resolved,
      history: [resolved],
      historyIndex: 0,
      filter: '',
      sortBy: tab.sortBy,
      sortDir: tab.sortDir,
      showHidden: tab.showHidden
    };
    pane.tabs.push(created);
    pane.activeTab = pane.tabs.length - 1;
  } else {
    if (tab.path !== resolved) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(resolved);
      if (tab.history.length > 50) tab.history.shift();
      tab.historyIndex = tab.history.length - 1;
      tab.path = resolved;
    }
  }
  state.activePane = Number(paneId);
  return saveState(state, updatedBy);
}

export function navigateHistory(paneId, direction, updatedBy = 'api') {
  const state = loadState();
  const { tab } = getActiveTab(state, paneId);
  if (direction === 'back' && tab.historyIndex > 0) {
    tab.historyIndex -= 1;
    tab.path = tab.history[tab.historyIndex];
  } else if (direction === 'forward' && tab.historyIndex < tab.history.length - 1) {
    tab.historyIndex += 1;
    tab.path = tab.history[tab.historyIndex];
  } else if (direction === 'up') {
    const parent = path.dirname(tab.path);
    if (parent && parent !== tab.path) {
      return navigatePane(paneId, parent, { updatedBy });
    }
  }
  return saveState(state, updatedBy);
}

export function updatePaneOptions(paneId, opts = {}, updatedBy = 'api') {
  const state = loadState();
  const { pane, tab } = getActiveTab(state, paneId);
  if (typeof opts.filter === 'string') tab.filter = opts.filter;
  if (['name', 'size', 'mtime', 'ext'].includes(opts.sortBy)) tab.sortBy = opts.sortBy;
  if (['asc', 'desc'].includes(opts.sortDir)) tab.sortDir = opts.sortDir;
  if (typeof opts.showHidden === 'boolean') tab.showHidden = opts.showHidden;
  if (typeof opts.activeTab === 'number' && opts.activeTab >= 0 && opts.activeTab < pane.tabs.length) {
    pane.activeTab = opts.activeTab;
  }
  if (typeof opts.closeTab === 'number' && pane.tabs.length > 1) {
    pane.tabs.splice(opts.closeTab, 1);
    pane.activeTab = Math.min(pane.activeTab, pane.tabs.length - 1);
  }
  return saveState(state, updatedBy);
}

export function setLayoutAndFocus({ layout, activePane, showPreview, previewPath, theme } = {}, updatedBy = 'api') {
  const state = loadState();
  if (layout && LAYOUTS.includes(layout)) state.layout = layout;
  if (typeof activePane === 'number' && activePane >= 0 && activePane <= 3) state.activePane = activePane;
  if (typeof showPreview === 'boolean') state.showPreview = showPreview;
  if (previewPath !== undefined) state.previewPath = previewPath;
  if (theme === 'light' || theme === 'dark') state.theme = theme;
  return saveState(state, updatedBy);
}

function resolveUniqueDest(destDir, baseName, overwrite) {
  let target = path.join(destDir, baseName);
  if (overwrite || !fs.existsSync(target)) return target;
  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(destDir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return target;
}

export async function copyItems(sources, destDir, { overwrite = false } = {}) {
  const resolvedDest = normalizeTargetPath(destDir);
  await fsp.mkdir(resolvedDest, { recursive: true });
  const results = [];

  for (const src of sources) {
    const resolvedSrc = normalizeTargetPath(src);
    const destPath = resolveUniqueDest(resolvedDest, path.basename(resolvedSrc), overwrite);
    await fsp.cp(resolvedSrc, destPath, { recursive: true, force: overwrite });
    results.push({ from: resolvedSrc, to: destPath });
  }
  return { operation: 'copy', destDir: resolvedDest, count: results.length, items: results };
}

export async function moveItems(sources, destDir, { overwrite = false } = {}) {
  const resolvedDest = normalizeTargetPath(destDir);
  await fsp.mkdir(resolvedDest, { recursive: true });
  const results = [];

  for (const src of sources) {
    const resolvedSrc = normalizeTargetPath(src);
    const destPath = resolveUniqueDest(resolvedDest, path.basename(resolvedSrc), overwrite);
    try {
      await fsp.rename(resolvedSrc, destPath);
    } catch (err) {
      if (err.code === 'EXDEV') {
        await fsp.cp(resolvedSrc, destPath, { recursive: true, force: overwrite });
        await fsp.rm(resolvedSrc, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    results.push({ from: resolvedSrc, to: destPath });
  }
  return { operation: 'move', destDir: resolvedDest, count: results.length, items: results };
}

export async function createDirectory(parentDir, name) {
  const resolvedParent = normalizeTargetPath(parentDir);
  const target = path.join(resolvedParent, name);
  await fsp.mkdir(target, { recursive: true });
  return { operation: 'mkdir', path: target };
}

export async function renameItem(targetPath, newName) {
  const resolved = normalizeTargetPath(targetPath);
  if (!newName || /[\\/:*?"<>|]/.test(newName)) {
    throw new Error(`Invalid name: ${newName}`);
  }
  const dest = path.join(path.dirname(resolved), newName);
  await fsp.rename(resolved, dest);
  return { operation: 'rename', from: resolved, to: dest };
}

export async function deleteItems(targets) {
  const deleted = [];
  for (const t of targets) {
    const resolved = normalizeTargetPath(t);
    await fsp.rm(resolved, { recursive: true, force: true });
    deleted.push(resolved);
  }
  return { operation: 'delete', count: deleted.length, deleted };
}

export async function searchFiles(rootDir, query, { maxResults = 200, maxDepth = 6 } = {}) {
  const resolved = normalizeTargetPath(rootDir);
  const results = [];
  const hasGlob = query.includes('*') || query.includes('?');
  const lowerQuery = query.toLowerCase();

  async function walk(dir, depth) {
    if (depth > maxDepth || results.length >= maxResults) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (results.length >= maxResults) break;
      const full = path.join(dir, d.name);
      const matched = hasGlob
        ? wildcardMatch(d.name, query)
        : d.name.toLowerCase().includes(lowerQuery);
      if (matched) {
        let size = 0;
        let mtime = null;
        try {
          const s = await fsp.stat(full);
          size = s.size;
          mtime = new Date(s.mtimeMs).toISOString();
        } catch {
          // ignore
        }
        results.push({ name: d.name, path: full, isDirectory: d.isDirectory(), size, mtime });
      }
      if (d.isDirectory() && d.name !== 'node_modules' && d.name !== '.git') {
        await walk(full, depth + 1);
      }
    }
  }

  await walk(resolved, 0);
  return { rootDir: resolved, query, count: results.length, truncated: results.length >= maxResults, results };
}

export async function previewFile(targetPath, { maxBytes = 65536 } = {}) {
  const resolved = normalizeTargetPath(targetPath);
  const stat = await fsp.stat(resolved);
  if (stat.isDirectory()) {
    return { path: resolved, kind: 'directory', size: 0 };
  }
  const name = path.basename(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const mtime = new Date(stat.mtimeMs).toISOString();

  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg']);
  if (imageExts.has(ext)) {
    return {
      path: resolved,
      name,
      kind: 'image',
      size: stat.size,
      mtime,
      rawUrl: `/api/raw?path=${encodeURIComponent(resolved)}`
    };
  }

  if (ext === '.pdf') {
    return {
      path: resolved,
      name,
      kind: 'pdf',
      size: stat.size,
      mtime,
      rawUrl: `/api/raw?path=${encodeURIComponent(resolved)}`
    };
  }

  const richExts = new Set(['.hwp', '.hwpx', '.xlsx', '.xlsm', '.docx', '.pptx', '.zip']);
  if (richExts.has(ext)) {
    const pyScript = path.join(__dirname, 'doc-preview.py');
    const pyBin = fs.existsSync(PYTHON_EXE) ? PYTHON_EXE : 'python';
    try {
      const { stdout } = await execFileAsync(pyBin, [pyScript, resolved], {
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true
      });
      const parsed = JSON.parse(stdout);
      if (!parsed.error) {
        return { path: resolved, name, size: stat.size, mtime, ...parsed };
      }
      return { path: resolved, name, kind: 'unsupported', size: stat.size, mtime, message: `미리보기 파싱 실패: ${parsed.error}` };
    } catch (err) {
      return { path: resolved, name, kind: 'unsupported', size: stat.size, mtime, message: `미리보기 추출 오류: ${err.message}` };
    }
  }

  const fd = await fsp.open(resolved, 'r');
  try {
    const readSize = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(readSize);
    await fd.read(buf, 0, readSize, 0);
    const isBinary = buf.includes(0);
    if (isBinary) {
      return {
        path: resolved,
        name,
        kind: 'binary',
        ext,
        size: stat.size,
        mtime,
        message: '이 파일 형식은 텍스트 미리보기를 지원하지 않습니다. 상단의 [↗ 열기] 버튼으로 기본 프로그램에서 열어보세요.'
      };
    }
    return {
      path: resolved,
      name,
      kind: 'text',
      size: stat.size,
      truncated: stat.size > maxBytes,
      mtime,
      content: buf.toString('utf8')
    };
  } finally {
    await fd.close();
  }
}

export function openWithDefaultApp(targetPath) {
  const resolved = normalizeTargetPath(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  if (process.platform === 'win32') {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', 'Start-Process -FilePath $env:QDIR_OPEN_TARGET'],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, QDIR_OPEN_TARGET: resolved }
      }
    );
    child.unref();
    return { opened: resolved };
  }
  return { opened: resolved, unsupportedPlatform: process.platform };
}

export async function saveImageDataUrl({ originalPath, dataUrl, fileName, overwrite = false }) {
  const resolvedOrig = normalizeTargetPath(originalPath);
  const dir = path.dirname(resolvedOrig);
  const origExt = path.extname(resolvedOrig) || '.png';
  const origStem = path.basename(resolvedOrig, origExt);

  const match = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!match) {
    throw new Error('Invalid image data URL');
  }
  const fmt = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const buf = Buffer.from(match[2], 'base64');

  const baseName = fileName && fileName.trim()
    ? fileName.trim()
    : `${origStem}_edited.${fmt}`;
  const targetPath = resolveUniqueDest(dir, baseName, overwrite);
  await fsp.writeFile(targetPath, buf);
  return { savedPath: targetPath, bytes: buf.length };
}

export async function saveAiImageRegion({ originalPath, annotatedDataUrl, region, note = '' }) {
  const resolvedOrig = normalizeTargetPath(originalPath);
  const dir = path.dirname(resolvedOrig);
  const origStem = path.basename(resolvedOrig, path.extname(resolvedOrig));
  let annotatedPath = null;

  if (annotatedDataUrl) {
    const match = String(annotatedDataUrl).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
    if (match) {
      const buf = Buffer.from(match[2], 'base64');
      annotatedPath = resolveUniqueDest(dir, `${origStem}_ai_region.png`, true);
      await fsp.writeFile(annotatedPath, buf);
    }
  }

  const regionText = region
    ? `영역(x:${Math.round(region.x)}, y:${Math.round(region.y)}, w:${Math.round(region.w)}, h:${Math.round(region.h)})`
    : '';
  const combinedNote = [regionText, note].filter(Boolean).join(' | ');

  // Pin both original and annotated reference image for AI
  const pins = annotatedPath ? [resolvedOrig, annotatedPath] : [resolvedOrig];
  const state = pinForAi(pins, { note: combinedNote, replace: false, updatedBy: 'ui' });
  return {
    originalPath: resolvedOrig,
    annotatedPath,
    region,
    note: combinedNote,
    state
  };
}

export function removeBackgroundAi(dataUrl) {
  return new Promise((resolve, reject) => {
    const pyScript = path.join(__dirname, 'remove-bg.py');
    const pyBin = fs.existsSync(PYTHON_EXE) ? PYTHON_EXE : 'python';
    const proc = spawn(pyBin, [pyScript], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout.trim() || '{}');
        if (parsed.dataUrl) return resolve(parsed);
        reject(new Error(parsed.error || stderr.trim() || `rembg exited with code ${code}`));
      } catch {
        reject(new Error(stderr.trim() || `rembg failed (code ${code})`));
      }
    });
    proc.stdin.write(JSON.stringify({ dataUrl }));
    proc.stdin.end();
  });
}

export async function getPdfInfo(targetPath) {
  const resolved = normalizeTargetPath(targetPath);
  const pyScript = path.join(__dirname, 'pdf-tools.py');
  const pyBin = fs.existsSync(PYTHON_EXE) ? PYTHON_EXE : 'python';
  const { stdout } = await execFileAsync(pyBin, [pyScript, 'info', resolved], {
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  const parsed = JSON.parse(stdout);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

export function renderPdfPagePng(targetPath, pageIndex = 0, scale = 2.0) {
  const resolved = normalizeTargetPath(targetPath);
  const pyScript = path.join(__dirname, 'pdf-tools.py');
  const pyBin = fs.existsSync(PYTHON_EXE) ? PYTHON_EXE : 'python';
  return new Promise((resolve, reject) => {
    const proc = spawn(pyBin, [pyScript, 'render', resolved, String(pageIndex), String(scale)], { windowsHide: true });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && chunks.length) return resolve(Buffer.concat(chunks));
      reject(new Error(stderr.trim() || `PDF render failed (code ${code})`));
    });
  });
}

export function saveEditedPdf({ originalPath, fileName, overwrite = false, pages = [], extraPdfs = [] }) {
  const resolvedOrig = normalizeTargetPath(originalPath);
  const dir = path.dirname(resolvedOrig);
  const origStem = path.basename(resolvedOrig, path.extname(resolvedOrig));
  const baseName = fileName && fileName.trim() ? fileName.trim() : `${origStem}_edited.pdf`;
  const outputPath = resolveUniqueDest(dir, baseName.toLowerCase().endsWith('.pdf') ? baseName : `${baseName}.pdf`, overwrite);

  return new Promise((resolve, reject) => {
    const pyScript = path.join(__dirname, 'pdf-tools.py');
    const pyBin = fs.existsSync(PYTHON_EXE) ? PYTHON_EXE : 'python';
    const proc = spawn(pyBin, [pyScript, 'save'], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout.trim() || '{}');
        if (parsed.savedPath) return resolve(parsed);
        reject(new Error(parsed.error || stderr.trim() || `pdf-tools exited with code ${code}`));
      } catch {
        reject(new Error(stderr.trim() || `pdf-tools failed (code ${code})`));
      }
    });
    proc.stdin.write(JSON.stringify({ originalPath: resolvedOrig, outputPath, pages, extraPdfs }));
    proc.stdin.end();
  });
}

export async function openOrPreviewZipEntry({ zipPath, entryIndex, action = 'open' }) {
  const resolvedZip = normalizeTargetPath(zipPath);
  const hash = crypto.createHash('md5').update(resolvedZip).digest('hex').slice(0, 10);
  const tempDir = path.join(os.tmpdir(), 'qdir-ai-zip', hash);
  const pyScript = path.join(__dirname, 'doc-preview.py');
  const pyBin = fs.existsSync(PYTHON_EXE) ? PYTHON_EXE : 'python';

  const { stdout } = await execFileAsync(pyBin, [pyScript, '--zip-extract-entry', resolvedZip, String(entryIndex), tempDir], {
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
  const parsed = JSON.parse(stdout);
  if (parsed.error) throw new Error(parsed.error);

  if (action === 'preview') {
    const preview = await previewFile(parsed.extractedPath);
    return { ...preview, fromZip: resolvedZip };
  }
  openWithDefaultApp(parsed.extractedPath);
  return { opened: parsed.extractedPath, name: parsed.name };
}

export async function extractZipAllToSibling(zipPath) {
  const resolvedZip = normalizeTargetPath(zipPath);
  const dir = path.dirname(resolvedZip);
  const stem = path.basename(resolvedZip, path.extname(resolvedZip));
  const outDir = resolveUniqueDest(dir, stem, false);
  const pyScript = path.join(__dirname, 'doc-preview.py');
  const pyBin = fs.existsSync(PYTHON_EXE) ? PYTHON_EXE : 'python';

  const { stdout } = await execFileAsync(pyBin, [pyScript, '--zip-extract-all', resolvedZip, outDir], {
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
  const parsed = JSON.parse(stdout);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

export async function exportListing(targetPath, format = 'csv') {
  const listing = await listDirectory(targetPath, { showHidden: true });
  const fmt = format.toLowerCase();
  if (fmt === 'json') {
    return { format: 'json', mime: 'application/json', content: JSON.stringify(listing, null, 2) };
  }
  if (fmt === 'txt') {
    const lines = [
      `Q-Dir AI Export - ${listing.path}`,
      `Total: ${listing.totalCount} (${listing.folderCount} folders, ${listing.fileCount} files)`,
      '-'.repeat(72),
      ...listing.entries.map((e) => `${e.isDirectory ? '[DIR] ' : '      '}${e.name.padEnd(40)} ${String(e.size).padStart(12)}  ${e.mtime || ''}`)
    ];
    return { format: 'txt', mime: 'text/plain; charset=utf-8', content: lines.join('\n') };
  }
  if (fmt === 'html') {
    const rows = listing.entries
      .map(
        (e) =>
          `<tr><td style="color:${e.color}">${e.isDirectory ? '📁 ' : ''}${e.name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td><td>${e.isDirectory ? 'Folder' : e.ext || 'File'}</td><td align="right">${e.size}</td><td>${e.mtime || ''}</td></tr>`
      )
      .join('\n');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Q-Dir AI Export - ${listing.path}</title><style>body{font-family:Segoe UI,sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#f4f6f8}</style></head><body><h2>${listing.path}</h2><p>Folders: ${listing.folderCount}, Files: ${listing.fileCount}</p><table><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    return { format: 'html', mime: 'text/html; charset=utf-8', content: html };
  }
  // CSV default
  const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csvRows = [
    ['Name', 'Type', 'Extension', 'Size', 'Modified', 'Path'].join(','),
    ...listing.entries.map((e) =>
      [csvEscape(e.name), e.isDirectory ? 'DIR' : 'FILE', csvEscape(e.ext), e.size, csvEscape(e.mtime), csvEscape(e.path)].join(',')
    )
  ];
  return { format: 'csv', mime: 'text/csv; charset=utf-8', content: '\uFEFF' + csvRows.join('\n') };
}

export async function compareDirectories(pathA, pathB) {
  const [listA, listB] = await Promise.all([
    listDirectory(pathA, { showHidden: false }),
    listDirectory(pathB, { showHidden: false })
  ]);
  const mapA = new Map(listA.entries.map((e) => [e.name.toLowerCase(), e]));
  const mapB = new Map(listB.entries.map((e) => [e.name.toLowerCase(), e]));

  const onlyInA = [];
  const onlyInB = [];
  const different = [];
  const identical = [];

  for (const [key, itemA] of mapA) {
    const itemB = mapB.get(key);
    if (!itemB) {
      onlyInA.push(itemA);
    } else if (itemA.isDirectory !== itemB.isDirectory || (!itemA.isDirectory && itemA.size !== itemB.size)) {
      different.push({ name: itemA.name, a: itemA, b: itemB });
    } else {
      identical.push(itemA.name);
    }
  }
  for (const [key, itemB] of mapB) {
    if (!mapA.has(key)) onlyInB.push(itemB);
  }

  return {
    pathA: listA.path,
    pathB: listB.path,
    summary: {
      onlyInA: onlyInA.length,
      onlyInB: onlyInB.length,
      different: different.length,
      identical: identical.length
    },
    onlyInA,
    onlyInB,
    different
  };
}

export async function batchOrganize(targetDir, { mode = 'category', dryRun = true } = {}) {
  const listing = await listDirectory(targetDir, { showHidden: false });
  const categories = {
    Documents: new Set(['.pdf', '.doc', '.docx', '.hwp', '.hwpx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf']),
    Images: new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico']),
    Media: new Set(['.mp3', '.mp4', '.avi', '.mkv', '.wav', '.wma', '.mov', '.flac']),
    Archives: new Set(['.zip', '.rar', '.7z', '.gz', '.tar', '.bz2']),
    Code: new Set(['.js', '.ts', '.mjs', '.py', '.c', '.cpp', '.h', '.hpp', '.html', '.css', '.json', '.xml', '.yaml', '.yml']),
    Executables: new Set(['.exe', '.msi', '.bat', '.cmd', '.ps1', '.dll'])
  };

  const plan = [];
  for (const entry of listing.entries) {
    if (entry.isDirectory) continue;
    let folder = 'Others';
    if (mode === 'extension') {
      folder = entry.ext ? entry.ext.slice(1).toUpperCase() : 'NO_EXT';
    } else if (mode === 'date') {
      folder = entry.mtime ? entry.mtime.slice(0, 7) : 'Unknown_Date';
    } else {
      for (const [cat, exts] of Object.entries(categories)) {
        if (exts.has(entry.ext)) {
          folder = cat;
          break;
        }
      }
    }
    const destDir = path.join(listing.path, folder);
    plan.push({ file: entry.name, from: entry.path, toDir: destDir, folder });
  }

  if (!dryRun) {
    for (const item of plan) {
      await moveItems([item.from], item.toDir, { overwrite: false });
    }
  }

  return {
    targetDir: listing.path,
    mode,
    dryRun,
    plannedCount: plan.length,
    plan
  };
}

export function manageFavorites(action, { name, targetPath } = {}, updatedBy = 'api') {
  const state = loadState();
  if (action === 'add') {
    const resolved = normalizeTargetPath(targetPath);
    const label = name || path.basename(resolved) || resolved;
    state.favorites = state.favorites.filter((f) => f.path.toLowerCase() !== resolved.toLowerCase());
    state.favorites.push({ name: label, path: resolved });
    return saveState(state, updatedBy);
  }
  if (action === 'remove') {
    const resolved = normalizeTargetPath(targetPath);
    state.favorites = state.favorites.filter((f) => f.path.toLowerCase() !== resolved.toLowerCase());
    return saveState(state, updatedBy);
  }
  return state;
}

export function syncFromLocalQDir(updatedBy = 'api') {
  const state = loadState();
  const ini = parseQDirIniFilters();
  const qdr = parseStartQdr();
  state.colorFilters = ini.filters;
  state.colorFilterSource = ini.source;
  state.activePane = qdr.focus ?? state.activePane;
  state.showPreview = Boolean(qdr.preview);
  return {
    state: saveState(state, updatedBy),
    iniSource: ini.source,
    qdrSource: qdr.source,
    qdirVersion: qdr.version || null
  };
}

export function pinForAi(paths = [], { note = '', replace = false, updatedBy = 'ui' } = {}) {
  const state = loadState();
  if (!Array.isArray(state.pinnedForAi)) state.pinnedForAi = [];
  const base = replace ? [] : [...state.pinnedForAi];
  const existing = new Set(base.map((p) => p.path.toLowerCase()));
  const now = new Date().toISOString();

  for (const rawPath of paths) {
    const resolved = normalizeTargetPath(rawPath);
    if (existing.has(resolved.toLowerCase())) continue;
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(resolved).isDirectory();
    } catch {
      // keep false
    }
    base.push({ path: resolved, name: path.basename(resolved) || resolved, isDirectory, note, pinnedAt: now });
    existing.add(resolved.toLowerCase());
  }
  state.pinnedForAi = base.slice(-50);
  return saveState(state, updatedBy);
}

export function unpinForAi(targetPath = null, updatedBy = 'ui') {
  const state = loadState();
  if (!targetPath) {
    state.pinnedForAi = [];
  } else {
    const resolved = normalizeTargetPath(targetPath).toLowerCase();
    state.pinnedForAi = (state.pinnedForAi || []).filter((p) => p.path.toLowerCase() !== resolved);
  }
  return saveState(state, updatedBy);
}

export function recordAiWork(paths = [], { action = 'edited', note = '', navigatePaneId = null, updatedBy = 'mcp' } = {}) {
  const state = loadState();
  if (!Array.isArray(state.aiWorkedFiles)) state.aiWorkedFiles = [];
  const now = new Date().toISOString();
  const list = [...state.aiWorkedFiles];

  let lastDir = null;
  for (const rawPath of paths) {
    const resolved = normalizeTargetPath(rawPath);
    const key = resolved.toLowerCase();
    const idx = list.findIndex((item) => item.path.toLowerCase() === key);
    if (idx !== -1) list.splice(idx, 1);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(resolved).isDirectory();
    } catch {
      // ignore
    }
    list.unshift({
      path: resolved,
      name: path.basename(resolved) || resolved,
      dir: isDirectory ? resolved : path.dirname(resolved),
      isDirectory,
      action,
      note,
      at: now
    });
    lastDir = isDirectory ? resolved : path.dirname(resolved);
  }
  state.aiWorkedFiles = list.slice(0, 30);

  if (navigatePaneId !== null && navigatePaneId !== undefined && lastDir && fs.existsSync(lastDir)) {
    const { tab } = getActiveTab(state, navigatePaneId);
    if (tab.path !== lastDir) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(lastDir);
      if (tab.history.length > 50) tab.history.shift();
      tab.historyIndex = tab.history.length - 1;
      tab.path = lastDir;
    }
    state.activePane = Number(navigatePaneId);
  }

  return saveState(state, updatedBy);
}

export function clearAiWork(updatedBy = 'ui') {
  const state = loadState();
  state.aiWorkedFiles = [];
  return saveState(state, updatedBy);
}

export function revealInExplorer(targetPath) {
  const resolved = normalizeTargetPath(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  if (process.platform === 'win32') {
    const isDir = fs.statSync(resolved).isDirectory();
    const args = isDir ? [resolved] : ['/select,', resolved];
    const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { revealed: resolved, isDirectory: isDir };
  }
  return { revealed: resolved, unsupportedPlatform: process.platform };
}

export async function grepInDirectory(rootDir, pattern, {
  extFilter = '',
  ignoreCase = true,
  maxMatches = 80,
  maxFiles = 400,
  maxFileBytes = 512 * 1024,
  maxDepth = 6
} = {}) {
  const resolved = normalizeTargetPath(rootDir);
  const regex = new RegExp(pattern, ignoreCase ? 'i' : '');
  const exts = extFilter
    ? new Set(extFilter.split(/[;,]/).map((e) => e.trim().toLowerCase().replace(/^\*/, '')).filter(Boolean))
    : null;

  const matches = [];
  let scannedFiles = 0;

  async function walk(dir, depth) {
    if (depth > maxDepth || matches.length >= maxMatches || scannedFiles >= maxFiles) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (matches.length >= maxMatches || scannedFiles >= maxFiles) break;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name === 'node_modules' || d.name === '.git' || d.name === 'dist') continue;
        await walk(full, depth + 1);
      } else {
        const ext = path.extname(d.name).toLowerCase();
        if (exts && !exts.has(ext)) continue;
        try {
          const s = await fsp.stat(full);
          if (s.size > maxFileBytes || s.size === 0) continue;
          const buf = await fsp.readFile(full);
          if (buf.includes(0)) continue; // skip binary
          scannedFiles += 1;
          const lines = buf.toString('utf8').split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({
                file: path.relative(resolved, full) || d.name,
                line: i + 1,
                text: lines[i].trim().slice(0, 140)
              });
              if (matches.length >= maxMatches) break;
            }
          }
        } catch {
          // ignore unreadable files
        }
      }
    }
  }

  await walk(resolved, 0);
  return { rootDir: resolved, pattern, scannedFiles, matchCount: matches.length, truncated: matches.length >= maxMatches, matches };
}

export function formatCompactContext(state) {
  const lines = [`layout=${state.layout} active=P${state.activePane + 1}`];
  state.panes.forEach((p, idx) => {
    const tab = p.tabs[p.activeTab] || p.tabs[0];
    lines.push(`P${idx + 1}${idx === state.activePane ? '*' : ''}: ${tab.path}`);
  });
  const pins = state.pinnedForAi || [];
  if (pins.length) {
    lines.push(`PINNED(${pins.length}):`);
    for (const p of pins) lines.push(`  - ${p.path}${p.note ? ` (${p.note})` : ''}`);
  } else {
    lines.push('PINNED(0)');
  }
  const worked = (state.aiWorkedFiles || []).slice(0, 8);
  if (worked.length) {
    lines.push(`AI_WORKED(${worked.length}):`);
    for (const w of worked) lines.push(`  - [${w.action}] ${w.path}`);
  }
  return lines.join('\n');
}

export function formatCompactListing(listing, limit = 150) {
  const lines = [`DIR: ${listing.path} (${listing.folderCount}d, ${listing.fileCount}f)`];
  const slice = listing.entries.slice(0, limit);
  for (const e of slice) {
    lines.push(e.isDirectory ? `D|${e.name}` : `F|${e.name}|${e.size}`);
  }
  if (listing.entries.length > limit) {
    lines.push(`... +${listing.entries.length - limit} more`);
  }
  return lines.join('\n');
}

