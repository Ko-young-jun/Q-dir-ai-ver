(function () {
  const modal = document.getElementById('imageEditorModal');
  const canvas = document.getElementById('imgEditorCanvas');
  const ctx = canvas.getContext('2d');
  const titleEl = document.getElementById('imgEditorTitle');
  const infoEl = document.getElementById('imgEditorInfo');
  const colorInput = document.getElementById('imgToolColor');
  const sizeInput = document.getElementById('imgToolSize');
  const aiNoteInput = document.getElementById('imgAiNote');
  const aiRegionBar = document.getElementById('imgAiRegionBar');
  const aiRegionCoords = document.getElementById('imgAiRegionCoords');
  const overlayInput = document.getElementById('imgOverlayFileInput');
  const adjustBar = document.getElementById('imgAdjustBar');
  const adjBright = document.getElementById('adjBright');
  const adjContrast = document.getElementById('adjContrast');
  const adjSaturate = document.getElementById('adjSaturate');
  const rotateBar = document.getElementById('imgRotateBar');
  const rotTargetEl = document.getElementById('imgRotTarget');
  const rotSlider = document.getElementById('rotSlider');
  const rotInput = document.getElementById('rotInput');
  const btnRotApply = document.getElementById('btnRotApply');
  const selBar = document.getElementById('imgSelectionBar');
  const selCoordsEl = document.getElementById('imgSelCoords');
  const layersListEl = document.getElementById('imgLayersList');
  const layerCountEl = document.getElementById('imgLayerCount');
  const canvasWrap = canvas.parentElement;

  let currentPath = null;
  let baseCanvas = document.createElement('canvas');
  let baseCtx = baseCanvas.getContext('2d');
  let undoStack = [];
  let redoStack = [];
  let internalClipboard = null; // { dataUrl, name, w, h, prefer: boolean }
  let overlays = []; // { id, name, visible, img, x, y, w, h }
  let selectedOverlayId = null;
  let activeTool = 'select'; // select | pan | marquee | lasso | ai-region | eraser | wand | brush | eyedropper | crop | mosaic | rect | arrow | text
  let aiRegion = null; // { x, y, w, h }
  let selRect = null; // { x, y, w, h }
  let selLasso = null; // [{ x, y }, ...]
  let basePreviewAngle = 0; // degrees for live preview when rotating background
  let spaceDown = false;
  let panState = null;
  let layerSeq = 1;
  let zoomLevel = 1;
  let dragState = null;

  function hasSelection() {
    return Boolean((selRect && selRect.w > 2 && selRect.h > 2) || (selLasso && selLasso.length >= 3));
  }

  function lassoBounds(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function applyZoomStyle() {
    if (zoomLevel === 1) {
      canvas.style.maxWidth = '100%';
      canvas.style.maxHeight = '100%';
      canvas.style.width = '';
      canvas.style.height = '';
    } else {
      canvas.style.maxWidth = 'none';
      canvas.style.maxHeight = 'none';
      canvas.style.width = `${Math.round(baseCanvas.width * zoomLevel)}px`;
      canvas.style.height = `${Math.round(baseCanvas.height * zoomLevel)}px`;
    }
    const zBtn = document.getElementById('btnImgZoomReset');
    if (zBtn) zBtn.textContent = zoomLevel === 1 ? '맞춤' : `${Math.round(zoomLevel * 100)}%`;
  }

  function currentFilterCss() {
    const b = adjBright.value;
    const c = adjContrast.value;
    const s = adjSaturate.value;
    if (b === '100' && c === '100' && s === '100') return 'none';
    return `brightness(${b}%) contrast(${c}%) saturate(${s}%)`;
  }

  function captureSnapshot() {
    const snap = document.createElement('canvas');
    snap.width = baseCanvas.width;
    snap.height = baseCanvas.height;
    snap.getContext('2d').drawImage(baseCanvas, 0, 0);
    return {
      canvas: snap,
      overlays: overlays.map((o) => ({ ...o })),
      aiRegion: aiRegion ? { ...aiRegion } : null,
      selRect: selRect ? { ...selRect } : null,
      selLasso: selLasso ? selLasso.map((p) => ({ ...p })) : null
    };
  }

  function restoreSnapshot(snap) {
    baseCanvas.width = snap.canvas.width;
    baseCanvas.height = snap.canvas.height;
    baseCtx = baseCanvas.getContext('2d');
    baseCtx.drawImage(snap.canvas, 0, 0);
    overlays = snap.overlays.map((o) => ({ ...o }));
    aiRegion = snap.aiRegion ? { ...snap.aiRegion } : null;
    selRect = snap.selRect ? { ...snap.selRect } : null;
    selLasso = snap.selLasso ? snap.selLasso.map((p) => ({ ...p })) : null;
    selectedOverlayId = null;
    redraw();
  }

  function pushUndo() {
    undoStack.push(captureSnapshot());
    if (undoStack.length > 25) undoStack.shift();
    redoStack = [];
  }

  function setTool(tool) {
    activeTool = tool;
    document.querySelectorAll('[data-img-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.imgTool === tool);
    });
    aiRegionBar.classList.toggle('hidden', tool !== 'ai-region' && !aiRegion);
    selBar.classList.toggle('hidden', tool !== 'marquee' && tool !== 'lasso' && !hasSelection());
    if (tool === 'pan') canvas.style.cursor = 'grab';
    else if (tool === 'select') canvas.style.cursor = 'default';
    else canvas.style.cursor = 'crosshair';
    redraw();
  }

  function renderLayersPanel() {
    layerCountEl.textContent = `${overlays.length}개`;
    const items = [];
    // Show top-most overlay first (Photoshop order)
    for (let i = overlays.length - 1; i >= 0; i--) {
      const o = overlays[i];
      const isAct = o.id === selectedOverlayId;
      items.push(`<div class="layer-item ${isAct ? 'active' : ''} ${o.visible === false ? 'hidden-layer' : ''}" data-layer-id="${o.id}">
        <div class="layer-row">
          <img class="layer-thumb" src="${o.img.src}" alt="" />
          <span class="layer-name" title="${o.name || '이미지'}">${o.name || '이미지'}</span>
        </div>
        <div class="layer-btns">
          <button data-l-act="vis" title="보이기/숨기기">${o.visible === false ? '🙈' : '👁'}</button>
          <button data-l-act="up" title="위로">▲</button>
          <button data-l-act="down" title="아래로">▼</button>
          <button data-l-act="dup" title="복제">📄</button>
          <button data-l-act="del" title="삭제">🗑️</button>
        </div>
      </div>`);
    }
    items.push(`<div class="layer-item ${!selectedOverlayId ? 'active' : ''}" data-layer-id="__base__">
      <div class="layer-row">
        <span style="font-size:15px">🖼️</span>
        <span class="layer-name">배경 (원본)</span>
      </div>
    </div>`);
    layersListEl.innerHTML = items.join('');

    layersListEl.querySelectorAll('.layer-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const id = item.dataset.layerId;
        if (id === '__base__') {
          selectedOverlayId = null;
          redraw();
        } else {
          selectedOverlayId = id;
          setTool('select');
        }
      });
      item.querySelectorAll('[data-l-act]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = item.dataset.layerId;
          const idx = overlays.findIndex((o) => o.id === id);
          if (idx === -1) return;
          const act = btn.dataset.lAct;
          pushUndo();
          if (act === 'vis') {
            overlays[idx].visible = overlays[idx].visible === false ? true : false;
          } else if (act === 'up' && idx < overlays.length - 1) {
            [overlays[idx], overlays[idx + 1]] = [overlays[idx + 1], overlays[idx]];
          } else if (act === 'down' && idx > 0) {
            [overlays[idx], overlays[idx - 1]] = [overlays[idx - 1], overlays[idx]];
          } else if (act === 'dup') {
            const orig = overlays[idx];
            const copy = {
              ...orig,
              id: `ov-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              name: `${orig.name || '레이어'} 복사`,
              x: orig.x + 20,
              y: orig.y + 20
            };
            overlays.splice(idx + 1, 0, copy);
            selectedOverlayId = copy.id;
          } else if (act === 'del') {
            overlays.splice(idx, 1);
            if (selectedOverlayId === id) selectedOverlayId = null;
          }
          redraw();
        });
      });
    });
  }

  function syncRotateBar() {
    const selectedOv = overlays.find((o) => o.id === selectedOverlayId);
    if (selectedOv) {
      const deg = Math.round(selectedOv.angle || 0);
      rotTargetEl.textContent = `레이어 회전 (${selectedOv.name || '이미지'})`;
      rotSlider.value = String(deg);
      rotInput.value = String(deg);
      btnRotApply.classList.add('hidden');
    } else {
      rotTargetEl.textContent = '배경 전체 회전';
      rotSlider.value = String(basePreviewAngle);
      rotInput.value = String(basePreviewAngle);
      btnRotApply.classList.remove('hidden');
    }
  }

  function updateInfo() {
    infoEl.textContent = `${baseCanvas.width} × ${baseCanvas.height}px · 레이어 ${overlays.length}개 · Ctrl+V로 QR/이미지 바로 붙여넣기`;
    if (aiRegion) {
      aiRegionCoords.textContent = `지정 영역: x=${Math.round(aiRegion.x)}, y=${Math.round(aiRegion.y)}, w=${Math.round(aiRegion.w)}, h=${Math.round(aiRegion.h)}`;
    } else {
      aiRegionCoords.textContent = '마우스로 수정할 영역을 드래그하세요';
    }
    if (selRect && selRect.w > 2 && selRect.h > 2) {
      selCoordsEl.textContent = `사각 선택: ${Math.round(selRect.w)} × ${Math.round(selRect.h)}px`;
      selBar.classList.remove('hidden');
    } else if (selLasso && selLasso.length >= 3) {
      const b = lassoBounds(selLasso);
      selCoordsEl.textContent = `자유 선택: ${Math.round(b.w)} × ${Math.round(b.h)}px (${selLasso.length}점)`;
      selBar.classList.remove('hidden');
    } else {
      selCoordsEl.textContent = activeTool === 'lasso'
        ? '마우스로 자유 영역을 그려 선택하세요'
        : '마우스로 사각 영역을 드래그해 선택하세요';
      if (activeTool !== 'marquee' && activeTool !== 'lasso') selBar.classList.add('hidden');
    }
    syncRotateBar();
    renderLayersPanel();
  }

  function renderComposite(targetCtx, includeUiGuides = false) {
    targetCtx.clearRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
    if (includeUiGuides && basePreviewAngle !== 0) {
      targetCtx.save();
      targetCtx.translate(targetCtx.canvas.width / 2, targetCtx.canvas.height / 2);
      targetCtx.rotate((basePreviewAngle * Math.PI) / 180);
      targetCtx.drawImage(baseCanvas, -baseCanvas.width / 2, -baseCanvas.height / 2);
      targetCtx.restore();
    } else {
      targetCtx.drawImage(baseCanvas, 0, 0);
    }

    for (const o of overlays) {
      if (o.visible === false) continue;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const rad = ((o.angle || 0) * Math.PI) / 180;

      targetCtx.save();
      targetCtx.translate(cx, cy);
      targetCtx.rotate(rad);
      targetCtx.drawImage(o.img, -o.w / 2, -o.h / 2, o.w, o.h);

      if (includeUiGuides && o.id === selectedOverlayId) {
        const lw = Math.max(2, baseCanvas.width / 450);
        targetCtx.strokeStyle = '#2563eb';
        targetCtx.lineWidth = lw;
        targetCtx.setLineDash([6, 4]);
        targetCtx.strokeRect(-o.w / 2, -o.h / 2, o.w, o.h);

        // bottom-right resize handle
        const hs = Math.max(12, baseCanvas.width / 80);
        targetCtx.setLineDash([]);
        targetCtx.fillStyle = '#2563eb';
        targetCtx.fillRect(o.w / 2 - hs, o.h / 2 - hs, hs, hs);

        // top-center rotation handle
        const stem = Math.max(22, baseCanvas.width / 45);
        const hr = Math.max(7, baseCanvas.width / 130);
        targetCtx.beginPath();
        targetCtx.moveTo(0, -o.h / 2);
        targetCtx.lineTo(0, -o.h / 2 - stem);
        targetCtx.stroke();
        targetCtx.beginPath();
        targetCtx.arc(0, -o.h / 2 - stem, hr, 0, Math.PI * 2);
        targetCtx.fillStyle = '#10b981';
        targetCtx.fill();
        targetCtx.strokeStyle = '#ffffff';
        targetCtx.lineWidth = Math.max(1.5, lw * 0.8);
        targetCtx.stroke();
      }
      targetCtx.restore();
    }

    if (includeUiGuides && selRect && selRect.w > 2 && selRect.h > 2) {
      targetCtx.save();
      targetCtx.strokeStyle = '#2563eb';
      targetCtx.lineWidth = Math.max(2, baseCanvas.width / 400);
      targetCtx.setLineDash([7, 5]);
      targetCtx.strokeRect(selRect.x, selRect.y, selRect.w, selRect.h);
      targetCtx.fillStyle = 'rgba(37, 99, 235, 0.12)';
      targetCtx.fillRect(selRect.x, selRect.y, selRect.w, selRect.h);
      targetCtx.restore();
    }

    if (includeUiGuides && selLasso && selLasso.length >= 2) {
      targetCtx.save();
      targetCtx.strokeStyle = '#2563eb';
      targetCtx.lineWidth = Math.max(2, baseCanvas.width / 400);
      targetCtx.setLineDash([7, 5]);
      targetCtx.beginPath();
      targetCtx.moveTo(selLasso[0].x, selLasso[0].y);
      for (let i = 1; i < selLasso.length; i++) {
        targetCtx.lineTo(selLasso[i].x, selLasso[i].y);
      }
      if (selLasso.length >= 3) targetCtx.closePath();
      targetCtx.fillStyle = 'rgba(37, 99, 235, 0.14)';
      targetCtx.fill();
      targetCtx.stroke();
      targetCtx.restore();
    }

    if (includeUiGuides && aiRegion && aiRegion.w > 2 && aiRegion.h > 2) {
      targetCtx.save();
      targetCtx.strokeStyle = '#ef4444';
      targetCtx.lineWidth = Math.max(3, baseCanvas.width / 350);
      targetCtx.setLineDash([10, 6]);
      targetCtx.strokeRect(aiRegion.x, aiRegion.y, aiRegion.w, aiRegion.h);
      targetCtx.fillStyle = 'rgba(239, 68, 68, 0.14)';
      targetCtx.fillRect(aiRegion.x, aiRegion.y, aiRegion.w, aiRegion.h);
      targetCtx.setLineDash([]);
      const fontSize = Math.max(16, Math.round(baseCanvas.width / 55));
      targetCtx.font = `bold ${fontSize}px "Malgun Gothic", sans-serif`;
      const label = 'AI 수정 영역';
      const tw = targetCtx.measureText(label).width + 14;
      const ly = Math.max(fontSize + 8, aiRegion.y);
      targetCtx.fillStyle = '#ef4444';
      targetCtx.fillRect(aiRegion.x, ly - fontSize - 8, tw, fontSize + 8);
      targetCtx.fillStyle = '#ffffff';
      targetCtx.fillText(label, aiRegion.x + 7, ly - 5);
      targetCtx.restore();
    }
  }

  function redraw(previewShape = null) {
    canvas.width = baseCanvas.width;
    canvas.height = baseCanvas.height;
    canvas.style.filter = currentFilterCss();
    renderComposite(ctx, true);
    applyZoomStyle();

    if (previewShape) {
      ctx.save();
      const { type, x1, y1, x2, y2 } = previewShape;
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);

      if (type === 'crop' || type === 'mosaic') {
        ctx.strokeStyle = type === 'crop' ? '#2563eb' : '#f59e0b';
        ctx.lineWidth = Math.max(2, baseCanvas.width / 400);
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = type === 'crop' ? 'rgba(37,99,235,0.12)' : 'rgba(245,158,11,0.18)';
        ctx.fillRect(x, y, w, h);
      } else if (type === 'rect') {
        ctx.strokeStyle = colorInput.value;
        ctx.lineWidth = Number(sizeInput.value) * Math.max(1, baseCanvas.width / 900);
        ctx.strokeRect(x, y, w, h);
      } else if (type === 'arrow') {
        drawArrow(ctx, x1, y1, x2, y2, colorInput.value, Number(sizeInput.value) * Math.max(1, baseCanvas.width / 900));
      }
      ctx.restore();
    }
    updateInfo();
  }

  function drawArrow(c, x1, y1, x2, y2, color, width) {
    const headLen = Math.max(14, width * 4);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    c.save();
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = width;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
    c.beginPath();
    c.moveTo(x2, y2);
    c.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    c.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    c.closePath();
    c.fill();
    c.restore();
  }

  function applyMosaic(x, y, w, h) {
    const ix = Math.max(0, Math.floor(x));
    const iy = Math.max(0, Math.floor(y));
    const iw = Math.min(baseCanvas.width - ix, Math.floor(w));
    const ih = Math.min(baseCanvas.height - iy, Math.floor(h));
    if (iw < 4 || ih < 4) return;
    const block = Math.max(8, Math.round(Math.min(iw, ih) / 10));
    const imgData = baseCtx.getImageData(ix, iy, iw, ih);
    const d = imgData.data;
    for (let by = 0; by < ih; by += block) {
      for (let bx = 0; bx < iw; bx += block) {
        let r = 0, g = 0, b = 0, cnt = 0;
        for (let py = by; py < Math.min(by + block, ih); py++) {
          for (let px = bx; px < Math.min(bx + block, iw); px++) {
            const idx = (py * iw + px) * 4;
            r += d[idx]; g += d[idx + 1]; b += d[idx + 2]; cnt++;
          }
        }
        r = Math.round(r / cnt); g = Math.round(g / cnt); b = Math.round(b / cnt);
        for (let py = by; py < Math.min(by + block, ih); py++) {
          for (let px = bx; px < Math.min(bx + block, iw); px++) {
            const idx = (py * iw + px) * 4;
            d[idx] = r; d[idx + 1] = g; d[idx + 2] = b;
          }
        }
      }
    }
    baseCtx.putImageData(imgData, ix, iy);
  }

  function addOverlayImage(img, name = '') {
    pushUndo();
    const maxDim = Math.min(baseCanvas.width, baseCanvas.height) * 0.35;
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (w > maxDim || h > maxDim) {
      const scale = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const id = `ov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    overlays.push({
      id,
      name: name || `이미지 ${layerSeq++}`,
      visible: true,
      img,
      x: Math.round((baseCanvas.width - w) / 2),
      y: Math.round((baseCanvas.height - h) / 2),
      w,
      h
    });
    selectedOverlayId = id;
    setTool('select');
    redraw();
  }

  function addOverlayFromFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => addOverlayImage(img, file.name || '붙여넣은 이미지');
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function canvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height
    };
  }

  function hitTestOverlay(pt) {
    const hs = Math.max(16, baseCanvas.width / 65);
    const stem = Math.max(22, baseCanvas.width / 45);
    const hr = Math.max(12, baseCanvas.width / 85);
    for (let i = overlays.length - 1; i >= 0; i--) {
      const o = overlays[i];
      if (o.visible === false) continue;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const rad = -((o.angle || 0) * Math.PI) / 180;
      const dx = pt.x - cx;
      const dy = pt.y - cy;
      // Transform mouse point into overlay's local unrotated coordinates
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad);

      if (o.id === selectedOverlayId && Math.hypot(lx, ly - (-o.h / 2 - stem)) <= hr) {
        return { overlay: o, mode: 'rotate' };
      }
      if (lx >= o.w / 2 - hs && lx <= o.w / 2 + 8 && ly >= o.h / 2 - hs && ly <= o.h / 2 + 8) {
        return { overlay: o, mode: 'resize' };
      }
      if (lx >= -o.w / 2 && lx <= o.w / 2 && ly >= -o.h / 2 && ly <= o.h / 2) {
        return { overlay: o, mode: 'move' };
      }
    }
    return null;
  }

  function floodFillTransparent(targetCanvas, startX, startY, tolerance = 36) {
    const tCtx = targetCanvas.getContext('2d');
    const w = targetCanvas.width;
    const h = targetCanvas.height;
    const sx = Math.max(0, Math.min(w - 1, Math.floor(startX)));
    const sy = Math.max(0, Math.min(h - 1, Math.floor(startY)));
    const imgData = tCtx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const startIdx = (sy * w + sx) * 4;
    const sr = d[startIdx], sg = d[startIdx + 1], sb = d[startIdx + 2], sa = d[startIdx + 3];
    if (sa === 0) return;

    const visited = new Uint8Array(w * h);
    const stack = [sx, sy];
    const tolSq = tolerance * tolerance * 3;

    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      const pos = y * w + x;
      if (visited[pos]) continue;
      visited[pos] = 1;

      const idx = pos * 4;
      if (d[idx + 3] === 0) continue;
      const dr = d[idx] - sr;
      const dg = d[idx + 1] - sg;
      const db = d[idx + 2] - sb;
      if (dr * dr + dg * dg + db * db <= tolSq) {
        d[idx + 3] = 0;
        if (x > 0 && !visited[pos - 1]) { stack.push(x - 1, y); }
        if (x < w - 1 && !visited[pos + 1]) { stack.push(x + 1, y); }
        if (y > 0 && !visited[pos - w]) { stack.push(x, y - 1); }
        if (y < h - 1 && !visited[pos + w]) { stack.push(x, y + 1); }
      }
    }
    tCtx.putImageData(imgData, 0, 0);
  }

  function removeWhiteFromCanvas(targetCanvas, threshold = 238) {
    const tCtx = targetCanvas.getContext('2d');
    const imgData = tCtx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] >= threshold && d[i + 1] >= threshold && d[i + 2] >= threshold) {
        d[i + 3] = 0;
      }
    }
    tCtx.putImageData(imgData, 0, 0);
  }

  function imgToCanvas(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  }

  function canvasToImage(c) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = c.toDataURL('image/png');
    });
  }

  function strokeFreehand(targetCtx, x1, y1, x2, y2, mode) {
    const radius = Math.max(2, Number(sizeInput.value) * Math.max(1, baseCanvas.width / 650));
    targetCtx.save();
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    targetCtx.lineWidth = radius * 2;
    if (mode === 'eraser') {
      targetCtx.globalCompositeOperation = 'destination-out';
      targetCtx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.strokeStyle = colorInput.value;
    }
    targetCtx.beginPath();
    targetCtx.moveTo(x1, y1);
    targetCtx.lineTo(x2, y2);
    targetCtx.stroke();
    targetCtx.restore();
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  // Mouse wheel zoom on canvas area
  canvasWrap.addEventListener('wheel', (e) => {
    if (modal.classList.contains('hidden')) return;
    e.preventDefault();
    const prevZoom = zoomLevel;
    const step = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    let nextZoom = Number((prevZoom * step).toFixed(2));
    if (nextZoom < 0.5) nextZoom = 0.5;
    if (nextZoom > 6) nextZoom = 6;
    if (Math.abs(nextZoom - 1) < 0.06) nextZoom = 1;

    const rect = canvasWrap.getBoundingClientRect();
    const cx = e.clientX - rect.left + canvasWrap.scrollLeft;
    const cy = e.clientY - rect.top + canvasWrap.scrollTop;
    const ratio = nextZoom / prevZoom;

    zoomLevel = nextZoom;
    applyZoomStyle();
    if (nextZoom !== 1) {
      canvasWrap.scrollLeft = Math.max(0, cx * ratio - (e.clientX - rect.left));
      canvasWrap.scrollTop = Math.max(0, cy * ratio - (e.clientY - rect.top));
    }
  }, { passive: false });

  function startPan(e) {
    panState = {
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: canvasWrap.scrollLeft,
      scrollTop: canvasWrap.scrollTop
    };
    canvas.style.cursor = 'grabbing';
  }

  canvasWrap.addEventListener('mousedown', (e) => {
    if (e.target === canvasWrap && e.button === 0) {
      startPan(e);
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    // Middle mouse, Space+drag, or Pan tool -> pan viewport
    if (e.button === 1 || spaceDown || activeTool === 'pan') {
      e.preventDefault();
      startPan(e);
      return;
    }

    const pt = canvasCoords(e);
    if (activeTool === 'eyedropper') {
      const px = ctx.getImageData(Math.floor(pt.x), Math.floor(pt.y), 1, 1).data;
      colorInput.value = rgbToHex(px[0], px[1], px[2]);
      infoEl.textContent = `스포이드 색상 추출: ${colorInput.value}`;
      return;
    }

    if (activeTool === 'lasso') {
      selRect = null;
      selLasso = [pt];
      dragState = { kind: 'lasso' };
      redraw();
      return;
    }

    if (activeTool === 'marquee') {
      selLasso = null;
      selRect = { x: pt.x, y: pt.y, w: 0, h: 0 };
      dragState = { kind: 'marquee', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
      redraw();
      return;
    }

    if (activeTool === 'eraser' || activeTool === 'brush') {
      pushUndo();
      strokeFreehand(baseCtx, pt.x, pt.y, pt.x + 0.1, pt.y + 0.1, activeTool);
      dragState = { kind: activeTool, lastX: pt.x, lastY: pt.y };
      redraw();
      return;
    }

    if (activeTool === 'wand') {
      const tol = Math.max(15, Number(sizeInput.value) * 8);
      const hit = hitTestOverlay(pt);
      pushUndo();
      if (hit) {
        const o = hit.overlay;
        const c = imgToCanvas(o.img);
        const lx = ((pt.x - o.x) / o.w) * c.width;
        const ly = ((pt.y - o.y) / o.h) * c.height;
        floodFillTransparent(c, lx, ly, tol);
        canvasToImage(c).then((newImg) => { o.img = newImg; redraw(); });
      } else {
        floodFillTransparent(baseCanvas, pt.x, pt.y, tol);
        redraw();
      }
      return;
    }

    if (activeTool === 'select') {
      const hit = hitTestOverlay(pt);
      if (hit) {
        pushUndo();
        selectedOverlayId = hit.overlay.id;
        dragState = {
          kind: hit.mode,
          overlay: hit.overlay,
          startX: pt.x,
          startY: pt.y,
          origX: hit.overlay.x,
          origY: hit.overlay.y,
          origW: hit.overlay.w,
          origH: hit.overlay.h
        };
        redraw();
      } else {
        selectedOverlayId = null;
        redraw();
        // Dragging empty area in select mode pans the viewport smoothly
        startPan(e);
      }
      return;
    }

    if (activeTool === 'text') {
      window.qdirPrompt('입력할 텍스트:').then((text) => {
        if (!text) return;
        pushUndo();
        const fontSize = Math.max(18, Number(sizeInput.value) * 6 * Math.max(1, baseCanvas.width / 900));
        baseCtx.save();
        baseCtx.font = `bold ${Math.round(fontSize)}px "Malgun Gothic", sans-serif`;
        baseCtx.fillStyle = colorInput.value;
        baseCtx.fillText(text, pt.x, pt.y);
        baseCtx.restore();
        redraw();
      });
      return;
    }

    dragState = { kind: activeTool, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
  });

  window.addEventListener('mousemove', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (panState) {
      canvasWrap.scrollLeft = panState.scrollLeft - (e.clientX - panState.startX);
      canvasWrap.scrollTop = panState.scrollTop - (e.clientY - panState.startY);
      return;
    }
    if (!dragState) return;
    const pt = canvasCoords(e);
    if (dragState.kind === 'lasso') {
      const last = selLasso[selLasso.length - 1];
      if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= 3) {
        selLasso.push(pt);
        redraw();
      }
      return;
    }
    if (dragState.kind === 'eraser' || dragState.kind === 'brush') {
      strokeFreehand(baseCtx, dragState.lastX, dragState.lastY, pt.x, pt.y, dragState.kind);
      dragState.lastX = pt.x;
      dragState.lastY = pt.y;
      redraw();
      return;
    }
    if (dragState.kind === 'rotate') {
      const o = dragState.overlay;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      let deg = (Math.atan2(pt.y - cy, pt.x - cx) * 180) / Math.PI + 90;
      if (deg > 180) deg -= 360;
      if (deg < -180) deg += 360;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      o.angle = Math.round(deg);
      redraw();
      return;
    }
    if (dragState.kind === 'move') {
      dragState.overlay.x = Math.round(dragState.origX + (pt.x - dragState.startX));
      dragState.overlay.y = Math.round(dragState.origY + (pt.y - dragState.startY));
      redraw();
    } else if (dragState.kind === 'resize') {
      const dw = pt.x - dragState.startX;
      const dh = pt.y - dragState.startY;
      const ratio = dragState.origW / Math.max(1, dragState.origH);
      let newW = Math.max(20, Math.round(dragState.origW + dw));
      let newH = e.shiftKey ? Math.max(20, Math.round(dragState.origH + dh)) : Math.max(20, Math.round(newW / ratio));
      dragState.overlay.w = newW;
      dragState.overlay.h = newH;
      redraw();
    } else {
      dragState.x2 = pt.x;
      dragState.y2 = pt.y;
      if (dragState.kind === 'ai-region') {
        aiRegion = {
          x: Math.min(dragState.x1, dragState.x2),
          y: Math.min(dragState.y1, dragState.y2),
          w: Math.abs(dragState.x2 - dragState.x1),
          h: Math.abs(dragState.y2 - dragState.y1)
        };
        redraw();
      } else if (dragState.kind === 'marquee') {
        selRect = {
          x: Math.min(dragState.x1, dragState.x2),
          y: Math.min(dragState.y1, dragState.y2),
          w: Math.abs(dragState.x2 - dragState.x1),
          h: Math.abs(dragState.y2 - dragState.y1)
        };
        redraw();
      } else {
        redraw({ type: dragState.kind, x1: dragState.x1, y1: dragState.y1, x2: dragState.x2, y2: dragState.y2 });
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (panState) {
      panState = null;
      canvas.style.cursor = (spaceDown || activeTool === 'pan') ? 'grab' : activeTool === 'select' ? 'default' : 'crosshair';
      return;
    }
    if (!dragState) return;
    const d = dragState;
    dragState = null;

    if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'rotate' || d.kind === 'ai-region' || d.kind === 'marquee' || d.kind === 'lasso' || d.kind === 'eraser' || d.kind === 'brush') {
      redraw();
      return;
    }

    const x = Math.min(d.x1, d.x2);
    const y = Math.min(d.y1, d.y2);
    const w = Math.abs(d.x2 - d.x1);
    const h = Math.abs(d.y2 - d.y1);
    if (w < 4 && h < 4) return redraw();

    pushUndo();
    if (d.kind === 'crop') {
      // Flatten overlays first so crop preserves pasted images
      const flat = document.createElement('canvas');
      flat.width = baseCanvas.width;
      flat.height = baseCanvas.height;
      renderComposite(flat.getContext('2d'), false);
      overlays = [];
      selectedOverlayId = null;
      aiRegion = null;
      baseCanvas.width = Math.max(1, Math.round(w));
      baseCanvas.height = Math.max(1, Math.round(h));
      baseCtx = baseCanvas.getContext('2d');
      baseCtx.drawImage(flat, x, y, w, h, 0, 0, baseCanvas.width, baseCanvas.height);
    } else if (d.kind === 'mosaic') {
      applyMosaic(x, y, w, h);
    } else if (d.kind === 'rect') {
      baseCtx.save();
      baseCtx.strokeStyle = colorInput.value;
      baseCtx.lineWidth = Number(sizeInput.value) * Math.max(1, baseCanvas.width / 900);
      baseCtx.strokeRect(x, y, w, h);
      baseCtx.restore();
    } else if (d.kind === 'arrow') {
      drawArrow(baseCtx, d.x1, d.y1, d.x2, d.y2, colorInput.value, Number(sizeInput.value) * Math.max(1, baseCanvas.width / 900));
    }
    redraw();
  });

  // When returning from another window (e.g., copying a QR code externally), prefer system clipboard
  window.addEventListener('focus', () => {
    if (internalClipboard) internalClipboard.prefer = false;
  });

  async function writeCanvasToSystemClipboard(canvasEl) {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
      const blob = await new Promise((resolve) => canvasEl.toBlob(resolve, 'image/png'));
      if (blob) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      }
    } catch {
      // Fallback safely to internalClipboard
    }
  }

  // Paste image from internal editor clipboard (when freshly copied/cut inside editor) or system clipboard
  window.addEventListener('paste', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (document.activeElement === aiNoteInput) return;

    if (internalClipboard?.prefer && internalClipboard?.dataUrl) {
      e.preventDefault();
      pasteInternalClipboard();
      return;
    }

    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        addOverlayFromFile(item.getAsFile());
        return;
      }
    }
    if (internalClipboard?.dataUrl) {
      e.preventDefault();
      pasteInternalClipboard();
    }
  });

  function pasteInternalClipboard() {
    if (!internalClipboard?.dataUrl) return;
    const clip = internalClipboard;
    const img = new Image();
    img.onload = () => {
      pushUndo();
      const id = `ov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      overlays.push({
        id,
        name: `${clip.name || '복사본'} ${layerSeq++}`,
        visible: true,
        img,
        x: Math.round((baseCanvas.width - clip.w) / 2) + 12,
        y: Math.round((baseCanvas.height - clip.h) / 2) + 12,
        w: clip.w,
        h: clip.h
      });
      selectedOverlayId = id;
      setTool('select');
      redraw();
    };
    img.src = clip.dataUrl;
  }

  function copyOrCutInEditor(isCut) {
    if (hasSelection()) {
      const isLasso = Boolean(selLasso && selLasso.length >= 3);
      const bounds = isLasso ? lassoBounds(selLasso) : selRect;
      const x = Math.max(0, Math.round(bounds.x));
      const y = Math.max(0, Math.round(bounds.y));
      const w = Math.min(baseCanvas.width - x, Math.round(bounds.w));
      const h = Math.min(baseCanvas.height - y, Math.round(bounds.h));
      if (w < 2 || h < 2) return;

      const piece = document.createElement('canvas');
      piece.width = w;
      piece.height = h;
      const pCtx = piece.getContext('2d');
      if (isLasso) {
        pCtx.save();
        buildLassoPath(pCtx, selLasso, x, y);
        pCtx.clip();
        pCtx.drawImage(baseCanvas, x, y, w, h, 0, 0, w, h);
        pCtx.restore();
      } else {
        pCtx.drawImage(baseCanvas, x, y, w, h, 0, 0, w, h);
      }
      internalClipboard = { dataUrl: piece.toDataURL('image/png'), name: isCut ? '잘라낸 영역' : '복사한 영역', w, h, prefer: true };
      writeCanvasToSystemClipboard(piece);

      if (isCut) {
        pushUndo();
        if (isLasso) {
          baseCtx.save();
          baseCtx.globalCompositeOperation = 'destination-out';
          buildLassoPath(baseCtx, selLasso);
          baseCtx.fill();
          baseCtx.restore();
          selLasso = null;
        } else {
          baseCtx.clearRect(x, y, w, h);
          selRect = null;
        }
        redraw();
      }
      infoEl.textContent = isCut ? '선택 영역을 잘라냈습니다 (Ctrl+V로 붙여넣기)' : '선택 영역을 복사했습니다 (Ctrl+V로 붙여넣기)';
      return;
    }

    const selectedOv = overlays.find((o) => o.id === selectedOverlayId);
    if (selectedOv) {
      internalClipboard = {
        dataUrl: selectedOv.img.src,
        name: selectedOv.name || '레이어',
        w: selectedOv.w,
        h: selectedOv.h,
        prefer: true
      };
      writeCanvasToSystemClipboard(imgToCanvas(selectedOv.img));
      if (isCut) {
        pushUndo();
        overlays = overlays.filter((o) => o.id !== selectedOverlayId);
        selectedOverlayId = null;
        redraw();
      }
      infoEl.textContent = isCut ? '레이어를 잘라냈습니다 (Ctrl+V로 붙여넣기)' : '레이어를 복사했습니다 (Ctrl+V로 붙여넣기)';
    }
  }

  window.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (document.activeElement === aiNoteInput) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (e.code === 'Space' && !spaceDown) {
      e.preventDefault();
      spaceDown = true;
      if (!panState) canvas.style.cursor = 'grab';
      return;
    }
    if (ctrl && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (ctrl && key === 'c') {
      e.preventDefault();
      copyOrCutInEditor(false);
    } else if (ctrl && key === 'x') {
      e.preventDefault();
      copyOrCutInEditor(true);
    } else if (ctrl && key === 's') {
      e.preventDefault();
      document.getElementById('btnImgSave')?.click();
    } else if (ctrl && key === 'a') {
      e.preventDefault();
      selLasso = null;
      selRect = { x: 0, y: 0, w: baseCanvas.width, h: baseCanvas.height };
      redraw();
    } else if ((ctrl && key === 'd') || (e.key === 'Escape' && hasSelection())) {
      e.preventDefault();
      selRect = null;
      selLasso = null;
      redraw();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection()) {
      e.preventDefault();
      deleteSelectionArea();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedOverlayId) {
      e.preventDefault();
      pushUndo();
      overlays = overlays.filter((o) => o.id !== selectedOverlayId);
      selectedOverlayId = null;
      redraw();
    } else if (selectedOverlayId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const ov = overlays.find((o) => o.id === selectedOverlayId);
      if (!ov) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowUp') ov.y -= step;
      if (e.key === 'ArrowDown') ov.y += step;
      if (e.key === 'ArrowLeft') ov.x -= step;
      if (e.key === 'ArrowRight') ov.x += step;
      redraw();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      if (!panState) {
        canvas.style.cursor = activeTool === 'pan' ? 'grab' : activeTool === 'select' ? 'default' : 'crosshair';
      }
    }
  });

  function buildLassoPath(targetCtx, pts, offsetX = 0, offsetY = 0) {
    targetCtx.beginPath();
    targetCtx.moveTo(pts[0].x - offsetX, pts[0].y - offsetY);
    for (let i = 1; i < pts.length; i++) {
      targetCtx.lineTo(pts[i].x - offsetX, pts[i].y - offsetY);
    }
    targetCtx.closePath();
  }

  function deleteSelectionArea() {
    if (!hasSelection()) return;
    pushUndo();
    if (selLasso && selLasso.length >= 3) {
      baseCtx.save();
      baseCtx.globalCompositeOperation = 'destination-out';
      buildLassoPath(baseCtx, selLasso);
      baseCtx.fill();
      baseCtx.restore();
      selLasso = null;
    } else if (selRect) {
      baseCtx.clearRect(selRect.x, selRect.y, selRect.w, selRect.h);
      selRect = null;
    }
    redraw();
  }

  async function extractSelectionToLayer(cut = false) {
    if (!hasSelection()) return;
    const isLasso = Boolean(selLasso && selLasso.length >= 3);
    const bounds = isLasso ? lassoBounds(selLasso) : selRect;
    const x = Math.max(0, Math.round(bounds.x));
    const y = Math.max(0, Math.round(bounds.y));
    const w = Math.min(baseCanvas.width - x, Math.round(bounds.w));
    const h = Math.min(baseCanvas.height - y, Math.round(bounds.h));
    if (w < 2 || h < 2) return;

    pushUndo();
    const piece = document.createElement('canvas');
    piece.width = w;
    piece.height = h;
    const pCtx = piece.getContext('2d');
    if (isLasso) {
      pCtx.save();
      buildLassoPath(pCtx, selLasso, x, y);
      pCtx.clip();
      pCtx.drawImage(baseCanvas, x, y, w, h, 0, 0, w, h);
      pCtx.restore();
      if (cut) {
        baseCtx.save();
        baseCtx.globalCompositeOperation = 'destination-out';
        buildLassoPath(baseCtx, selLasso);
        baseCtx.fill();
        baseCtx.restore();
      }
    } else {
      pCtx.drawImage(baseCanvas, x, y, w, h, 0, 0, w, h);
      if (cut) baseCtx.clearRect(x, y, w, h);
    }

    const img = await canvasToImage(piece);
    const id = `ov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    overlays.push({
      id,
      name: cut ? `오려낸 영역 ${layerSeq++}` : `복제 영역 ${layerSeq++}`,
      visible: true,
      img,
      x: cut ? x : x + 16,
      y: cut ? y : y + 16,
      w,
      h
    });
    selectedOverlayId = id;
    selRect = null;
    selLasso = null;
    setTool('select');
    redraw();
  }

  document.getElementById('btnSelCopyLayer').addEventListener('click', () => extractSelectionToLayer(false));
  document.getElementById('btnSelCutLayer').addEventListener('click', () => extractSelectionToLayer(true));
  document.getElementById('btnSelDelete').addEventListener('click', deleteSelectionArea);
  document.getElementById('btnSelMosaic').addEventListener('click', () => {
    if (!hasSelection()) return;
    const bounds = (selLasso && selLasso.length >= 3) ? lassoBounds(selLasso) : selRect;
    if (bounds.w < 4 || bounds.h < 4) return;
    pushUndo();
    applyMosaic(bounds.x, bounds.y, bounds.w, bounds.h);
    redraw();
  });
  document.getElementById('btnSelCrop').addEventListener('click', () => {
    if (!hasSelection()) return;
    const isLasso = Boolean(selLasso && selLasso.length >= 3);
    const bounds = isLasso ? lassoBounds(selLasso) : selRect;
    if (bounds.w < 4 || bounds.h < 4) return;
    pushUndo();
    const flat = document.createElement('canvas');
    flat.width = baseCanvas.width;
    flat.height = baseCanvas.height;
    renderComposite(flat.getContext('2d'), false);
    const { x, y, w, h } = bounds;
    const lassoCopy = isLasso ? selLasso.map((p) => ({ ...p })) : null;
    overlays = [];
    selectedOverlayId = null;
    selRect = null;
    selLasso = null;
    aiRegion = null;
    baseCanvas.width = Math.max(1, Math.round(w));
    baseCanvas.height = Math.max(1, Math.round(h));
    baseCtx = baseCanvas.getContext('2d');
    if (lassoCopy) {
      baseCtx.save();
      buildLassoPath(baseCtx, lassoCopy, x, y);
      baseCtx.clip();
      baseCtx.drawImage(flat, x, y, w, h, 0, 0, baseCanvas.width, baseCanvas.height);
      baseCtx.restore();
    } else {
      baseCtx.drawImage(flat, x, y, w, h, 0, 0, baseCanvas.width, baseCanvas.height);
    }
    redraw();
  });
  document.getElementById('btnSelClear').addEventListener('click', () => {
    selRect = null;
    selLasso = null;
    redraw();
  });

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(captureSnapshot());
    restoreSnapshot(undoStack.pop());
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(captureSnapshot());
    restoreSnapshot(redoStack.pop());
  }

  // Toolbar buttons
  document.querySelectorAll('[data-img-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.imgTool));
  });

  document.getElementById('btnImgAddOverlay').addEventListener('click', () => overlayInput.click());
  overlayInput.addEventListener('change', () => {
    if (overlayInput.files?.[0]) addOverlayFromFile(overlayInput.files[0]);
    overlayInput.value = '';
  });

  function applyAngleValue(deg) {
    const clamped = Math.max(-180, Math.min(180, Number(deg) || 0));
    rotSlider.value = String(clamped);
    rotInput.value = String(clamped);
    const selectedOv = overlays.find((o) => o.id === selectedOverlayId);
    if (selectedOv) {
      selectedOv.angle = clamped;
      redraw();
    } else {
      basePreviewAngle = clamped;
      redraw();
    }
  }

  function applyBaseRotation(deg) {
    const angle = Number(deg) || 0;
    if (angle === 0) return;
    pushUndo();
    const flat = document.createElement('canvas');
    flat.width = baseCanvas.width;
    flat.height = baseCanvas.height;
    basePreviewAngle = 0;
    renderComposite(flat.getContext('2d'), false);
    overlays = [];
    selectedOverlayId = null;

    const rad = (angle * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const newW = Math.max(1, Math.round(flat.width * cos + flat.height * sin));
    const newH = Math.max(1, Math.round(flat.width * sin + flat.height * cos));

    baseCanvas.width = newW;
    baseCanvas.height = newH;
    baseCtx = baseCanvas.getContext('2d');
    baseCtx.save();
    baseCtx.translate(newW / 2, newH / 2);
    baseCtx.rotate(rad);
    baseCtx.drawImage(flat, -flat.width / 2, -flat.height / 2);
    baseCtx.restore();
    rotSlider.value = '0';
    rotInput.value = '0';
    redraw();
  }

  document.getElementById('btnImgRotate').addEventListener('click', () => {
    rotateBar.classList.toggle('hidden');
    syncRotateBar();
  });

  rotSlider.addEventListener('mousedown', () => {
    if (overlays.find((o) => o.id === selectedOverlayId)) pushUndo();
  });
  rotSlider.addEventListener('input', () => applyAngleValue(rotSlider.value));
  rotInput.addEventListener('change', () => {
    if (overlays.find((o) => o.id === selectedOverlayId)) pushUndo();
    applyAngleValue(rotInput.value);
  });
  document.getElementById('btnRotM90').addEventListener('click', () => {
    const cur = Number(rotInput.value) || 0;
    let next = cur - 90;
    if (next < -180) next += 360;
    if (overlays.find((o) => o.id === selectedOverlayId)) pushUndo();
    applyAngleValue(next);
  });
  document.getElementById('btnRot0').addEventListener('click', () => {
    if (overlays.find((o) => o.id === selectedOverlayId)) pushUndo();
    applyAngleValue(0);
  });
  document.getElementById('btnRotP90').addEventListener('click', () => {
    const cur = Number(rotInput.value) || 0;
    let next = cur + 90;
    if (next > 180) next -= 360;
    if (overlays.find((o) => o.id === selectedOverlayId)) pushUndo();
    applyAngleValue(next);
  });
  btnRotApply.addEventListener('click', () => applyBaseRotation(basePreviewAngle));

  function flipBase(horizontal) {
    pushUndo();
    const flat = document.createElement('canvas');
    flat.width = baseCanvas.width;
    flat.height = baseCanvas.height;
    renderComposite(flat.getContext('2d'), false);
    overlays = [];
    selectedOverlayId = null;
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    baseCtx.save();
    if (horizontal) {
      baseCtx.translate(baseCanvas.width, 0);
      baseCtx.scale(-1, 1);
    } else {
      baseCtx.translate(0, baseCanvas.height);
      baseCtx.scale(1, -1);
    }
    baseCtx.drawImage(flat, 0, 0);
    baseCtx.restore();
    redraw();
  }

  document.getElementById('btnImgFlipH').addEventListener('click', () => flipBase(true));
  document.getElementById('btnImgFlipV').addEventListener('click', () => flipBase(false));

  document.getElementById('btnImgAdjustToggle').addEventListener('click', () => {
    adjustBar.classList.toggle('hidden');
  });

  [adjBright, adjContrast, adjSaturate].forEach((inp) => {
    inp.addEventListener('input', () => {
      canvas.style.filter = currentFilterCss();
    });
  });

  document.getElementById('btnAdjReset').addEventListener('click', () => {
    adjBright.value = '100';
    adjContrast.value = '100';
    adjSaturate.value = '100';
    canvas.style.filter = 'none';
  });

  document.getElementById('btnAdjApply').addEventListener('click', () => {
    const filter = currentFilterCss();
    if (filter === 'none') return;
    pushUndo();
    const tmp = document.createElement('canvas');
    tmp.width = baseCanvas.width;
    tmp.height = baseCanvas.height;
    const tCtx = tmp.getContext('2d');
    tCtx.filter = filter;
    tCtx.drawImage(baseCanvas, 0, 0);
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    baseCtx.drawImage(tmp, 0, 0);
    adjBright.value = '100';
    adjContrast.value = '100';
    adjSaturate.value = '100';
    canvas.style.filter = 'none';
    redraw();
  });

  document.getElementById('btnImgZoomIn').addEventListener('click', () => {
    zoomLevel = Math.min(4, zoomLevel <= 1 ? 1.25 : Number((zoomLevel + 0.25).toFixed(2)));
    applyZoomStyle();
  });
  document.getElementById('btnImgZoomOut').addEventListener('click', () => {
    zoomLevel = Math.max(1, Number((zoomLevel - 0.25).toFixed(2)));
    applyZoomStyle();
  });
  document.getElementById('btnImgZoomReset').addEventListener('click', () => {
    zoomLevel = 1;
    applyZoomStyle();
  });

  document.getElementById('btnImgResize').addEventListener('click', async () => {
    const input = await window.qdirPrompt(`새 가로 크기(px) 입력 (현재 ${baseCanvas.width}×${baseCanvas.height}):`, String(baseCanvas.width));
    const newW = Number(input);
    if (!newW || newW < 16 || newW > 8000) return;
    const newH = Math.max(1, Math.round((baseCanvas.height * newW) / baseCanvas.width));
    pushUndo();
    const flat = document.createElement('canvas');
    flat.width = baseCanvas.width;
    flat.height = baseCanvas.height;
    renderComposite(flat.getContext('2d'), false);
    overlays = [];
    selectedOverlayId = null;
    baseCanvas.width = newW;
    baseCanvas.height = newH;
    baseCtx = baseCanvas.getContext('2d');
    baseCtx.drawImage(flat, 0, 0, newW, newH);
    redraw();
  });

  document.getElementById('btnImgUndo').addEventListener('click', undo);

  document.getElementById('btnImgRemoveWhite').addEventListener('click', async () => {
    const selectedOv = overlays.find((o) => o.id === selectedOverlayId);
    pushUndo();
    if (selectedOv) {
      const c = imgToCanvas(selectedOv.img);
      removeWhiteFromCanvas(c, 235);
      selectedOv.img = await canvasToImage(c);
    } else {
      removeWhiteFromCanvas(baseCanvas, 235);
    }
    redraw();
  });

  document.getElementById('btnImgAiCutout').addEventListener('click', async () => {
    const btn = document.getElementById('btnImgAiCutout');
    const selectedOv = overlays.find((o) => o.id === selectedOverlayId);
    const targetLabel = selectedOv ? '선택한 얹은 이미지' : '메인 이미지';
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ AI 누끼 중...';
    infoEl.textContent = `${targetLabel} AI 누끼 처리 중... (첫 실행 시 모델 다운로드로 10~30초 걸릴 수 있습니다)`;
    try {
      const srcCanvas = selectedOv ? imgToCanvas(selectedOv.img) : baseCanvas;
      const res = await fetch('/api/image/remove-bg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl: srcCanvas.toDataURL('image/png') })
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);

      pushUndo();
      const newImg = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('결과 이미지 로드 실패'));
        img.src = res.dataUrl;
      });
      if (selectedOv) {
        selectedOv.img = newImg;
      } else {
        baseCanvas.width = newImg.naturalWidth;
        baseCanvas.height = newImg.naturalHeight;
        baseCtx = baseCanvas.getContext('2d');
        baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
        baseCtx.drawImage(newImg, 0, 0);
      }
      redraw();
    } catch (err) {
      alert(`AI 누끼 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = prevText;
      updateInfo();
    }
  });

  document.getElementById('btnImgSave').addEventListener('click', async () => {
    const out = document.createElement('canvas');
    out.width = baseCanvas.width;
    out.height = baseCanvas.height;
    renderComposite(out.getContext('2d'), false);
    const dataUrl = out.toDataURL('image/png');
    const defaultName = (currentPath.split(/[\\/]/).pop() || 'image.png').replace(/\.[^.]+$/, '') + '_edited.png';
    const fileName = await window.qdirPrompt('저장할 파일명 (같은 폴더에 저장됩니다):', defaultName);
    if (!fileName) return;
    try {
      const res = await fetch('/api/image/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ originalPath: currentPath, dataUrl, fileName })
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);
      alert(`저장 완료!\n${res.savedPath}`);
    } catch (err) {
      alert(`저장 실패: ${err.message}`);
    }
  });

  document.getElementById('btnImgSendAiRegion').addEventListener('click', async () => {
    if (!aiRegion || aiRegion.w < 4 || aiRegion.h < 4) {
      return alert('먼저 [🤖 AI 수정영역] 도구로 수정할 부분을 마우스로 드래그해 지정해 주세요.');
    }
    const note = aiNoteInput.value.trim();
    const annotated = document.createElement('canvas');
    annotated.width = baseCanvas.width;
    annotated.height = baseCanvas.height;
    selectedOverlayId = null;
    renderComposite(annotated.getContext('2d'), true);
    const annotatedDataUrl = annotated.toDataURL('image/png');

    try {
      const res = await fetch('/api/image/ai-region', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalPath: currentPath,
          annotatedDataUrl,
          region: aiRegion,
          note
        })
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);

      const promptText = `핀해둔 포스터(${res.originalPath})에서 빨간 박스로 표시한 영역(${res.note})을 수정해줘. 참조 이미지: ${res.annotatedPath}`;
      try { await navigator.clipboard.writeText(promptText); } catch {}
      alert('AI 수정 요청이 [📌 AI 전달 경로]에 등록되고 클립보드에도 복사되었습니다!\n채팅창에서 바로 "핀한 포스터 수정해줘"라고 지시하세요.');
    } catch (err) {
      alert(`전달 실패: ${err.message}`);
    }
  });

  document.getElementById('btnImgClearRegion').addEventListener('click', () => {
    aiRegion = null;
    redraw();
  });

  const editorCard = modal.querySelector('.editor-card');
  const btnMaximize = document.getElementById('btnImgMaximize');
  btnMaximize?.addEventListener('click', () => {
    const isMax = editorCard.classList.toggle('maximized');
    btnMaximize.textContent = isMax ? '🗗' : '⛶';
    btnMaximize.title = isMax ? '원래 크기로 복원' : '편집 창 최대화';
  });

  document.getElementById('btnCloseImgEditor').addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  window.openImageEditor = function (filePath) {
    currentPath = filePath;
    undoStack = [];
    redoStack = [];
    overlays = [];
    selectedOverlayId = null;
    aiRegion = null;
    selRect = null;
    selLasso = null;
    basePreviewAngle = 0;
    layerSeq = 1;
    zoomLevel = 1;
    aiNoteInput.value = '';
    titleEl.textContent = `✏️ 이미지 편집 — ${filePath.split(/[\\/]/).pop()}`;
    modal.classList.remove('hidden');

    const img = new Image();
    img.onload = () => {
      baseCanvas.width = img.naturalWidth;
      baseCanvas.height = img.naturalHeight;
      baseCtx = baseCanvas.getContext('2d');
      baseCtx.drawImage(img, 0, 0);
      setTool('select');
      redraw();
    };
    img.onerror = () => alert('이미지를 불러올 수 없습니다.');
    img.src = `/api/raw?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
  };
})();
