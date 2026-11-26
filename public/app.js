let appState = null;
let drives = [];
const paneListings = [null, null, null, null];
const paneSelections = [new Set(), new Set(), new Set(), new Set()];
const paneLastClicked = [null, null, null, null];
let fsClipboard = null; // { mode: 'copy' | 'cut', paths: [] }

function loadColWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem('qdir_ai_col_widths') || 'null');
    if (Array.isArray(saved) && saved.length === 4) return saved;
  } catch {}
  return [
    { name: 320, size: 78, mtime: 122 },
    { name: 320, size: 78, mtime: 122 },
    { name: 320, size: 78, mtime: 122 },
    { name: 320, size: 78, mtime: 122 }
  ];
}
const paneColWidths = loadColWidths();
const EXT_PRESETS = [
  { label: '전체', value: '' },
  { label: '한글 (HWP)', value: '*.hwp;*.hwpx' },
  { label: 'PDF', value: '*.pdf' },
  { label: '엑셀', value: '*.xlsx;*.xls;*.xlsm;*.csv' },
  { label: '워드/PPT', value: '*.docx;*.doc;*.pptx;*.ppt' },
  { label: '이미지', value: '*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp' },
  { label: '압축', value: '*.zip;*.rar;*.7z;*.gz' },
  { label: '텍스트/코드', value: '*.txt;*.md;*.json;*.js;*.py;*.html' }
];
const paneComposing = [false, false, false, false];
function saveColWidths() {
  try { localStorage.setItem('qdir_ai_col_widths', JSON.stringify(paneColWidths)); } catch {}
}

const panesContainer = document.getElementById('panesContainer');
const previewPanel = document.getElementById('previewPanel');
const previewTitle = document.getElementById('previewTitle');
const previewMeta = document.getElementById('previewMeta');
const previewBody = document.getElementById('previewBody');
const favoritesSelect = document.getElementById('favoritesSelect');
const syncBadge = document.getElementById('syncBadge');
const statusText = document.getElementById('statusText');
const mcpStatusText = document.getElementById('mcpStatusText');
const compareModal = document.getElementById('compareModal');
const compareBody = document.getElementById('compareBody');
const pinnedChips = document.getElementById('pinnedChips');
const workedChips = document.getElementById('workedChips');

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setStatus(msg) {
  statusText.textContent = msg;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return '';
  return iso.slice(0, 16).replace('T', ' ');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function activeTabOf(paneId) {
  const p = appState.panes[paneId];
  return p.tabs[p.activeTab] || p.tabs[0];
}

function renderTopbar() {
  document.body.classList.toggle('dark', appState.theme === 'dark');
  panesContainer.className = `panes layout-${appState.layout}`;

  document.querySelectorAll('[data-layout]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layout === appState.layout);
  });

  favoritesSelect.innerHTML = '<option value="">★ 즐겨찾기 이동...</option>' +
    appState.favorites
      .map((f) => `<option value="${escapeHtml(f.path)}">★ ${escapeHtml(f.name)} (${escapeHtml(f.path)})</option>`)
      .join('');

  previewPanel.classList.toggle('hidden', !appState.showPreview);
  mcpStatusText.textContent = `마지막 업데이트: ${appState.updatedBy || 'init'} (${formatDate(appState.updatedAt)})`;
  renderAiBar();
}

function renderAiBar() {
  const pins = appState.pinnedForAi || [];
  if (!pins.length) {
    pinnedChips.innerHTML = '<span class="ai-empty">항목 선택 후 [📌 AI전달] 클릭 → 채팅에서 "핀한 파일"로 바로 지시</span>';
  } else {
    pinnedChips.innerHTML = pins
      .map(
        (p) => `<span class="ai-chip pin" data-pin-jump="${escapeHtml(p.isDirectory ? p.path : p.path.replace(/[\\/][^\\/]+$/, ''))}" title="${escapeHtml(p.path)}">
          📌 ${escapeHtml(p.name)}
          <button data-unpin="${escapeHtml(p.path)}" title="핀 해제">×</button>
        </span>`
      )
      .join('');
    pinnedChips.querySelectorAll('[data-unpin]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        api('/api/ai/unpin', { method: 'POST', body: JSON.stringify({ path: btn.dataset.unpin }) }).catch(() => {});
      });
    });
    pinnedChips.querySelectorAll('[data-pin-jump]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const dir = chip.dataset.pinJump;
        if (dir) {
          api(`/api/pane/${appState.activePane}/navigate`, { method: 'POST', body: JSON.stringify({ path: dir }) }).catch(() => {});
        }
      });
    });
  }

  const worked = appState.aiWorkedFiles || [];
  if (!worked.length) {
    workedChips.innerHTML = '<span class="ai-empty">AI가 생성·수정한 파일이 여기에 표시됩니다</span>';
  } else {
    workedChips.innerHTML = worked
      .slice(0, 10)
      .map(
        (w) => `<span class="ai-chip worked" data-worked-dir="${escapeHtml(w.dir)}" data-worked-path="${escapeHtml(w.path)}" title="[${escapeHtml(w.action)}] ${escapeHtml(w.path)}${w.note ? ' — ' + escapeHtml(w.note) : ''}">
          🤖 ${escapeHtml(w.name)}
          <button data-reveal="${escapeHtml(w.path)}" title="Windows 탐색기에서 열기">📂</button>
        </span>`
      )
      .join('');
    workedChips.querySelectorAll('[data-reveal]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        api('/api/reveal', { method: 'POST', body: JSON.stringify({ path: btn.dataset.reveal }) })
          .then(() => setStatus(`Windows 탐색기에서 열림: ${btn.dataset.reveal}`))
          .catch((err) => setStatus(err.message));
      });
    });
    workedChips.querySelectorAll('[data-worked-dir]').forEach((chip) => {
      chip.addEventListener('click', () => {
        api(`/api/pane/${appState.activePane}/navigate`, {
          method: 'POST',
          body: JSON.stringify({ path: chip.dataset.workedDir })
        }).catch(() => {});
      });
    });
  }
}

async function loadPaneListing(paneId) {
  const tab = activeTabOf(paneId);
  const qs = new URLSearchParams({
    path: tab.path,
    filter: tab.filter || '',
    sortBy: tab.sortBy || 'name',
    sortDir: tab.sortDir || 'asc',
    showHidden: String(Boolean(tab.showHidden))
  });
  try {
    paneListings[paneId] = await api(`/api/list?${qs}`);
  } catch (err) {
    paneListings[paneId] = { path: tab.path, error: err.message, entries: [] };
  }
  renderPane(paneId);
}

async function refreshAllPanes() {
  await Promise.all([0, 1, 2, 3].map((id) => loadPaneListing(id)));
}

function ensurePaneElements() {
  if (panesContainer.children.length === 4) return;
  panesContainer.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const el = document.createElement('div');
    el.className = 'pane';
    el.dataset.pane = String(i);
    el.addEventListener('mousedown', () => {
      if (appState && appState.activePane !== i) {
        api('/api/layout', { method: 'POST', body: JSON.stringify({ activePane: i }) }).catch(() => {});
      }
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const raw = e.dataTransfer.getData('application/json');
      if (!raw) return;
      const { sourcePane, paths } = JSON.parse(raw);
      if (sourcePane === i || !paths?.length) return;
      const destDir = activeTabOf(i).path;
      const isMove = e.shiftKey;
      try {
        await api(isMove ? '/api/fs/move' : '/api/fs/copy', {
          method: 'POST',
          body: JSON.stringify({ sources: paths, destDir })
        });
        setStatus(`${paths.length}개 항목을 패널 ${i + 1}로 ${isMove ? '이동' : '복사'}했습니다.`);
        await refreshAllPanes();
      } catch (err) {
        setStatus(`오류: ${err.message}`);
      }
    });
    panesContainer.appendChild(el);
  }
}

function updatePaneSelectionUI(paneId) {
  const el = panesContainer.children[paneId];
  if (!el) return;
  const selected = paneSelections[paneId];
  el.querySelectorAll('tbody tr[data-path]').forEach((tr) => {
    tr.classList.toggle('selected', selected.has(tr.dataset.path));
  });
  const listing = paneListings[paneId];
  const summary = listing && !listing.error
    ? `폴더 ${listing.folderCount} · 파일 ${listing.fileCount} (${formatBytes(listing.totalBytes)})`
    : '';
  const summarySpan = el.querySelector('.pane-footer > span');
  if (summarySpan) {
    summarySpan.textContent = `${summary}${selected.size ? ` · 선택 ${selected.size}` : ''}`;
  }
  const pinBtn = el.querySelector('[data-act="pin-ai"]');
  if (pinBtn) {
    pinBtn.textContent = `📌 AI전달${selected.size ? ` (${selected.size})` : ''}`;
  }
}

function renderPane(paneId) {
  ensurePaneElements();
  const el = panesContainer.children[paneId];
  const prevWrap = el.querySelector('.pane-list-wrap');
  const prevScrollTop = prevWrap ? prevWrap.scrollTop : 0;
  const prevScrollLeft = prevWrap ? prevWrap.scrollLeft : 0;
  const prevFilterEl = el.querySelector('.filter-input');
  const wasFilterFocused = Boolean(prevFilterEl && document.activeElement === prevFilterEl);
  const prevSelStart = wasFilterFocused ? prevFilterEl.selectionStart : null;
  const prevSelEnd = wasFilterFocused ? prevFilterEl.selectionEnd : null;
  const pane = appState.panes[paneId];
  const tab = activeTabOf(paneId);
  const listing = paneListings[paneId];
  const selected = paneSelections[paneId];

  el.classList.toggle('active', appState.activePane === paneId);

  const tabsHtml = pane.tabs
    .map((t, idx) => {
      const label = t.path.split(/[\\/]/).filter(Boolean).pop() || t.path;
      return `<div class="pane-tab ${idx === pane.activeTab ? 'active' : ''}" data-tab-idx="${idx}">
        <span class="tab-title" title="${escapeHtml(t.path)}">${escapeHtml(label)}</span>
        ${pane.tabs.length > 1 ? `<button class="tab-close" data-close-tab="${idx}">×</button>` : ''}
      </div>`;
    })
    .join('') + `<button class="drive-btn" data-new-tab="1" title="새 탭">+</button>`;

  const drivesHtml = drives
    .map((d) => `<button class="drive-btn" data-drive="${escapeHtml(d.path)}">${escapeHtml(d.name)}</button>`)
    .join('');

  let rowsHtml = '';
  if (!listing) {
    rowsHtml = `<tr><td colspan="4">불러오는 중...</td></tr>`;
  } else if (listing.error) {
    rowsHtml = `<tr><td colspan="4" style="color:var(--danger)">${escapeHtml(listing.error)}</td></tr>`;
  } else {
    if (listing.parent) {
      rowsHtml += `<tr data-parent="${escapeHtml(listing.parent)}">
        <td class="col-name"><div class="file-name-cell">⬆️ ..</div></td>
        <td class="col-size"></td>
        <td class="col-date"></td>
        <td class="col-filler"></td>
      </tr>`;
    }
    const pinnedSet = new Set((appState.pinnedForAi || []).map((p) => p.path.toLowerCase()));
    const workedMap = new Map((appState.aiWorkedFiles || []).map((w) => [w.path.toLowerCase(), w]));

    for (const entry of listing.entries) {
      const isSel = selected.has(entry.path);
      const lowerPath = entry.path.toLowerCase();
      const isPinned = pinnedSet.has(lowerPath);
      const workedInfo = workedMap.get(lowerPath);
      const icon = entry.isDirectory ? '📁' : '📄';
      const badges =
        (workedInfo ? `<span class="row-badge worked" title="${escapeHtml(workedInfo.note || workedInfo.action)}">🤖 ${escapeHtml(workedInfo.action)}</span>` : '') +
        (isPinned ? `<span class="row-badge pin">📌 AI</span>` : '');
      const rowCls = [isSel ? 'selected' : '', workedInfo ? 'ai-worked-row' : '', isPinned ? 'ai-pinned-row' : ''].filter(Boolean).join(' ');
      rowsHtml += `<tr draggable="true" class="${rowCls}" data-path="${escapeHtml(entry.path)}" data-dir="${entry.isDirectory ? '1' : '0'}">
        <td class="col-name" title="${escapeHtml(entry.name)}"><div class="file-name-cell" style="color:${escapeHtml(entry.color)}">${badges}<span class="file-icon">${icon}</span><span class="file-name-text">${escapeHtml(entry.name)}</span></div></td>
        <td class="col-size">${entry.isDirectory ? '&lt;DIR&gt;' : formatBytes(entry.size)}</td>
        <td class="col-date">${formatDate(entry.mtime)}</td>
        <td class="col-filler"></td>
      </tr>`;
    }
    if (!listing.entries.length) {
      rowsHtml += `<tr><td colspan="4" style="color:var(--muted)">표시할 항목이 없습니다.</td></tr>`;
    }
  }

  const summary = listing && !listing.error
    ? `폴더 ${listing.folderCount} · 파일 ${listing.fileCount} (${formatBytes(listing.totalBytes)})`
    : '';

  const cw = paneColWidths[paneId] || { name: 320, size: 78, mtime: 122 };
  const totalMinW = (cw.name || 320) + (cw.size || 78) + (cw.mtime || 122);
  const curFilter = tab.filter || '';
  const presetMatched = EXT_PRESETS.some((p) => p.value === curFilter);
  const extOptionsHtml = EXT_PRESETS
    .map((p) => `<option value="${escapeHtml(p.value)}" ${curFilter === p.value ? 'selected' : ''}>${escapeHtml(p.label)}</option>`)
    .join('') + (!presetMatched && curFilter ? `<option value="${escapeHtml(curFilter)}" selected>직접입력</option>` : '');

  el.innerHTML = `
    <div class="pane-tabs">${tabsHtml}</div>
    <div class="pane-nav">
      <span class="pane-id">P${paneId + 1}</span>
      <button class="drive-btn" data-hist="back" title="뒤로">◀</button>
      <button class="drive-btn" data-hist="forward" title="앞으로">▶</button>
      <button class="drive-btn" data-hist="up" title="상위 폴더">▲</button>
      <div class="drive-bar">${drivesHtml}</div>
      <input class="path-input" value="${escapeHtml(tab.path)}" title="경로 입력 후 Enter" />
      <select class="ext-filter-select" title="확장자 빠른 필터">${extOptionsHtml}</select>
      <input class="filter-input" value="${escapeHtml(curFilter)}" placeholder="검색/필터" title="파일명 검색 또는 *.pdf;*.hwp 입력" />
      <button class="drive-btn" data-refresh="1" title="새로고침">↻</button>
    </div>
    <div class="pane-list-wrap">
      <table class="file-table" style="min-width:${totalMinW}px">
        <colgroup>
          <col data-col="name" style="width:${cw.name}px" />
          <col data-col="size" style="width:${cw.size}px" />
          <col data-col="mtime" style="width:${cw.mtime}px" />
          <col class="col-filler" />
        </colgroup>
        <thead>
          <tr>
            <th class="col-name" data-sort="name">이름 ${tab.sortBy === 'name' ? (tab.sortDir === 'asc' ? '▲' : '▼') : ''}<span class="col-resizer" data-resize-col="name" title="드래그: 너비 조절 · 더블클릭: 자동 맞춤"></span></th>
            <th class="col-size" data-sort="size">크기 ${tab.sortBy === 'size' ? (tab.sortDir === 'asc' ? '▲' : '▼') : ''}<span class="col-resizer" data-resize-col="size" title="드래그: 너비 조절"></span></th>
            <th class="col-date" data-sort="mtime">수정일 ${tab.sortBy === 'mtime' ? (tab.sortDir === 'asc' ? '▲' : '▼') : ''}<span class="col-resizer" data-resize-col="mtime" title="드래그: 너비 조절"></span></th>
            <th class="col-filler"></th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="pane-footer">
      <span>${summary}${selected.size ? ` · 선택 ${selected.size}` : ''}</span>
      <div class="pane-actions">
        <button class="pin-btn" data-act="pin-ai" title="선택 항목(또는 현재 폴더)을 AI에 전달 & 경로 복사">📌 AI전달${selected.size ? ` (${selected.size})` : ''}</button>
        <button data-act="to-md" title="선택한 문서(HWP/PDF/DOCX/XLSX/PPTX)를 마크다운(.md)으로 변환">📝MD</button>
        <button data-act="reveal" title="Windows 탐색기에서 열기">📂</button>
        <button data-act="mkdir" title="새 폴더">+폴더</button>
        <button data-act="rename" title="이름 변경">이름</button>
        <button data-act="delete" title="삭제">삭제</button>
        <button data-act="export" title="CSV 내보내기">CSV</button>
      </div>
    </div>
  `;

  // Wire pane events
  el.querySelectorAll('[data-tab-idx]').forEach((tabEl) => {
    tabEl.addEventListener('click', (e) => {
      if (e.target.dataset.closeTab !== undefined) return;
      api(`/api/pane/${paneId}/options`, {
        method: 'POST',
        body: JSON.stringify({ activeTab: Number(tabEl.dataset.tabIdx) })
      }).catch((err) => setStatus(err.message));
    });
  });

  el.querySelectorAll('[data-close-tab]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      api(`/api/pane/${paneId}/options`, {
        method: 'POST',
        body: JSON.stringify({ closeTab: Number(btn.dataset.closeTab) })
      }).catch((err) => setStatus(err.message));
    });
  });

  el.querySelector('[data-new-tab]')?.addEventListener('click', () => {
    api(`/api/pane/${paneId}/navigate`, {
      method: 'POST',
      body: JSON.stringify({ path: tab.path, newTab: true })
    }).catch((err) => setStatus(err.message));
  });

  el.querySelectorAll('[data-hist]').forEach((btn) => {
    btn.addEventListener('click', () => {
      api(`/api/pane/${paneId}/history`, {
        method: 'POST',
        body: JSON.stringify({ direction: btn.dataset.hist })
      }).catch((err) => setStatus(err.message));
    });
  });

  el.querySelectorAll('[data-drive]').forEach((btn) => {
    btn.addEventListener('click', () => {
      api(`/api/pane/${paneId}/navigate`, {
        method: 'POST',
        body: JSON.stringify({ path: btn.dataset.drive })
      }).catch((err) => setStatus(err.message));
    });
  });

  const pathInput = el.querySelector('.path-input');
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      api(`/api/pane/${paneId}/navigate`, {
        method: 'POST',
        body: JSON.stringify({ path: pathInput.value })
      }).catch((err) => setStatus(`경로 오류: ${err.message}`));
    }
  });

  const extSelect = el.querySelector('.ext-filter-select');
  extSelect?.addEventListener('change', () => {
    api(`/api/pane/${paneId}/options`, {
      method: 'POST',
      body: JSON.stringify({ filter: extSelect.value })
    }).catch(() => {});
  });

  const filterInput = el.querySelector('.filter-input');
  let filterTimer = null;
  function sendFilterUpdate() {
    if (paneComposing[paneId]) return;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      if (paneComposing[paneId]) return;
      api(`/api/pane/${paneId}/options`, {
        method: 'POST',
        body: JSON.stringify({ filter: filterInput.value })
      }).catch(() => {});
    }, 320);
  }
  filterInput.addEventListener('compositionstart', () => { paneComposing[paneId] = true; });
  filterInput.addEventListener('compositionend', () => {
    paneComposing[paneId] = false;
    sendFilterUpdate();
  });
  filterInput.addEventListener('input', sendFilterUpdate);
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(filterTimer);
      api(`/api/pane/${paneId}/options`, {
        method: 'POST',
        body: JSON.stringify({ filter: filterInput.value })
      }).catch(() => {});
    }
  });

  el.querySelector('[data-refresh]')?.addEventListener('click', () => loadPaneListing(paneId));

  el.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', (e) => {
      if (e.target.classList.contains('col-resizer')) return;
      const sortBy = th.dataset.sort;
      const sortDir = tab.sortBy === sortBy && tab.sortDir === 'asc' ? 'desc' : 'asc';
      api(`/api/pane/${paneId}/options`, {
        method: 'POST',
        body: JSON.stringify({ sortBy, sortDir })
      }).catch(() => {});
    });
  });

  // Column header resize (drag + double-click auto-fit)
  el.querySelectorAll('.col-resizer').forEach((handle) => {
    const colKey = handle.dataset.resizeCol;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const colEl = el.querySelector(`col[data-col="${colKey}"]`);
      if (!colEl) return;
      const startX = e.clientX;
      const startW = paneColWidths[paneId][colKey] || colEl.getBoundingClientRect().width || 120;
      handle.classList.add('resizing');

      const tableEl = el.querySelector('table.file-table');
      function updateTableMinWidth() {
        const w = paneColWidths[paneId];
        if (tableEl) tableEl.style.minWidth = `${(w.name || 120) + (w.size || 78) + (w.mtime || 122)}px`;
      }

      function onMove(ev) {
        const nextW = Math.max(54, Math.min(1200, Math.round(startW + (ev.clientX - startX))));
        paneColWidths[paneId][colKey] = nextW;
        colEl.style.width = `${nextW}px`;
        updateTableMinWidth();
      }
      function onUp() {
        handle.classList.remove('resizing');
        saveColWidths();
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const colEl = el.querySelector(`col[data-col="${colKey}"]`);
      if (!colEl) return;
      if (colKey === 'name' && listing?.entries?.length) {
        const longest = listing.entries.reduce((m, it) => Math.max(m, it.name.length), 12);
        const fitW = Math.max(180, Math.min(900, Math.round(longest * 10.5 + 70)));
        paneColWidths[paneId].name = fitW;
        colEl.style.width = `${fitW}px`;
      } else if (colKey === 'size') {
        paneColWidths[paneId].size = 84;
        colEl.style.width = '84px';
      } else if (colKey === 'mtime') {
        paneColWidths[paneId].mtime = 128;
        colEl.style.width = '128px';
      }
      const tableEl = el.querySelector('table.file-table');
      const w = paneColWidths[paneId];
      if (tableEl) tableEl.style.minWidth = `${(w.name || 120) + (w.size || 78) + (w.mtime || 122)}px`;
      saveColWidths();
    });
  });

  el.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', async (e) => {
      if (tr.dataset.parent) return;
      const itemPath = tr.dataset.path;
      if (!itemPath) return;
      if (e.shiftKey && paneLastClicked[paneId] && listing?.entries?.length) {
        const paths = listing.entries.map((it) => it.path);
        const start = paths.indexOf(paneLastClicked[paneId]);
        const end = paths.indexOf(itemPath);
        if (start !== -1 && end !== -1) {
          if (!e.ctrlKey && !e.metaKey) selected.clear();
          const [lo, hi] = start < end ? [start, end] : [end, start];
          for (let k = lo; k <= hi; k++) selected.add(paths[k]);
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (selected.has(itemPath)) selected.delete(itemPath);
        else selected.add(itemPath);
        paneLastClicked[paneId] = itemPath;
      } else {
        selected.clear();
        selected.add(itemPath);
        paneLastClicked[paneId] = itemPath;
      }
      updatePaneSelectionUI(paneId);
      if (appState.showPreview && tr.dataset.dir === '0') {
        await loadPreview(itemPath);
      }
    });

    tr.addEventListener('dblclick', () => {
      if (tr.dataset.parent) {
        api(`/api/pane/${paneId}/navigate`, {
          method: 'POST',
          body: JSON.stringify({ path: tr.dataset.parent })
        }).catch((err) => setStatus(err.message));
        return;
      }
      if (tr.dataset.dir === '1') {
        selected.clear();
        api(`/api/pane/${paneId}/navigate`, {
          method: 'POST',
          body: JSON.stringify({ path: tr.dataset.path })
        }).catch((err) => setStatus(err.message));
      } else if (tr.dataset.path) {
        api('/api/open', {
          method: 'POST',
          body: JSON.stringify({ path: tr.dataset.path })
        })
          .then(() => setStatus(`기본 프로그램으로 열기: ${tr.dataset.path}`))
          .catch((err) => setStatus(`열기 오류: ${err.message}`));
      }
    });

    tr.addEventListener('dragstart', (e) => {
      const itemPath = tr.dataset.path;
      if (!itemPath) return;
      const paths = selected.has(itemPath) ? [...selected] : [itemPath];
      e.dataTransfer.setData('application/json', JSON.stringify({ sourcePane: paneId, paths }));
    });
  });

  el.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      const sel = [...selected];
      try {
        if (act === 'pin-ai') {
          const targets = sel.length ? sel : [tab.path];
          await api('/api/ai/pin', { method: 'POST', body: JSON.stringify({ paths: targets }) });
          try {
            await navigator.clipboard.writeText(targets.join('\n'));
            setStatus(`AI에 전달 & 클립보드 복사 완료 (${targets.length}개) — 채팅에서 "핀한 파일"로 바로 지시하세요`);
          } catch {
            setStatus(`AI에 전달 완료 (${targets.length}개) — 채팅에서 "핀한 파일"로 바로 지시하세요`);
          }
        } else if (act === 'to-md') {
          if (!sel.length) return setStatus('마크다운으로 변환할 문서(HWP/PDF/DOCX/XLSX/PPTX)를 먼저 선택해 주세요.');
          setStatus(`마크다운(.md) 변환 중... (${sel.length}개)`);
          const res = await api('/api/convert/markdown', { method: 'POST', body: JSON.stringify({ paths: sel }) });
          if (res.convertedCount > 0) {
            setStatus(`MD 변환 완료: ${res.convertedCount}개 생성${res.errors?.length ? ` (실패 ${res.errors.length}개)` : ''}`);
            await loadPaneListing(paneId);
          } else {
            setStatus(`MD 변환 실패: ${res.errors?.[0]?.error || '지원하지 않는 파일 형식입니다.'}`);
          }
        } else if (act === 'reveal') {
          const target = sel.length ? sel[0] : tab.path;
          await api('/api/reveal', { method: 'POST', body: JSON.stringify({ path: target }) });
          setStatus(`Windows 탐색기에서 열림: ${target}`);
        } else if (act === 'mkdir') {
          const name = prompt('새 폴더 이름:');
          if (!name) return;
          await api('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ parentDir: tab.path, name }) });
          await loadPaneListing(paneId);
        } else if (act === 'rename') {
          if (sel.length !== 1) return setStatus('이름을 변경할 항목 1개를 선택해 주세요.');
          const cur = sel[0].split(/[\\/]/).pop();
          const newName = prompt('새 이름:', cur);
          if (!newName || newName === cur) return;
          await api('/api/fs/rename', { method: 'POST', body: JSON.stringify({ path: sel[0], newName }) });
          selected.clear();
          await loadPaneListing(paneId);
        } else if (act === 'delete') {
          if (!sel.length) return setStatus('삭제할 항목을 선택해 주세요.');
          if (!confirm(`${sel.length}개 항목을 영구 삭제하시겠습니까?`)) return;
          await api('/api/fs/delete', { method: 'POST', body: JSON.stringify({ paths: sel }) });
          selected.clear();
          await loadPaneListing(paneId);
        } else if (act === 'export') {
          window.open(`/api/export?path=${encodeURIComponent(tab.path)}&format=csv`, '_blank');
        }
      } catch (err) {
        setStatus(`오류: ${err.message}`);
      }
    });
  });

  const newWrap = el.querySelector('.pane-list-wrap');
  if (newWrap) {
    newWrap.scrollTop = prevScrollTop;
    newWrap.scrollLeft = prevScrollLeft;
  }
  if (wasFilterFocused) {
    const newFilterEl = el.querySelector('.filter-input');
    if (newFilterEl) {
      newFilterEl.focus();
      if (prevSelStart !== null && prevSelEnd !== null) {
        try { newFilterEl.setSelectionRange(prevSelStart, prevSelEnd); } catch {}
      }
    }
  }
}

let currentPreviewPath = null;

function renderXlsxSheet(sheets, idx) {
  const sheet = sheets[idx] || sheets[0];
  const tabsHtml = sheets
    .map((s, i) => `<button class="xlsx-tab ${i === idx ? 'active' : ''}" data-sheet="${i}">${escapeHtml(s.name)}</button>`)
    .join('');
  const maxCols = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0) || 1;
  const rowsHtml = sheet.rows.length
    ? sheet.rows
        .map((r) => {
          const cells = [];
          for (let c = 0; c < maxCols; c++) {
            cells.push(`<td>${escapeHtml(r[c] ?? '')}</td>`);
          }
          return `<tr>${cells.join('')}</tr>`;
        })
        .join('')
    : '<tr><td>(빈 시트)</td></tr>';

  previewBody.innerHTML = `
    <div class="xlsx-tabs">${tabsHtml}</div>
    <div class="xlsx-wrap"><table class="xlsx-table"><tbody>${rowsHtml}</tbody></table></div>
    ${sheet.truncated ? '<p class="preview-notice">※ 최대 80행까지 미리보기로 표시됩니다.</p>' : ''}
  `;
  previewBody.querySelectorAll('[data-sheet]').forEach((btn) => {
    btn.addEventListener('click', () => renderXlsxSheet(sheets, Number(btn.dataset.sheet)));
  });
}

function renderHwpPreview(data, mode) {
  const hasImg = Boolean(data.previewImage);
  const hasTables = Array.isArray(data.tables) && data.tables.length > 0;
  const activeMode = mode || (hasImg ? 'image' : hasTables ? 'tables' : 'text');

  const tabsHtml = `<div class="xlsx-tabs">
    ${hasImg ? `<button class="xlsx-tab ${activeMode === 'image' ? 'active' : ''}" data-hwp-mode="image">🖼️ 원본 미리보기</button>` : ''}
    ${hasTables ? `<button class="xlsx-tab ${activeMode === 'tables' ? 'active' : ''}" data-hwp-mode="tables">📊 표 보기 (${data.tables.length})</button>` : ''}
    <button class="xlsx-tab ${activeMode === 'text' ? 'active' : ''}" data-hwp-mode="text">📄 텍스트</button>
  </div>`;

  let bodyHtml = '';
  if (activeMode === 'image' && hasImg) {
    bodyHtml = `<div style="text-align:center;background:#fff;padding:8px;border:1px solid var(--border);border-radius:5px">
      <img src="${data.previewImage}" alt="${escapeHtml(data.name)}" style="max-width:100%;height:auto;box-shadow:0 2px 8px rgba(0,0,0,0.12)" />
      <div class="preview-notice" style="padding:8px 0 0;font-size:11px">※ 한글 문서 저장 시 생성된 1페이지 원본 미리보기입니다. 전체 페이지는 상단 [↗ 열기]를 눌러 확인하세요.</div>
    </div>`;
  } else if (activeMode === 'tables' && hasTables) {
    bodyHtml = data.tables
      .map((t) => {
        const rowsHtml = t.rows
          .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
          .join('');
        return `<div style="margin-bottom:12px">
          <div style="font-size:11px;font-weight:700;color:var(--muted);margin-bottom:4px">표 ${t.index} (${t.nrows}행 × ${t.ncols}열)</div>
          <div class="xlsx-wrap" style="max-height:300px"><table class="xlsx-table"><tbody>${rowsHtml}</tbody></table></div>
        </div>`;
      })
      .join('');
  } else {
    const suffix = data.truncated ? `\n\n... (전체 ${data.totalChars?.toLocaleString() || ''}자 중 앞부분만 표시)` : '';
    bodyHtml = `<div class="preview-doc">${escapeHtml((data.content || '(추출된 텍스트 없음)') + suffix)}</div>`;
  }

  previewBody.innerHTML = tabsHtml + bodyHtml;
  previewBody.querySelectorAll('[data-hwp-mode]').forEach((btn) => {
    btn.addEventListener('click', () => renderHwpPreview(data, btn.dataset.hwpMode));
  });
}

const btnEditImage = document.getElementById('btnEditImage');
const btnEditPdf = document.getElementById('btnEditPdf');
const btnConvertMd = document.getElementById('btnConvertMd');

async function loadPreview(filePath) {
  if (!filePath) return;
  currentPreviewPath = filePath;
  btnEditImage?.classList.add('hidden');
  btnEditPdf?.classList.add('hidden');
  btnConvertMd?.classList.add('hidden');
  previewTitle.textContent = filePath.split(/[\\/]/).pop() || '미리보기';
  previewMeta.textContent = `${filePath}`;
  previewBody.innerHTML = '<div class="preview-notice">문서를 불러오는 중...</div>';
  try {
    const data = await api(`/api/preview?path=${encodeURIComponent(filePath)}`);
    previewTitle.textContent = data.name || '미리보기';
    previewMeta.textContent = `${data.path} · ${formatBytes(data.size)}`;
    if (['pdf', 'hwp', 'xlsx', 'document'].includes(data.kind)) {
      btnConvertMd?.classList.remove('hidden');
    }
    if (data.kind === 'image') {
      btnEditImage?.classList.remove('hidden');
      previewBody.innerHTML = `<img src="${data.rawUrl}" alt="${escapeHtml(data.name)}" />`;
    } else if (data.kind === 'pdf') {
      btnEditPdf?.classList.remove('hidden');
      previewBody.innerHTML = `<iframe class="preview-pdf" src="${data.rawUrl}"></iframe>`;
    } else if (data.kind === 'hwp') {
      renderHwpPreview(data);
    } else if (data.kind === 'xlsx') {
      if (!data.sheets?.length) {
        previewBody.innerHTML = '<div class="preview-notice">표시할 시트가 없습니다.</div>';
      } else {
        renderXlsxSheet(data.sheets, 0);
      }
    } else if (data.kind === 'document') {
      const suffix = data.truncated ? `\n\n... (전체 ${data.totalChars?.toLocaleString() || ''}자 중 앞부분만 표시)` : '';
      previewBody.innerHTML = `<div class="preview-doc">${escapeHtml((data.content || '(추출된 텍스트 없음)') + suffix)}</div>`;
    } else if (data.kind === 'zip') {
      const items = (data.entries || [])
        .map((e) => `<li data-zip-idx="${e.index}" data-zip-dir="${e.isDir ? '1' : '0'}" title="${e.isDir ? '폴더' : '더블클릭: 기본 앱으로 열기 · 👁: 바로 미리보기'}">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.isDir ? '📁' : '📄'} ${escapeHtml(e.name)}</span>
          <span class="zip-item-right">
            ${e.isDir ? '' : `<span>${formatBytes(e.size)}</span><button class="chip-btn" data-zip-prev="${e.index}" title="바로 미리보기">👁</button>`}
          </span>
        </li>`)
        .join('');
      previewBody.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:6px">
          <span style="font-size:12px;color:var(--muted)">압축 내부 (총 ${data.totalEntries}개 · 더블클릭으로 열기)</span>
          <button class="chip-btn" id="btnZipExtractAll" title="압축 파일과 같은 폴더에 압축 풀기">📦 압축 풀기</button>
        </div>
        <ul class="zip-list">${items}</ul>
      `;

      document.getElementById('btnZipExtractAll')?.addEventListener('click', async () => {
        try {
          setStatus('압축 푸는 중...');
          const res = await api('/api/zip/extract-all', { method: 'POST', body: JSON.stringify({ zipPath: data.path }) });
          setStatus(`압축 해제 완료 (${res.fileCount}개 파일) → ${res.destDir}`);
          await refreshAllPanes();
        } catch (err) {
          setStatus(`압축 해제 오류: ${err.message}`);
        }
      });

      previewBody.querySelectorAll('.zip-list li').forEach((li) => {
        if (li.dataset.zipDir === '1') return;
        const entryIndex = Number(li.dataset.zipIdx);
        li.addEventListener('dblclick', async () => {
          try {
            setStatus('압축 내부 파일 여는 중...');
            const res = await api('/api/zip/entry', {
              method: 'POST',
              body: JSON.stringify({ zipPath: data.path, entryIndex, action: 'open' })
            });
            setStatus(`열림: ${res.name}`);
          } catch (err) {
            setStatus(`열기 오류: ${err.message}`);
          }
        });
      });

      previewBody.querySelectorAll('[data-zip-prev]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const entryIndex = Number(btn.dataset.zipPrev);
          try {
            previewBody.innerHTML = '<div class="preview-notice">압축 내부 파일 미리보기 불러오는 중...</div>';
            const res = await api('/api/zip/entry', {
              method: 'POST',
              body: JSON.stringify({ zipPath: data.path, entryIndex, action: 'preview' })
            });
            await loadPreview(res.path);
            const backBar = document.createElement('div');
            backBar.style.cssText = 'margin-bottom:8px';
            backBar.innerHTML = `<button class="chip-btn" id="btnBackToZip">← ${escapeHtml(data.name)} 목록으로 돌아가기</button>`;
            previewBody.prepend(backBar);
            document.getElementById('btnBackToZip')?.addEventListener('click', () => loadPreview(data.path));
          } catch (err) {
            previewBody.innerHTML = `<div class="preview-notice">미리보기 오류: ${escapeHtml(err.message)}</div>`;
          }
        });
      });
    } else if (data.kind === 'text') {
      previewBody.textContent = data.content + (data.truncated ? '\n\n... (64KB 이후 생략)' : '');
    } else if (data.kind === 'binary' || data.kind === 'unsupported') {
      previewBody.innerHTML = `<div class="preview-notice">${escapeHtml(data.message || '미리보기를 지원하지 않는 형식입니다.')}</div>`;
    } else {
      previewBody.textContent = '폴더는 미리보기를 지원하지 않습니다.';
    }
  } catch (err) {
    previewBody.innerHTML = `<div class="preview-notice">미리보기 오류: ${escapeHtml(err.message)}</div>`;
  }
}

function paneKey(state, id) {
  if (!state?.panes?.[id]) return '';
  const p = state.panes[id];
  const t = p.tabs[p.activeTab] || p.tabs[0];
  return JSON.stringify([
    p.activeTab,
    p.tabs.length,
    t.path,
    t.filter,
    t.sortBy,
    t.sortDir,
    t.showHidden
  ]);
}

async function applyState(newState) {
  const prevState = appState;
  const prevPreview = prevState?.previewPath;
  const prevPins = JSON.stringify(prevState?.pinnedForAi || []);
  const prevWorked = JSON.stringify(prevState?.aiWorkedFiles || []);
  const prevFilters = JSON.stringify(prevState?.colorFilters || []);

  appState = newState;
  renderTopbar();

  const badgesChanged =
    prevPins !== JSON.stringify(newState.pinnedForAi || []) ||
    prevWorked !== JSON.stringify(newState.aiWorkedFiles || []);
  const filtersChanged = prevFilters !== JSON.stringify(newState.colorFilters || []);

  const reloads = [];
  for (let i = 0; i < 4; i++) {
    const needsFetch = !prevState || filtersChanged || paneKey(prevState, i) !== paneKey(newState, i);
    if (needsFetch) {
      reloads.push(loadPaneListing(i));
    } else if (badgesChanged) {
      renderPane(i);
    } else if (panesContainer.children[i]) {
      panesContainer.children[i].classList.toggle('active', appState.activePane === i);
    }
  }
  if (reloads.length) await Promise.all(reloads);

  if (appState.showPreview && appState.previewPath && appState.previewPath !== prevPreview) {
    await loadPreview(appState.previewPath);
  }
}

// Global toolbar events
document.querySelectorAll('[data-layout]').forEach((btn) => {
  btn.addEventListener('click', () => {
    api('/api/layout', { method: 'POST', body: JSON.stringify({ layout: btn.dataset.layout }) }).catch(() => {});
  });
});

favoritesSelect.addEventListener('change', () => {
  if (!favoritesSelect.value) return;
  api(`/api/pane/${appState.activePane}/navigate`, {
    method: 'POST',
    body: JSON.stringify({ path: favoritesSelect.value })
  }).catch((err) => setStatus(err.message));
  favoritesSelect.value = '';
});

document.getElementById('btnAddFav').addEventListener('click', () => {
  const curPath = activeTabOf(appState.activePane).path;
  api('/api/favorites', { method: 'POST', body: JSON.stringify({ action: 'add', path: curPath }) })
    .then(() => setStatus(`즐겨찾기에 추가됨: ${curPath}`))
    .catch((err) => setStatus(err.message));
});

document.getElementById('btnPreviewToggle').addEventListener('click', () => {
  api('/api/layout', { method: 'POST', body: JSON.stringify({ showPreview: !appState.showPreview }) }).catch(() => {});
});

document.getElementById('btnClosePreview').addEventListener('click', () => {
  api('/api/layout', { method: 'POST', body: JSON.stringify({ showPreview: false }) }).catch(() => {});
});

document.getElementById('btnOpenDefaultApp').addEventListener('click', () => {
  if (!currentPreviewPath) return setStatus('열 파일이 선택되지 않았습니다.');
  api('/api/open', { method: 'POST', body: JSON.stringify({ path: currentPreviewPath }) })
    .then(() => setStatus(`기본 프로그램으로 열기: ${currentPreviewPath}`))
    .catch((err) => setStatus(err.message));
});

btnEditImage?.addEventListener('click', () => {
  if (currentPreviewPath && window.openImageEditor) {
    window.openImageEditor(currentPreviewPath);
  }
});

btnEditPdf?.addEventListener('click', () => {
  if (currentPreviewPath && window.openPdfEditor) {
    window.openPdfEditor(currentPreviewPath);
  }
});

btnConvertMd?.addEventListener('click', async () => {
  if (!currentPreviewPath) return;
  try {
    setStatus('마크다운(.md) 변환 중...');
    const res = await api('/api/convert/markdown', { method: 'POST', body: JSON.stringify({ paths: [currentPreviewPath] }) });
    if (res.convertedCount > 0) {
      setStatus(`MD 변환 완료: ${res.results[0].outputPath}`);
      await refreshAllPanes();
    } else {
      setStatus(`MD 변환 실패: ${res.errors?.[0]?.error || '오류'}`);
    }
  } catch (err) {
    setStatus(`MD 변환 오류: ${err.message}`);
  }
});

document.getElementById('btnSyncQdir').addEventListener('click', async () => {
  try {
    const res = await api('/api/sync-qdir', { method: 'POST' });
    setStatus(`로컬 Q-Dir 설정 동기화 완료 (${res.iniSource}, v${res.qdirVersion || 'unknown'})`);
  } catch (err) {
    setStatus(err.message);
  }
});

document.getElementById('btnTheme').addEventListener('click', () => {
  const next = appState.theme === 'dark' ? 'light' : 'dark';
  api('/api/layout', { method: 'POST', body: JSON.stringify({ theme: next }) }).catch(() => {});
});

document.getElementById('btnCompare').addEventListener('click', async () => {
  try {
    const diff = await api('/api/compare?paneA=0&paneB=1');
    compareBody.innerHTML = `
      <p><strong>Pane 1:</strong> ${escapeHtml(diff.pathA)}<br/><strong>Pane 2:</strong> ${escapeHtml(diff.pathB)}</p>
      <p>Pane 1 전용: <b>${diff.summary.onlyInA}</b> · Pane 2 전용: <b>${diff.summary.onlyInB}</b> · 크기 다름: <b>${diff.summary.different}</b> · 동일: <b>${diff.summary.identical}</b></p>
      <h4>Pane 1에만 있는 항목</h4>
      <ul>${diff.onlyInA.slice(0, 50).map((e) => `<li>${escapeHtml(e.name)}</li>`).join('') || '<li>없음</li>'}</ul>
      <h4>Pane 2에만 있는 항목</h4>
      <ul>${diff.onlyInB.slice(0, 50).map((e) => `<li>${escapeHtml(e.name)}</li>`).join('') || '<li>없음</li>'}</ul>
      <h4>크기/유형이 다른 항목</h4>
      <ul>${diff.different.slice(0, 50).map((d) => `<li>${escapeHtml(d.name)} (${formatBytes(d.a.size)} vs ${formatBytes(d.b.size)})</li>`).join('') || '<li>없음</li>'}</ul>
    `;
    compareModal.classList.remove('hidden');
  } catch (err) {
    setStatus(err.message);
  }
});

document.getElementById('btnCloseCompare').addEventListener('click', () => {
  compareModal.classList.add('hidden');
});

document.getElementById('btnCopyPins').addEventListener('click', async () => {
  const pins = (appState?.pinnedForAi || []).map((p) => p.path);
  if (!pins.length) return setStatus('복사할 핀 경로가 없습니다.');
  try {
    await navigator.clipboard.writeText(pins.join('\n'));
    setStatus(`핀 경로 ${pins.length}개를 클립보드에 복사했습니다.`);
  } catch (err) {
    setStatus(`복사 실패: ${err.message}`);
  }
});

document.getElementById('btnClearPins').addEventListener('click', () => {
  api('/api/ai/unpin', { method: 'POST', body: JSON.stringify({}) })
    .then(() => setStatus('AI 전달 경로를 모두 비웠습니다.'))
    .catch((err) => setStatus(err.message));
});

document.getElementById('btnClearWorked').addEventListener('click', () => {
  api('/api/ai/clear-worked', { method: 'POST', body: JSON.stringify({}) })
    .then(() => setStatus('AI 작업 기록을 지웠습니다.'))
    .catch((err) => setStatus(err.message));
});

// Boot + SSE live sync
async function init() {
  const data = await api('/api/state');
  drives = data.drives || [];
  await applyState(data.state);

  const es = new EventSource('/api/events');
  es.addEventListener('open', () => {
    syncBadge.textContent = 'LIVE';
    syncBadge.classList.remove('offline');
  });
  es.addEventListener('error', () => {
    syncBadge.textContent = 'OFFLINE';
    syncBadge.classList.add('offline');
  });
  es.addEventListener('state', (e) => {
    const next = JSON.parse(e.data);
    applyState(next);
  });
  es.addEventListener('fs_change', () => {
    refreshAllPanes();
  });
}

init().catch((err) => setStatus(`초기화 오류: ${err.message}`));

// Windows standard keyboard shortcuts for file explorer
window.addEventListener('keydown', async (e) => {
  const editorOpen = !document.getElementById('imageEditorModal')?.classList.contains('hidden');
  const compareOpen = !compareModal.classList.contains('hidden');
  if (editorOpen || compareOpen || !appState) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const paneId = appState.activePane ?? 0;
  const tab = activeTabOf(paneId);
  const selected = paneSelections[paneId];
  const selArr = [...selected];
  const key = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && key === 'c') {
    if (!selArr.length) return;
    e.preventDefault();
    fsClipboard = { mode: 'copy', paths: selArr };
    setStatus(`📋 ${selArr.length}개 항목 복사 대기 — 원하는 패널에서 Ctrl+V로 붙여넣기`);
  } else if (ctrl && key === 'x') {
    if (!selArr.length) return;
    e.preventDefault();
    fsClipboard = { mode: 'cut', paths: selArr };
    setStatus(`✂️ ${selArr.length}개 항목 잘라내기 대기 — 원하는 패널에서 Ctrl+V로 이동`);
  } else if (ctrl && key === 'v') {
    if (!fsClipboard?.paths?.length) return;
    e.preventDefault();
    const isCut = fsClipboard.mode === 'cut';
    try {
      await api(isCut ? '/api/fs/move' : '/api/fs/copy', {
        method: 'POST',
        body: JSON.stringify({ sources: fsClipboard.paths, destDir: tab.path })
      });
      setStatus(`${fsClipboard.paths.length}개 항목을 패널 ${paneId + 1}로 ${isCut ? '이동' : '복사'}했습니다.`);
      if (isCut) fsClipboard = null;
      await refreshAllPanes();
    } catch (err) {
      setStatus(`붙여넣기 오류: ${err.message}`);
    }
  } else if (ctrl && key === 'a') {
    const entries = paneListings[paneId]?.entries || [];
    if (!entries.length) return;
    e.preventDefault();
    selected.clear();
    for (const item of entries) selected.add(item.path);
    updatePaneSelectionUI(paneId);
  } else if (e.key === 'F2') {
    if (selArr.length !== 1) return;
    e.preventDefault();
    const cur = selArr[0].split(/[\\/]/).pop();
    const newName = prompt('새 이름:', cur);
    if (!newName || newName === cur) return;
    try {
      await api('/api/fs/rename', { method: 'POST', body: JSON.stringify({ path: selArr[0], newName }) });
      selected.clear();
      await loadPaneListing(paneId);
    } catch (err) {
      setStatus(`이름 변경 오류: ${err.message}`);
    }
  } else if (e.key === 'Delete') {
    if (!selArr.length) return;
    e.preventDefault();
    if (!confirm(`${selArr.length}개 항목을 영구 삭제하시겠습니까?`)) return;
    try {
      await api('/api/fs/delete', { method: 'POST', body: JSON.stringify({ paths: selArr }) });
      selected.clear();
      await loadPaneListing(paneId);
    } catch (err) {
      setStatus(`삭제 오류: ${err.message}`);
    }
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    api(`/api/pane/${paneId}/history`, { method: 'POST', body: JSON.stringify({ direction: 'up' }) }).catch(() => {});
  } else if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    api(`/api/pane/${paneId}/history`, { method: 'POST', body: JSON.stringify({ direction: 'back' }) }).catch(() => {});
  } else if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    api(`/api/pane/${paneId}/history`, { method: 'POST', body: JSON.stringify({ direction: 'forward' }) }).catch(() => {});
  }
});
