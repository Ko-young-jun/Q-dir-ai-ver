import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATE_FILE,
  loadState,
  listDrives,
  listDirectory,
  navigatePane,
  navigateHistory,
  updatePaneOptions,
  setLayoutAndFocus,
  copyItems,
  moveItems,
  createDirectory,
  renameItem,
  deleteItems,
  searchFiles,
  previewFile,
  exportListing,
  compareDirectories,
  batchOrganize,
  manageFavorites,
  syncFromLocalQDir,
  pinForAi,
  unpinForAi,
  recordAiWork,
  clearAiWork,
  revealInExplorer,
  openWithDefaultApp,
  saveImageDataUrl,
  saveAiImageRegion,
  removeBackgroundAi,
  getPdfInfo,
  renderPdfPagePng,
  saveEditedPdf,
  openOrPreviewZipEntry,
  extractZipAllToSibling,
  copyPathsToOsClipboard,
  convertFilesToMarkdown,
  getActiveTab,
  normalizeTargetPath
} from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const PORT = Number(process.env.QDIR_AI_PORT || 4747);
const HOST = process.env.QDIR_AI_HOST || '127.0.0.1';

const sseClients = new Set();

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Watch state.json so changes made by the MCP server immediately update connected Web UIs
loadState();
let watchDebounce = null;
try {
  fs.watch(path.dirname(STATE_FILE), (eventType, filename) => {
    if (filename === path.basename(STATE_FILE)) {
      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        try {
          const state = loadState();
          broadcast('state', state);
        } catch {
          // ignore mid-write race
        }
      }, 60);
    }
  });
} catch {
  // ignore watch setup errors
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(`event: state\ndata: ${JSON.stringify(loadState())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, { state: loadState(), drives: listDrives() });
    }

    if (req.method === 'GET' && pathname === '/api/drives') {
      return sendJson(res, 200, { drives: listDrives() });
    }

    if (req.method === 'GET' && pathname === '/api/list') {
      const targetPath = url.searchParams.get('path');
      const filter = url.searchParams.get('filter') || '';
      const sortBy = url.searchParams.get('sortBy') || 'name';
      const sortDir = url.searchParams.get('sortDir') || 'asc';
      const showHidden = url.searchParams.get('showHidden') === 'true';
      const state = loadState();
      const listing = await listDirectory(targetPath, {
        filter,
        sortBy,
        sortDir,
        showHidden,
        colorFilters: state.colorFilters
      });
      return sendJson(res, 200, listing);
    }

    if (req.method === 'POST' && pathname === '/api/layout') {
      const body = await readJsonBody(req);
      const state = setLayoutAndFocus(body, 'ui');
      broadcast('state', state);
      return sendJson(res, 200, { state });
    }

    const paneMatch = pathname.match(/^\/api\/pane\/([0-3])\/(navigate|history|options)$/);
    if (req.method === 'POST' && paneMatch) {
      const paneId = Number(paneMatch[1]);
      const action = paneMatch[2];
      const body = await readJsonBody(req);
      let state;
      if (action === 'navigate') {
        state = navigatePane(paneId, body.path, { newTab: Boolean(body.newTab), updatedBy: 'ui' });
      } else if (action === 'history') {
        state = navigateHistory(paneId, body.direction, 'ui');
      } else {
        state = updatePaneOptions(paneId, body, 'ui');
      }
      broadcast('state', state);
      return sendJson(res, 200, { state });
    }

    if (req.method === 'POST' && pathname === '/api/fs/copy') {
      const body = await readJsonBody(req);
      const result = await copyItems(body.sources || [], body.destDir, { overwrite: Boolean(body.overwrite) });
      broadcast('fs_change', { operation: 'copy', destDir: result.destDir });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/fs/move') {
      const body = await readJsonBody(req);
      const result = await moveItems(body.sources || [], body.destDir, { overwrite: Boolean(body.overwrite) });
      broadcast('fs_change', { operation: 'move', destDir: result.destDir });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/fs/mkdir') {
      const body = await readJsonBody(req);
      const result = await createDirectory(body.parentDir, body.name);
      broadcast('fs_change', { operation: 'mkdir', path: result.path });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/fs/rename') {
      const body = await readJsonBody(req);
      const result = await renameItem(body.path, body.newName);
      broadcast('fs_change', { operation: 'rename', from: result.from, to: result.to });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/fs/delete') {
      const body = await readJsonBody(req);
      const result = await deleteItems(body.paths || []);
      broadcast('fs_change', { operation: 'delete', count: result.count });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/fs/clipboard-copy') {
      const body = await readJsonBody(req);
      const result = await copyPathsToOsClipboard(body.paths || []);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/search') {
      const rootDir = url.searchParams.get('path');
      const q = url.searchParams.get('q') || '';
      const result = await searchFiles(rootDir, q);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/preview') {
      const targetPath = url.searchParams.get('path');
      const result = await previewFile(targetPath);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/raw') {
      const targetPath = normalizeTargetPath(url.searchParams.get('path'));
      if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(targetPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(targetPath).pipe(res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/export') {
      const targetPath = url.searchParams.get('path');
      const format = url.searchParams.get('format') || 'csv';
      const exported = await exportListing(targetPath, format);
      res.writeHead(200, {
        'Content-Type': exported.mime,
        'Content-Disposition': `attachment; filename="qdir-export.${exported.format}"`
      });
      res.end(exported.content);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/compare') {
      const paneA = Number(url.searchParams.get('paneA') ?? 0);
      const paneB = Number(url.searchParams.get('paneB') ?? 1);
      const state = loadState();
      const { tab: tabA } = getActiveTab(state, paneA);
      const { tab: tabB } = getActiveTab(state, paneB);
      const diff = await compareDirectories(tabA.path, tabB.path);
      return sendJson(res, 200, diff);
    }

    if (req.method === 'POST' && pathname === '/api/organize') {
      const body = await readJsonBody(req);
      const result = await batchOrganize(body.path, { mode: body.mode || 'category', dryRun: body.dryRun !== false });
      if (!result.dryRun) broadcast('fs_change', { operation: 'organize', targetDir: result.targetDir });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/favorites') {
      const body = await readJsonBody(req);
      const state = manageFavorites(body.action, { name: body.name, targetPath: body.path }, 'ui');
      broadcast('state', state);
      return sendJson(res, 200, { state });
    }

    if (req.method === 'POST' && pathname === '/api/sync-qdir') {
      const synced = syncFromLocalQDir('ui');
      broadcast('state', synced.state);
      return sendJson(res, 200, synced);
    }

    if (req.method === 'POST' && pathname === '/api/ai/pin') {
      const body = await readJsonBody(req);
      const state = pinForAi(body.paths || [], {
        note: body.note || '',
        replace: Boolean(body.replace),
        updatedBy: 'ui'
      });
      broadcast('state', state);
      return sendJson(res, 200, { state });
    }

    if (req.method === 'POST' && pathname === '/api/ai/unpin') {
      const body = await readJsonBody(req);
      const state = unpinForAi(body.path || null, 'ui');
      broadcast('state', state);
      return sendJson(res, 200, { state });
    }

    if (req.method === 'POST' && pathname === '/api/ai/worked') {
      const body = await readJsonBody(req);
      const state = recordAiWork(body.paths || [], {
        action: body.action || 'edited',
        note: body.note || '',
        navigatePaneId: body.navigatePane ?? null,
        updatedBy: body.updatedBy || 'api'
      });
      broadcast('state', state);
      return sendJson(res, 200, { state });
    }

    if (req.method === 'POST' && pathname === '/api/ai/clear-worked') {
      const state = clearAiWork('ui');
      broadcast('state', state);
      return sendJson(res, 200, { state });
    }

    if (req.method === 'POST' && pathname === '/api/reveal') {
      const body = await readJsonBody(req);
      const result = revealInExplorer(body.path);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/open') {
      const body = await readJsonBody(req);
      const result = openWithDefaultApp(body.path);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/image/save') {
      const body = await readJsonBody(req);
      const result = await saveImageDataUrl(body);
      broadcast('fs_change', { operation: 'image_save', path: result.savedPath });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/image/ai-region') {
      const body = await readJsonBody(req);
      const result = await saveAiImageRegion(body);
      broadcast('state', result.state);
      broadcast('fs_change', { operation: 'ai_region', path: result.annotatedPath });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/image/remove-bg') {
      const body = await readJsonBody(req);
      const result = await removeBackgroundAi(body.dataUrl);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/pdf/info') {
      const targetPath = url.searchParams.get('path');
      const result = await getPdfInfo(targetPath);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/pdf/render') {
      const targetPath = url.searchParams.get('path');
      const page = Number(url.searchParams.get('page') ?? 0);
      const scale = Number(url.searchParams.get('scale') ?? 2.0);
      const png = await renderPdfPagePng(targetPath, page, scale);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(png);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pdf/save') {
      const body = await readJsonBody(req);
      const result = await saveEditedPdf(body);
      broadcast('fs_change', { operation: 'pdf_save', path: result.savedPath });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/zip/entry') {
      const body = await readJsonBody(req);
      const result = await openOrPreviewZipEntry(body);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/zip/extract-all') {
      const body = await readJsonBody(req);
      const result = await extractZipAllToSibling(body.zipPath);
      broadcast('fs_change', { operation: 'zip_extract', destDir: result.destDir });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/convert/markdown') {
      const body = await readJsonBody(req);
      const result = await convertFilesToMarkdown(body.paths || [], { overwrite: Boolean(body.overwrite) });
      if (result.convertedCount > 0) {
        broadcast('fs_change', { operation: 'convert_md', count: result.convertedCount });
      }
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Q-Dir AI Web UI & API running at http://${HOST}:${PORT}`);
});
