import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_COLOR_FILTERS = [
  { id: 0, pattern: '#Hidden', enabled: true, color: '#8892a4', label: 'Hidden' },
  { id: 1, pattern: '*.zip;*.rar;*.gz;*.7z;*.tar', enabled: true, color: '#00AA00', label: 'Archives' },
  { id: 2, pattern: '*.mp3;*.mp4;*.avi;*.wma;*.mkv;*.wav', enabled: true, color: '#DD0058', label: 'Media' },
  { id: 3, pattern: '#DIR', enabled: true, color: '#008800', label: 'Folders' },
  { id: 4, pattern: '*.jpg;*.jpeg;*.png;*.gif;*.bmp;*.ico;*.webp;*.svg', enabled: true, color: '#BB00BB', label: 'Images' },
  { id: 5, pattern: '*.html;*.htm;*.url;*.css;*.js;*.ts;*.mjs;*.json', enabled: true, color: '#456789', label: 'Web/Code' },
  { id: 6, pattern: '*.pdf;*.doc;*.docx;*.hwp;*.hwpx;*.rtf;*.xls;*.xlsx;*.ppt;*.pptx;*.txt;*.md', enabled: true, color: '#BB8844', label: 'Documents' },
  { id: 7, pattern: '*.cpp;*.hpp;*.h;*.c;*.py;*.rs;*.go', enabled: true, color: '#DD0058', label: 'Source' },
  { id: 8, pattern: '*.exe;*.dll;*.bat;*.cmd;*.ps1;*.msi', enabled: true, color: '#FF0000', label: 'Executables' },
  { id: 9, pattern: '*', enabled: true, color: '#0000BB', label: 'Other Files' }
];

export function getLocalQDirDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Q-Dir');
}

export function parseQDirIniFilters(iniPath = path.join(getLocalQDirDir(), 'Q-Dir.ini')) {
  if (!fs.existsSync(iniPath)) {
    return { source: 'default', iniPath, filters: DEFAULT_COLOR_FILTERS };
  }
  try {
    const raw = fs.readFileSync(iniPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let inFilter2 = false;
    const filters = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(';')) continue;
      if (line.startsWith('[') && line.endsWith(']')) {
        inFilter2 = line.toLowerCase() === '[filter2]';
        continue;
      }
      if (!inFilter2) continue;

      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const id = Number(line.slice(0, eqIdx));
      const parts = line.slice(eqIdx + 1).split('=');
      if (parts.length < 3) continue;

      const pattern = parts[0].trim();
      if (pattern === '#BG' || pattern === '#BG-A') continue;
      const enabled = parts[1] === '1';
      const hex = parts[2].trim();
      const color = /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : null;

      filters.push({
        id: Number.isNaN(id) ? filters.length : id,
        pattern,
        enabled,
        color: color || (pattern === '#Hidden' ? '#8892a4' : '#0000BB'),
        label: pattern
      });
    }

    if (filters.length === 0) {
      return { source: 'default', iniPath, filters: DEFAULT_COLOR_FILTERS };
    }
    return { source: 'local-qdir-ini', iniPath, filters };
  } catch {
    return { source: 'default', iniPath, filters: DEFAULT_COLOR_FILTERS };
  }
}

export function parseStartQdr(qdrPath = path.join(getLocalQDirDir(), 'start.qdr')) {
  if (!fs.existsSync(qdrPath)) {
    return { source: 'default', qdrPath, viewMode: 0, focus: 0, splitters: { sp0: 5000, sp1: 5000, sp2: 5000 } };
  }
  try {
    const raw = fs.readFileSync(qdrPath, 'utf8');
    const kv = {};
    for (const line of raw.split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        if (val.length < 300) kv[key] = val;
      }
    }
    return {
      source: 'local-start-qdr',
      qdrPath,
      version: kv['Q-Dir Version'] || null,
      viewMode: Number(kv['ViewMode'] ?? 0),
      focus: Math.min(3, Math.max(0, Number(kv['Focus'] ?? 0))),
      preview: kv['Vorschau'] === '1',
      splitters: {
        sp0: Number(kv['SP0'] ?? 5000),
        sp1: Number(kv['SP1'] ?? 5000),
        sp2: Number(kv['SP2'] ?? 5000)
      }
    };
  } catch {
    return { source: 'default', qdrPath, viewMode: 0, focus: 0, splitters: { sp0: 5000, sp1: 5000, sp2: 5000 } };
  }
}

export function wildcardMatch(name, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(name);
}

export function matchColorFilter(entry, filters = DEFAULT_COLOR_FILTERS) {
  for (const rule of filters) {
    if (!rule.enabled) continue;
    const pat = rule.pattern;
    if (pat === '#Hidden') {
      if (entry.hidden) return { color: rule.color, rule: pat };
      continue;
    }
    if (pat === '#DIR') {
      if (entry.isDirectory) return { color: rule.color, rule: pat };
      continue;
    }
    if (entry.isDirectory) continue;

    const tokens = pat.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
    for (const token of tokens) {
      if (wildcardMatch(entry.name, token)) {
        return { color: rule.color, rule: pat };
      }
    }
  }
  return { color: entry.isDirectory ? '#008800' : '#0000BB', rule: '*' };
}
