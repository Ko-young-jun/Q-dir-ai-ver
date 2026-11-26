import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import {
  LAYOUTS,
  loadState,
  listDrives,
  listDirectory,
  navigatePane,
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
  recordAiWork,
  revealInExplorer,
  grepInDirectory,
  formatCompactContext,
  formatCompactListing,
  getActiveTab
} from './engine.mjs';
import { wildcardMatch } from './qdir-config.mjs';

const server = new Server(
  { name: 'qdir-ai', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'qdir_get_context',
    description: 'Ultra-low-token context snapshot: returns only the 4 pane paths, user-pinned paths for AI, and recent AI-worked files in ~5-15 lines. Always prefer this over qdir_get_state to save tokens.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'qdir_mark_worked',
    description: 'Highlight file(s) the AI created or edited in the Q-Dir AI Web UI (with AI badge + highlight), optionally navigate a pane to the folder, and optionally reveal the file in Windows Explorer (explorer /select).',
    inputSchema: {
      type: 'object',
      required: ['paths'],
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file or folder paths worked on by AI' },
        action: { type: 'string', enum: ['created', 'edited', 'copied', 'moved', 'analyzed'], default: 'edited' },
        note: { type: 'string', description: 'Short label shown in UI' },
        navigatePane: { type: 'integer', minimum: 0, maximum: 3, description: 'Optional pane (0..3) to navigate to the file folder' },
        revealInExplorer: { type: 'boolean', default: false, description: 'If true, also opens Windows Explorer with the first file selected' }
      }
    }
  },
  {
    name: 'qdir_grep',
    description: 'Low-token local text search inside a pane or directory. Returns only matching relativeFile:line:snippet lines instead of reading whole files.',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pane: { type: 'integer', minimum: 0, maximum: 3 },
        path: { type: 'string' },
        pattern: { type: 'string', description: 'Regex or plain text pattern' },
        extFilter: { type: 'string', description: 'Optional extensions, e.g. .js;.ts;.md;.txt' },
        maxMatches: { type: 'integer', default: 60 }
      }
    }
  },
  {
    name: 'qdir_get_state',
    description: 'Get Q-Dir AI state. Defaults to compact=true (minimal tokens); set compact=false only when full tabs/colorFilters/favorites JSON is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        compact: { type: 'boolean', default: true }
      }
    }
  },
  {
    name: 'qdir_set_layout',
    description: 'Change the Q-Dir AI pane layout (quad, dual-h, dual-v, triple-left, triple-top, single), active pane (0..3), preview toggle, or theme. Changes sync live to the Web UI.',
    inputSchema: {
      type: 'object',
      properties: {
        layout: { type: 'string', enum: LAYOUTS },
        activePane: { type: 'integer', minimum: 0, maximum: 3 },
        showPreview: { type: 'boolean' },
        previewPath: { type: 'string' },
        theme: { type: 'string', enum: ['light', 'dark'] }
      }
    }
  },
  {
    name: 'qdir_navigate',
    description: 'Navigate one of the 4 Q-Dir panes (0=P1, 1=P2, 2=P3, 3=P4) to a directory path, optionally opening a new tab.',
    inputSchema: {
      type: 'object',
      required: ['pane', 'path'],
      properties: {
        pane: { type: 'integer', minimum: 0, maximum: 3 },
        path: { type: 'string' },
        newTab: { type: 'boolean', default: false }
      }
    }
  },
  {
    name: 'qdir_list_pane',
    description: 'List files/folders in a pane (0..3) or explicit path. Defaults to compact=true (D|name / F|name|size) to save tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'integer', minimum: 0, maximum: 3 },
        path: { type: 'string' },
        filter: { type: 'string' },
        sortBy: { type: 'string', enum: ['name', 'size', 'mtime', 'ext'] },
        sortDir: { type: 'string', enum: ['asc', 'desc'] },
        showHidden: { type: 'boolean' },
        compact: { type: 'boolean', default: true },
        limit: { type: 'integer', default: 150 }
      }
    }
  },
  {
    name: 'qdir_copy_between_panes',
    description: 'Copy files/folders from sourcePane to destPane (by names/paths or wildcard pattern) and mark them as AI-worked in the UI.',
    inputSchema: {
      type: 'object',
      required: ['sourcePane', 'destPane'],
      properties: {
        sourcePane: { type: 'integer', minimum: 0, maximum: 3 },
        destPane: { type: 'integer', minimum: 0, maximum: 3 },
        items: { type: 'array', items: { type: 'string' } },
        pattern: { type: 'string' },
        overwrite: { type: 'boolean', default: false }
      }
    }
  },
  {
    name: 'qdir_move_between_panes',
    description: 'Move files/folders from sourcePane to destPane (by names/paths or wildcard pattern) and mark them as AI-worked in the UI.',
    inputSchema: {
      type: 'object',
      required: ['sourcePane', 'destPane'],
      properties: {
        sourcePane: { type: 'integer', minimum: 0, maximum: 3 },
        destPane: { type: 'integer', minimum: 0, maximum: 3 },
        items: { type: 'array', items: { type: 'string' } },
        pattern: { type: 'string' },
        overwrite: { type: 'boolean', default: false }
      }
    }
  },
  {
    name: 'qdir_compare_panes',
    description: 'Compare directories of two panes (or two explicit paths) to find files only in A, only in B, or with different sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        paneA: { type: 'integer', minimum: 0, maximum: 3, default: 0 },
        paneB: { type: 'integer', minimum: 0, maximum: 3, default: 1 },
        pathA: { type: 'string' },
        pathB: { type: 'string' }
      }
    }
  },
  {
    name: 'qdir_batch_organize',
    description: 'Automatically organize files in a pane or directory into subfolders by category, extension, or YYYY-MM date. Defaults to dryRun=true.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'integer', minimum: 0, maximum: 3 },
        path: { type: 'string' },
        mode: { type: 'string', enum: ['category', 'extension', 'date'], default: 'category' },
        dryRun: { type: 'boolean', default: true }
      }
    }
  },
  {
    name: 'qdir_search',
    description: 'Recursively search for files/folders by name or wildcard under a pane or path. Returns compact paths by default.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        pane: { type: 'integer', minimum: 0, maximum: 3 },
        path: { type: 'string' },
        query: { type: 'string' },
        maxResults: { type: 'integer', default: 100 },
        maxDepth: { type: 'integer', default: 6 },
        compact: { type: 'boolean', default: true }
      }
    }
  },
  {
    name: 'qdir_file_ops',
    description: 'Perform file operations: mkdir, rename, or delete. Automatically records created/renamed items as AI-worked in the UI.',
    inputSchema: {
      type: 'object',
      required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['mkdir', 'rename', 'delete'] },
        parentDir: { type: 'string' },
        pane: { type: 'integer', minimum: 0, maximum: 3 },
        name: { type: 'string' },
        path: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  {
    name: 'qdir_preview_file',
    description: 'Preview a file (text, image metadata, or binary hex header) and optionally show it in the Web UI preview panel.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        showInUi: { type: 'boolean', default: true }
      }
    }
  },
  {
    name: 'qdir_export_listing',
    description: 'Export a pane or directory listing in Q-Dir style formats (txt, csv, html, json).',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'integer', minimum: 0, maximum: 3 },
        path: { type: 'string' },
        format: { type: 'string', enum: ['txt', 'csv', 'html', 'json'], default: 'csv' }
      }
    }
  },
  {
    name: 'qdir_manage_favorites',
    description: 'List, add, or remove Q-Dir Quick-Link favorites.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'] },
        name: { type: 'string' },
        path: { type: 'string' }
      }
    }
  },
  {
    name: 'qdir_sync_from_local_qdir',
    description: 'Import color filter rules ([Filter2]) and layout defaults from locally installed Q-Dir (%APPDATA%\\Q-Dir\\Q-Dir.ini and start.qdr).',
    inputSchema: { type: 'object', properties: {} }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

async function resolvePaneSources(sourcePane, items, pattern) {
  const state = loadState();
  const { tab } = getActiveTab(state, sourcePane);
  if (Array.isArray(items) && items.length > 0) {
    return items.map((it) => (path.isAbsolute(it) ? it : path.join(tab.path, it)));
  }
  if (pattern) {
    const listing = await listDirectory(tab.path, { showHidden: false });
    return listing.entries
      .filter((e) => wildcardMatch(e.name, pattern))
      .map((e) => e.path);
  }
  throw new Error('Either items or pattern must be provided');
}

function okText(text) {
  return { content: [{ type: 'text', text }] };
}

function ok(data) {
  return okText(JSON.stringify(data, null, 2));
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case 'qdir_get_context':
        return okText(formatCompactContext(loadState()));

      case 'qdir_mark_worked': {
        const paths = args.paths || [];
        recordAiWork(paths, {
          action: args.action || 'edited',
          note: args.note || '',
          navigatePaneId: args.navigatePane ?? null,
          updatedBy: 'mcp'
        });
        let revealed = null;
        if (args.revealInExplorer && paths.length > 0) {
          revealed = revealInExplorer(paths[0]);
        }
        return okText(`marked=${paths.length} action=${args.action || 'edited'}${revealed ? ` revealed=${revealed.revealed}` : ''}`);
      }

      case 'qdir_grep': {
        const state = loadState();
        const rootDir = args.path || getActiveTab(state, args.pane ?? state.activePane).tab.path;
        const res = await grepInDirectory(rootDir, args.pattern, {
          extFilter: args.extFilter || '',
          maxMatches: args.maxMatches ?? 60
        });
        const lines = [
          `GREP "${res.pattern}" in ${res.rootDir} (scanned ${res.scannedFiles}f, matches ${res.matchCount}${res.truncated ? '+' : ''})`,
          ...res.matches.map((m) => `${m.file}:${m.line}: ${m.text}`)
        ];
        return okText(lines.join('\n'));
      }

      case 'qdir_get_state': {
        const state = loadState();
        if (args.compact !== false) {
          return okText(formatCompactContext(state));
        }
        return ok({ state, drives: listDrives() });
      }

      case 'qdir_set_layout': {
        const state = setLayoutAndFocus(args, 'mcp');
        return okText(`layout=${state.layout} active=P${state.activePane + 1} preview=${state.showPreview} theme=${state.theme}`);
      }

      case 'qdir_navigate': {
        const state = navigatePane(args.pane, args.path, { newTab: Boolean(args.newTab), updatedBy: 'mcp' });
        const { tab } = getActiveTab(state, args.pane);
        return okText(`P${args.pane + 1} -> ${tab.path}`);
      }

      case 'qdir_list_pane': {
        const state = loadState();
        let targetPath = args.path;
        let tabOpts = {};
        if (!targetPath) {
          const { tab } = getActiveTab(state, args.pane ?? state.activePane);
          targetPath = tab.path;
          tabOpts = tab;
        }
        const listing = await listDirectory(targetPath, {
          filter: args.filter ?? tabOpts.filter ?? '',
          sortBy: args.sortBy ?? tabOpts.sortBy ?? 'name',
          sortDir: args.sortDir ?? tabOpts.sortDir ?? 'asc',
          showHidden: args.showHidden ?? tabOpts.showHidden ?? false,
          colorFilters: state.colorFilters
        });
        if (args.compact !== false) {
          return okText(formatCompactListing(listing, args.limit ?? 150));
        }
        return ok(listing);
      }

      case 'qdir_copy_between_panes': {
        const state = loadState();
        const { tab: destTab } = getActiveTab(state, args.destPane);
        const sources = await resolvePaneSources(args.sourcePane, args.items, args.pattern);
        const result = await copyItems(sources, destTab.path, { overwrite: Boolean(args.overwrite) });
        recordAiWork(result.items.map((i) => i.to), { action: 'copied', updatedBy: 'mcp' });
        return okText(`copied ${result.count} -> ${result.destDir}\n` + result.items.map((i) => `  + ${path.basename(i.to)}`).join('\n'));
      }

      case 'qdir_move_between_panes': {
        const state = loadState();
        const { tab: destTab } = getActiveTab(state, args.destPane);
        const sources = await resolvePaneSources(args.sourcePane, args.items, args.pattern);
        const result = await moveItems(sources, destTab.path, { overwrite: Boolean(args.overwrite) });
        recordAiWork(result.items.map((i) => i.to), { action: 'moved', updatedBy: 'mcp' });
        return okText(`moved ${result.count} -> ${result.destDir}\n` + result.items.map((i) => `  -> ${path.basename(i.to)}`).join('\n'));
      }

      case 'qdir_compare_panes': {
        const state = loadState();
        const pathA = args.pathA || getActiveTab(state, args.paneA ?? 0).tab.path;
        const pathB = args.pathB || getActiveTab(state, args.paneB ?? 1).tab.path;
        const diff = await compareDirectories(pathA, pathB);
        const lines = [
          `COMPARE A=${diff.pathA} vs B=${diff.pathB}`,
          `summary: onlyA=${diff.summary.onlyInA} onlyB=${diff.summary.onlyInB} diff=${diff.summary.different} same=${diff.summary.identical}`,
          diff.onlyInA.length ? `onlyA: ${diff.onlyInA.slice(0, 40).map((e) => e.name).join(', ')}` : '',
          diff.onlyInB.length ? `onlyB: ${diff.onlyInB.slice(0, 40).map((e) => e.name).join(', ')}` : '',
          diff.different.length ? `diff: ${diff.different.slice(0, 40).map((d) => `${d.name}(${d.a.size}v${d.b.size})`).join(', ')}` : ''
        ].filter(Boolean);
        return okText(lines.join('\n'));
      }

      case 'qdir_batch_organize': {
        const state = loadState();
        const targetDir = args.path || getActiveTab(state, args.pane ?? state.activePane).tab.path;
        const result = await batchOrganize(targetDir, { mode: args.mode || 'category', dryRun: args.dryRun !== false });
        if (!result.dryRun && result.plan.length) {
          recordAiWork(result.plan.map((p) => path.join(p.toDir, p.file)), { action: 'moved', note: `organize:${result.mode}`, updatedBy: 'mcp' });
        }
        return ok(result);
      }

      case 'qdir_search': {
        const state = loadState();
        const rootDir = args.path || getActiveTab(state, args.pane ?? state.activePane).tab.path;
        const res = await searchFiles(rootDir, args.query, { maxResults: args.maxResults ?? 100, maxDepth: args.maxDepth ?? 6 });
        if (args.compact !== false) {
          const lines = [
            `SEARCH "${res.query}" in ${res.rootDir} (${res.count}${res.truncated ? '+' : ''})`,
            ...res.results.map((r) => `${r.isDirectory ? 'D' : 'F'}|${path.relative(res.rootDir, r.path)}`)
          ];
          return okText(lines.join('\n'));
        }
        return ok(res);
      }

      case 'qdir_file_ops': {
        const state = loadState();
        if (args.operation === 'mkdir') {
          const parentDir = args.parentDir || getActiveTab(state, args.pane ?? state.activePane).tab.path;
          const res = await createDirectory(parentDir, args.name);
          recordAiWork([res.path], { action: 'created', updatedBy: 'mcp' });
          return okText(`mkdir: ${res.path}`);
        }
        if (args.operation === 'rename') {
          const res = await renameItem(args.path, args.name);
          recordAiWork([res.to], { action: 'edited', updatedBy: 'mcp' });
          return okText(`rename: ${res.from} -> ${res.to}`);
        }
        if (args.operation === 'delete') {
          const res = await deleteItems(args.paths || []);
          return okText(`deleted: ${res.count}`);
        }
        throw new Error(`Unknown operation: ${args.operation}`);
      }

      case 'qdir_preview_file': {
        const preview = await previewFile(args.path);
        if (args.showInUi !== false) {
          setLayoutAndFocus({ showPreview: true, previewPath: preview.path }, 'mcp');
        }
        return ok(preview);
      }

      case 'qdir_export_listing': {
        const state = loadState();
        const targetPath = args.path || getActiveTab(state, args.pane ?? state.activePane).tab.path;
        return ok(await exportListing(targetPath, args.format || 'csv'));
      }

      case 'qdir_manage_favorites': {
        if (args.action === 'list') {
          return ok({ favorites: loadState().favorites });
        }
        return ok(manageFavorites(args.action, { name: args.name, targetPath: args.path }, 'mcp'));
      }

      case 'qdir_sync_from_local_qdir':
        return ok(syncFromLocalQDir('mcp'));

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }]
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
