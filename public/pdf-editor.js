(function () {
  const modal = document.getElementById('pdfEditorModal');
  const card = modal.querySelector('.editor-card');
  const titleEl = document.getElementById('pdfEditorTitle');
  const pagesListEl = document.getElementById('pdfPagesList');
  const pageCountEl = document.getElementById('pdfPageCount');
  const stageWrap = document.getElementById('pdfStageWrap');
  const stage = document.getElementById('pdfStage');
  const pageImg = document.getElementById('pdfPageImg');
  const overlay = document.getElementById('pdfOverlay');
  const annPageLabel = document.getElementById('pdfAnnPageLabel');
  const annListEl = document.getElementById('pdfAnnList');
  const mergeInput = document.getElementById('pdfMergeFileInput');
  const stampInput = document.getElementById('pdfStampFileInput');
  const sizeInput = document.getElementById('pdfAnnSize');
  const colorInput = document.getElementById('pdfAnnColor');
  const maskColorInput = document.getElementById('pdfMaskColor');
  const hintEl = document.getElementById('pdfEditorHint');

  let currentPath = null;
  let pages = []; // { uid, source, extraIndex, pageIndex, width, height, label, snippet, rotation, rotateDelta, checked, annotations: [] }
  let extraPdfs = [];
  let selectedIdx = 0;
  let activeTool = 'select'; // select | text | mask
  let selectedAnnId = null;
  let zoomPct = 100;
  let dragOp = null;

  function currentPage() {
    return pages[selectedIdx] || null;
  }

  function applyStageSize() {
    const p = currentPage();
    const baseW = Math.min(720, Math.max(460, stageWrap.clientWidth - 48));
    const w = Math.round((baseW * zoomPct) / 100);
    stage.style.width = `${w}px`;
    const zBtn = document.getElementById('btnPdfZoomReset');
    if (zBtn) zBtn.textContent = `${zoomPct}%`;
    if (p) renderOverlayAnnotations();
  }

  function setTool(tool) {
    activeTool = tool;
    document.querySelectorAll('[data-pdf-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.pdfTool === tool);
    });
    overlay.className = `pdf-overlay tool-${tool}`;
    if (tool === 'text') {
      hintEl.textContent = '📝 PDF 화면에서 글자를 넣을 위치를 클릭하세요 — 바로 입력 상자가 나타납니다 (Enter: 확정, Esc: 취소)';
    } else if (tool === 'mask') {
      hintEl.textContent = '⬜ PDF 화면에서 가릴 영역을 마우스로 드래그하세요';
    } else {
      hintEl.textContent = '↖ 추가된 텍스트·가리기·도장을 클릭해 드래그 이동 / 더블클릭: 텍스트 수정 / Delete: 삭제 / Ctrl+V: 도장·QR 붙여넣기';
    }
  }

  function renderPagesList() {
    pageCountEl.textContent = `${pages.length}쪽`;
    if (!pages.length) {
      pagesListEl.innerHTML = '<div class="ai-empty" style="padding:10px">남은 페이지가 없습니다.</div>';
      return;
    }
    pagesListEl.innerHTML = pages
      .map((p, idx) => {
        const totalRot = ((p.rotation || 0) + (p.rotateDelta || 0)) % 360;
        const annCount = p.annotations?.length || 0;
        return `<div class="layer-item ${idx === selectedIdx ? 'active' : ''}" data-pidx="${idx}">
          <div class="layer-row">
            <input type="checkbox" data-pcheck="${idx}" ${p.checked ? 'checked' : ''} title="추출할 페이지 선택" />
            <span class="layer-name" title="${p.snippet || ''}">P.${idx + 1} (${p.label}${totalRot ? ` · ${totalRot}°` : ''})${annCount ? ` 📝${annCount}` : ''}</span>
          </div>
          ${p.snippet ? `<div style="font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.snippet.replace(/</g, '&lt;')}</div>` : ''}
          <div class="layer-btns">
            <button data-pact="up" title="위로">▲</button>
            <button data-pact="down" title="아래로">▼</button>
            <button data-pact="rot" title="90도 회전">↻90°</button>
            <button data-pact="del" title="페이지 삭제">🗑️</button>
          </div>
        </div>`;
      })
      .join('');

    pagesListEl.querySelectorAll('.layer-item').forEach((item) => {
      const idx = Number(item.dataset.pidx);
      item.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.tagName === 'INPUT') return;
        selectedIdx = idx;
        selectedAnnId = null;
        renderAll();
      });
      item.querySelector('[data-pcheck]')?.addEventListener('change', (e) => {
        pages[idx].checked = e.target.checked;
      });
      item.querySelectorAll('[data-pact]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.dataset.pact;
          if (act === 'up' && idx > 0) {
            [pages[idx], pages[idx - 1]] = [pages[idx - 1], pages[idx]];
            selectedIdx = idx - 1;
          } else if (act === 'down' && idx < pages.length - 1) {
            [pages[idx], pages[idx + 1]] = [pages[idx + 1], pages[idx]];
            selectedIdx = idx + 1;
          } else if (act === 'rot') {
            pages[idx].rotateDelta = ((pages[idx].rotateDelta || 0) + 90) % 360;
          } else if (act === 'del') {
            if (pages.length <= 1) return alert('최소 1페이지는 남아야 합니다.');
            pages.splice(idx, 1);
            selectedIdx = Math.min(selectedIdx, pages.length - 1);
          }
          renderAll();
        });
      });
    });
  }

  function renderPageImage() {
    const p = currentPage();
    if (!p) return;
    if (p.source === 'main') {
      const url = `/api/pdf/render?path=${encodeURIComponent(currentPath)}&page=${p.pageIndex}&scale=2`;
      if (pageImg.dataset.src !== url) {
        pageImg.dataset.src = url;
        pageImg.src = url;
      }
    } else {
      pageImg.removeAttribute('src');
      pageImg.dataset.src = '';
    }
    applyStageSize();
  }

  function renderOverlayAnnotations() {
    const p = currentPage();
    if (!p) return;
    overlay.innerHTML = '';
    const stageW = stage.clientWidth || 600;
    const ptScale = stageW / (p.width || 595);

    for (const ann of p.annotations || []) {
      const el = document.createElement('div');
      el.className = `pdf-ann ${ann.id === selectedAnnId ? 'selected' : ''}`;
      el.dataset.annId = ann.id;
      el.style.left = `${ann.xPct}%`;
      el.style.top = `${ann.yPct}%`;

      if (ann.kind === 'text') {
        el.classList.add('pdf-ann-text');
        el.style.fontSize = `${Math.max(8, Math.round((ann.fontSize || 14) * ptScale))}px`;
        el.style.color = ann.color || '#111111';
        el.textContent = ann.text;
        el.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          openInlineTextEditor(ann.xPct, ann.yPct, ann);
        });
      } else if (ann.kind === 'rect') {
        el.style.width = `${ann.wPct}%`;
        el.style.height = `${ann.hPct}%`;
        el.style.background = ann.color || '#ffffff';
        el.style.border = ann.id === selectedAnnId ? '' : '1px dashed rgba(148,163,184,0.6)';
        const handle = document.createElement('div');
        handle.className = 'pdf-ann-resize';
        handle.dataset.resize = '1';
        el.appendChild(handle);
      } else if (ann.kind === 'image') {
        el.style.width = `${ann.wPct}%`;
        const img = document.createElement('img');
        img.src = ann.dataUrl;
        img.draggable = false;
        img.style.width = '100%';
        img.style.display = 'block';
        el.appendChild(img);
        const handle = document.createElement('div');
        handle.className = 'pdf-ann-resize';
        handle.dataset.resize = '1';
        el.appendChild(handle);
      }

      el.addEventListener('mousedown', (e) => {
        if (activeTool === 'text' && ann.kind !== 'text') return;
        e.stopPropagation();
        selectedAnnId = ann.id;
        const rect = overlay.getBoundingClientRect();
        if (e.target.dataset.resize === '1') {
          dragOp = {
            mode: 'resize',
            ann,
            startX: e.clientX,
            startY: e.clientY,
            origW: ann.wPct || 18,
            origH: ann.hPct || 5,
            rect
          };
        } else {
          dragOp = {
            mode: 'move',
            ann,
            startX: e.clientX,
            startY: e.clientY,
            origX: ann.xPct,
            origY: ann.yPct,
            rect
          };
        }
        renderAnnotationsList();
        renderOverlayAnnotations();
      });

      overlay.appendChild(el);
    }
  }

  function renderAnnotationsList() {
    const p = currentPage();
    if (!p) return;
    annPageLabel.textContent = `P.${selectedIdx + 1} 추가 항목 (${p.annotations.length})`;
    const list = p.annotations || [];
    if (!list.length) {
      annListEl.innerHTML = '<div class="ai-empty" style="padding:6px">추가된 항목 없음</div>';
      return;
    }
    annListEl.innerHTML = list
      .map((a, i) => {
        const desc = a.kind === 'text'
          ? `T "${a.text}"`
          : a.kind === 'image'
            ? `🖼️ ${a.name || '도장/QR'}`
            : `⬜ 가리기 박스`;
        return `<div class="layer-item ${a.id === selectedAnnId ? 'active' : ''}" data-list-ann="${a.id}">
          <div class="layer-row">
            <span class="layer-name" title="${desc}">${desc}</span>
            <button class="chip-btn" data-ann-del="${i}">×</button>
          </div>
        </div>`;
      })
      .join('');
    annListEl.querySelectorAll('[data-list-ann]').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        selectedAnnId = item.dataset.listAnn;
        renderAnnotationsList();
        renderOverlayAnnotations();
      });
    });
    annListEl.querySelectorAll('[data-ann-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        p.annotations.splice(Number(btn.dataset.annDel), 1);
        selectedAnnId = null;
        renderAll();
      });
    });
  }

  function renderAll() {
    renderPagesList();
    renderPageImage();
    renderOverlayAnnotations();
    renderAnnotationsList();
  }

  function openInlineTextEditor(xPct, yPct, existingAnn = null) {
    const p = currentPage();
    if (!p) return;
    overlay.querySelectorAll('.pdf-inline-input').forEach((el) => el.remove());

    const stageW = stage.clientWidth || 600;
    const ptScale = stageW / (p.width || 595);
    const fontSize = existingAnn ? existingAnn.fontSize : (Number(sizeInput.value) || 14);
    const color = existingAnn ? existingAnn.color : (colorInput.value || '#111111');

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'pdf-inline-input';
    inp.placeholder = '여기에 입력 후 Enter';
    inp.value = existingAnn ? existingAnn.text : '';
    inp.style.left = `${xPct}%`;
    inp.style.top = `${yPct}%`;
    inp.style.fontSize = `${Math.max(10, Math.round(fontSize * ptScale))}px`;
    inp.style.color = color;

    let committed = false;
    function commit() {
      if (committed) return;
      committed = true;
      const val = inp.value.trim();
      inp.remove();
      if (val) {
        if (existingAnn) {
          existingAnn.text = val;
          existingAnn.fontSize = Number(sizeInput.value) || existingAnn.fontSize;
          existingAnn.color = colorInput.value || existingAnn.color;
          selectedAnnId = existingAnn.id;
        } else {
          const ann = {
            id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            kind: 'text',
            text: val,
            xPct,
            yPct,
            fontSize: Number(sizeInput.value) || 14,
            color: colorInput.value || '#111111'
          };
          p.annotations.push(ann);
          selectedAnnId = ann.id;
        }
        renderAll();
      }
    }

    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        committed = true;
        inp.remove();
      }
    });
    inp.addEventListener('blur', commit);

    overlay.appendChild(inp);
    setTimeout(() => inp.focus(), 0);
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('pdf-inline-input')) return;
    const p = currentPage();
    if (!p) return;
    const rect = overlay.getBoundingClientRect();
    const xPct = Math.max(0, Math.min(98, ((e.clientX - rect.left) / rect.width) * 100));
    const yPct = Math.max(0, Math.min(98, ((e.clientY - rect.top) / rect.height) * 100));

    if (activeTool === 'text') {
      e.preventDefault();
      openInlineTextEditor(Number(xPct.toFixed(2)), Number(yPct.toFixed(2)));
      return;
    }

    if (activeTool === 'mask') {
      e.preventDefault();
      const preview = document.createElement('div');
      preview.className = 'pdf-mask-preview';
      preview.style.left = `${xPct}%`;
      preview.style.top = `${yPct}%`;
      overlay.appendChild(preview);
      dragOp = { mode: 'draw-mask', startXPct: xPct, startYPct: yPct, rect, preview };
      return;
    }

    selectedAnnId = null;
    renderAnnotationsList();
    renderOverlayAnnotations();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragOp || modal.classList.contains('hidden')) return;
    const { rect } = dragOp;
    if (dragOp.mode === 'move') {
      const dxPct = ((e.clientX - dragOp.startX) / rect.width) * 100;
      const dyPct = ((e.clientY - dragOp.startY) / rect.height) * 100;
      dragOp.ann.xPct = Number(Math.max(0, Math.min(98, dragOp.origX + dxPct)).toFixed(2));
      dragOp.ann.yPct = Number(Math.max(0, Math.min(98, dragOp.origY + dyPct)).toFixed(2));
      renderOverlayAnnotations();
    } else if (dragOp.mode === 'resize') {
      const dwPct = ((e.clientX - dragOp.startX) / rect.width) * 100;
      const dhPct = ((e.clientY - dragOp.startY) / rect.height) * 100;
      dragOp.ann.wPct = Number(Math.max(2, Math.min(95, dragOp.origW + dwPct)).toFixed(2));
      if (dragOp.ann.kind === 'rect') {
        dragOp.ann.hPct = Number(Math.max(1, Math.min(95, dragOp.origH + dhPct)).toFixed(2));
      }
      renderOverlayAnnotations();
    } else if (dragOp.mode === 'draw-mask') {
      const curX = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      const curY = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
      const x = Math.min(dragOp.startXPct, curX);
      const y = Math.min(dragOp.startYPct, curY);
      const w = Math.abs(curX - dragOp.startXPct);
      const h = Math.abs(curY - dragOp.startYPct);
      dragOp.box = { xPct: Number(x.toFixed(2)), yPct: Number(y.toFixed(2)), wPct: Number(w.toFixed(2)), hPct: Number(h.toFixed(2)) };
      dragOp.preview.style.left = `${x}%`;
      dragOp.preview.style.top = `${y}%`;
      dragOp.preview.style.width = `${w}%`;
      dragOp.preview.style.height = `${h}%`;
    }
  });

  window.addEventListener('mouseup', () => {
    if (!dragOp) return;
    const op = dragOp;
    dragOp = null;
    if (op.mode === 'draw-mask') {
      op.preview.remove();
      if (op.box && op.box.wPct >= 1 && op.box.hPct >= 0.6) {
        const p = currentPage();
        const ann = {
          id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          kind: 'rect',
          ...op.box,
          color: maskColorInput.value || '#ffffff'
        };
        p.annotations.push(ann);
        selectedAnnId = ann.id;
        renderAll();
      }
    }
  });

  // Delete selected annotation with Delete key, Paste image with Ctrl+V
  window.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (document.activeElement?.tagName === 'INPUT') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnnId) {
      const p = currentPage();
      if (!p) return;
      e.preventDefault();
      p.annotations = p.annotations.filter((a) => a.id !== selectedAnnId);
      selectedAnnId = null;
      renderAll();
    }
  });

  window.addEventListener('paste', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (document.activeElement?.tagName === 'INPUT') return;
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        addStampFile(item.getAsFile(), '붙여넣은 도장/QR');
        return;
      }
    }
  });

  function addStampFile(file, fallbackName = '도장/QR') {
    const p = currentPage();
    if (!file || !p) return;
    const reader = new FileReader();
    reader.onload = () => {
      const ann = {
        id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        kind: 'image',
        name: file.name || fallbackName,
        dataUrl: reader.result,
        xPct: 68,
        yPct: 76,
        wPct: 18
      };
      p.annotations.push(ann);
      selectedAnnId = ann.id;
      setTool('select');
      renderAll();
    };
    reader.readAsDataURL(file);
  }

  // Toolbar bindings
  document.querySelectorAll('[data-pdf-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.pdfTool));
  });

  document.getElementById('btnPdfAddStamp').addEventListener('click', () => stampInput.click());
  stampInput.addEventListener('change', () => {
    if (stampInput.files?.[0]) addStampFile(stampInput.files[0]);
    stampInput.value = '';
  });

  document.getElementById('btnPdfZoomIn').addEventListener('click', () => {
    zoomPct = Math.min(250, zoomPct + 20);
    applyStageSize();
  });
  document.getElementById('btnPdfZoomOut').addEventListener('click', () => {
    zoomPct = Math.max(50, zoomPct - 20);
    applyStageSize();
  });
  document.getElementById('btnPdfZoomReset').addEventListener('click', () => {
    zoomPct = 100;
    applyStageSize();
  });

  // Merge another PDF file
  document.getElementById('btnPdfMerge').addEventListener('click', () => mergeInput.click());
  mergeInput.addEventListener('change', async () => {
    const file = mergeInput.files?.[0];
    mergeInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const exIdx = extraPdfs.length;
      extraPdfs.push({ name: file.name, dataUrl });
      const buf = await file.arrayBuffer();
      const txt = new TextDecoder('latin1').decode(buf);
      const matches = txt.match(/\/Type\s*\/Page\b(?!s)/g);
      const estCount = Math.max(1, matches ? matches.length : 1);
      for (let i = 0; i < estCount; i++) {
        pages.push({
          uid: `ex-${exIdx}-${i}-${Date.now()}`,
          source: 'extra',
          extraIndex: exIdx,
          pageIndex: i,
          width: 595,
          height: 842,
          label: `${file.name} #${i + 1}`,
          snippet: `[병합됨] ${file.name}`,
          rotation: 0,
          rotateDelta: 0,
          checked: false,
          annotations: []
        });
      }
      renderAll();
      alert(`"${file.name}" (${estCount}페이지)가 맨 뒤에 추가되었습니다. 저장 시 합쳐집니다.`);
    };
    reader.readAsDataURL(file);
  });

  async function savePdfPlan(selectedOnly = false) {
    const targetPages = selectedOnly ? pages.filter((p) => p.checked) : pages;
    if (!targetPages.length) {
      return alert(selectedOnly ? '추출할 페이지를 좌측 체크박스로 선택해 주세요.' : '저장할 페이지가 없습니다.');
    }
    const base = (currentPath.split(/[\\/]/).pop() || 'doc.pdf').replace(/\.pdf$/i, '');
    const defaultName = selectedOnly ? `${base}_extracted.pdf` : `${base}_edited.pdf`;
    const fileName = await window.qdirPrompt('저장할 PDF 파일명 (같은 폴더에 저장됩니다):', defaultName);
    if (!fileName) return;

    try {
      const res = await fetch('/api/pdf/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalPath: currentPath,
          fileName,
          pages: targetPages.map((p) => ({
            source: p.source,
            extraIndex: p.extraIndex,
            pageIndex: p.pageIndex,
            rotateDelta: p.rotateDelta || 0,
            annotations: p.annotations || []
          })),
          extraPdfs: extraPdfs.map((e) => ({ dataUrl: e.dataUrl }))
        })
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);
      alert(`PDF 저장 완료! (${res.pageCount}쪽)\n${res.savedPath}`);
    } catch (err) {
      alert(`PDF 저장 실패: ${err.message}`);
    }
  }

  document.getElementById('btnPdfSaveAll').addEventListener('click', () => savePdfPlan(false));
  document.getElementById('btnPdfExtract').addEventListener('click', () => savePdfPlan(true));

  const btnMax = document.getElementById('btnPdfMaximize');
  btnMax?.addEventListener('click', () => {
    const isMax = card.classList.toggle('maximized');
    btnMax.textContent = isMax ? '🗗' : '⛶';
    setTimeout(applyStageSize, 50);
  });

  document.getElementById('btnClosePdfEditor').addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  pageImg.addEventListener('load', () => renderOverlayAnnotations());

  window.openPdfEditor = async function (filePath) {
    currentPath = filePath;
    extraPdfs = [];
    selectedIdx = 0;
    selectedAnnId = null;
    zoomPct = 100;
    pageImg.dataset.src = '';
    titleEl.textContent = `📄 PDF 편집 — ${filePath.split(/[\\/]/).pop()}`;
    pagesListEl.innerHTML = '<div class="ai-empty" style="padding:10px">PDF 구조 분석 중...</div>';
    modal.classList.remove('hidden');
    setTool('select');

    try {
      const info = await fetch(`/api/pdf/info?path=${encodeURIComponent(filePath)}`).then((r) => r.json());
      if (info.error) throw new Error(info.error);
      pages = info.pages.map((p) => ({
        uid: `main-${p.index}`,
        source: 'main',
        pageIndex: p.index,
        width: p.width || 595,
        height: p.height || 842,
        label: `원본 ${p.pageNum}`,
        snippet: p.snippet || '',
        rotation: p.rotation || 0,
        rotateDelta: 0,
        checked: false,
        annotations: []
      }));
      renderAll();
    } catch (err) {
      alert(`PDF 불러오기 실패: ${err.message}`);
      modal.classList.add('hidden');
    }
  };
})();
