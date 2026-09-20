'use strict';
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const cursorsEl = document.getElementById('cursors');
const textEdit = document.getElementById('textEdit');

const uid = () => Math.random().toString(36).slice(2, 10);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- state ----------
let objects = [];
let cam = { x: 0, y: 0, zoom: 1 };
let tool = 'select';
let strokeW = 4;
let selected = new Set();
let undoStack = [], redoStack = [];
let selfId = null, selfName = '';
let users = [];
let remoteCursors = new Map();
let editingBy = new Map(); // objId -> { name, by, at } : who is live-typing where
let drawing = null, dragOp = null, rubber = null;
let spaceDown = false, editingId = null;

// ---------- canvas sizing ----------
let DPR = 1, W = 0, H = 0;
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.parentElement.getBoundingClientRect();
  W = r.width; H = r.height;
  canvas.width = W * DPR; canvas.height = H * DPR;
  render();
}
window.addEventListener('resize', resize);

// ---------- transforms ----------
const s2w = (sx, sy) => ({ x: (sx - W / 2) / cam.zoom + cam.x, y: (sy - H / 2) / cam.zoom + cam.y });
const w2s = (wx, wy) => ({ x: (wx - cam.x) * cam.zoom + W / 2, y: (wy - cam.y) * cam.zoom + H / 2 });

// ---------- history ----------
function snap() { return JSON.stringify(objects); }
function pushHistory() { undoStack.push(snap()); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snap()); objects = JSON.parse(undoStack.pop());
  selected.clear(); syncFull(); render();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snap()); objects = JSON.parse(redoStack.pop());
  selected.clear(); syncFull(); render();
}

// ---------- geometry ----------
function bbox(o) {
  if (o.type === 'path') {
    let xs = o.points.map(p => p.x), ys = o.points.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (o.type === 'text') { ctx.font = `${o.size || 20}px 'Space Grotesk',sans-serif`; const w = Math.max(40, ctx.measureText(o.text || ' ').width); return { x: o.x, y: o.y, w, h: (o.size || 20) * 1.35 }; }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}
function toLocal(o, px, py) {
  const b = bbox(o); const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const a = -((o.rotation || 0) * Math.PI / 180);
  const dx = px - cx, dy = py - cy;
  return { x: dx * Math.cos(a) - dy * Math.sin(a) + cx, y: dx * Math.sin(a) + dy * Math.cos(a) + cy, b };
}
function hit(o, px, py) {
  if (o.type === 'path') {
    const tol = 8 / cam.zoom + (o.w || 4) / 2;
    for (let i = 1; i < o.points.length; i++) {
      if (segDist(px, py, o.points[i-1], o.points[i]) < tol) return true;
    }
    return false;
  }
  const { x, y, b } = toLocal(o, px, py);
  const t = o.type === 'line' || o.type === 'arrow' ? 10 / cam.zoom : 0;
  if (o.type === 'line' || o.type === 'arrow') return segDist(x, y, { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }) < t + 3;
  if (o.type === 'ellipse') {
    const cx = b.x + b.w/2, cy = b.y + b.h/2, rx = Math.abs(b.w)/2, ry = Math.abs(b.h)/2;
    if (rx < 1 || ry < 1) return false;
    const v = ((x-cx)**2)/(rx*rx) + ((y-cy)**2)/(ry*ry);
    return v <= 1.15;
  }
  return x >= b.x - t && x <= b.x + b.w + t && y >= b.y + b.h * 0 - t && y <= b.y + b.h + t;
}
function segDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx*dx + dy*dy;
  if (!L) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / L; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
const hitTop = (wx, wy) => { for (let i = objects.length - 1; i >= 0; i--) if (hit(objects[i], wx, wy)) return objects[i]; return null; };

// ---------- render ----------
function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, W, H);
  // dot grid
  const gap = 30, tl = s2w(0, 0), br = s2w(W, H);
  ctx.fillStyle = '#1c1c1c';
  for (let gx = Math.floor(tl.x / gap) * gap; gx < br.x; gx += gap)
    for (let gy = Math.floor(tl.y / gap) * gap; gy < br.y; gy += gap) {
      const p = w2s(gx, gy); ctx.fillRect(p.x, p.y, 1.4, 1.4);
    }
  for (const o of objects) { if (o.type === 'frame') drawObj(o); }
  for (const o of objects) { if (o.type !== 'frame') drawObj(o); }
  drawSelection();
  drawRemoteEdits();
  positionCursors();
  renderTypingPill();
  const zl = document.getElementById('zoomLabel');
  if (zl) zl.textContent = Math.round(cam.zoom * 100) + '%';
}

function drawObj(o) {
  ctx.save();
  const b = bbox(o);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  ctx.translate((cx - cam.x) * cam.zoom + W / 2, (cy - cam.y) * cam.zoom + H / 2);
  ctx.rotate((o.rotation || 0) * Math.PI / 180);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cx, -cy);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const sel = selected.has(o.id);
  if (o.type === 'path') {
    ctx.strokeStyle = o.stroke || '#f5f5f5'; ctx.lineWidth = o.w || 4;
    ctx.beginPath(); o.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
  } else if (o.type === 'rect') {
    ctx.strokeStyle = o.stroke || '#f5f5f5'; ctx.lineWidth = o.w || 3;
    if (o.fill && o.fill !== 'none') { ctx.fillStyle = o.fill; ctx.fillRect(b.x, b.y, b.w, b.h); }
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  } else if (o.type === 'ellipse') {
    ctx.strokeStyle = o.stroke || '#f5f5f5'; ctx.lineWidth = o.w || 3;
    ctx.beginPath(); ctx.ellipse(cx, cy, Math.abs(b.w)/2, Math.abs(b.h)/2, 0, 0, 7); ctx.stroke();
  } else if (o.type === 'line' || o.type === 'arrow') {
    ctx.strokeStyle = o.stroke || '#f5f5f5'; ctx.lineWidth = o.w || 3;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + b.w, b.y + b.h); ctx.stroke();
    if (o.type === 'arrow') {
      const ang = Math.atan2(b.h, b.w), s = 12 + (o.w || 3) * 1.5, ex = b.x + b.w, ey = b.y + b.h;
      ctx.fillStyle = o.stroke || '#f5f5f5'; ctx.beginPath();
      ctx.moveTo(ex, ey); ctx.lineTo(ex - s * Math.cos(ang - .42), ey - s * Math.sin(ang - .42)); ctx.lineTo(ex - s * Math.cos(ang + .42), ey - s * Math.sin(ang + .42));
      ctx.closePath(); ctx.fill();
    }
  } else if (o.type === 'text') {
    ctx.fillStyle = '#f5f5f5'; ctx.font = `${o.size || 20}px 'Space Grotesk',sans-serif`;
    (o.text || '').split('\n').forEach((ln, i) => ctx.fillText(ln, b.x, b.y + (o.size || 20) * (i + 1)));
  } else if (o.type === 'sticky') {
    roundRect(b.x, b.y, b.w, b.h, 10); ctx.fillStyle = '#161616'; ctx.fill();
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#f5f5f5'; ctx.font = `15px 'Space Grotesk',sans-serif`;
    wrapText(o.text || '', b.x + 12, b.y + 24, b.w - 24, 21);
  } else if (o.type === 'frame') {
    ctx.setLineDash([8, 6]); ctx.strokeStyle = '#3d3d3d'; ctx.lineWidth = 1.4;
    ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.setLineDash([]);
    ctx.fillStyle = '#8a8a8a'; ctx.font = `600 13px 'Space Grotesk',sans-serif`;
    ctx.fillText(o.label || 'Frame', b.x + 4, b.y - 8);
  }
  ctx.restore();
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
function wrapText(text, x, y, maxW, lh) {
  const words = (text || 'Double-click to edit').split(/\s+/); let line = '', yy = y;
  for (const w of words) { const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, yy); line = w; yy += lh; } else line = t; }
  if (line) ctx.fillText(line, x, yy);
}

let handles = [];
function drawSelection() {
  handles = [];
  if (!selected.size) { if (rubber) drawRubber(); return; }
  const objs = objects.filter(o => selected.has(o.id)); if (!objs.length) return;
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  for (const o of objs) { const b = bbox(o); x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
  const a = w2s(x1, y1), b2 = w2s(x2, y2);
  ctx.save(); ctx.strokeStyle = '#f5f5f5'; ctx.lineWidth = 1.2; ctx.setLineDash([5, 4]);
  ctx.strokeRect(a.x, a.y, b2.x - a.x, b2.y - a.y); ctx.setLineDash([]);
  const pts = [[a.x, a.y, 'nw'], [(a.x+b2.x)/2, a.y, 'n'], [b2.x, a.y, 'ne'], [b2.x, (a.y+b2.y)/2, 'e'], [b2.x, b2.y, 'se'], [(a.x+b2.x)/2, b2.y, 's'], [a.x, b2.y, 'sw'], [a.x, (a.y+b2.y)/2, 'w']];
  for (const [hx, hy, k] of pts) {
    ctx.fillStyle = '#f5f5f5'; ctx.fillRect(hx - 5, hy - 5, 10, 10);
    handles.push({ x: hx, y: hy, k });
  }
  // rotate handle
  const rx = (a.x + b2.x) / 2, ry = a.y - 26;
  ctx.beginPath(); ctx.moveTo((a.x+b2.x)/2, a.y); ctx.lineTo(rx, ry); ctx.stroke();
  ctx.beginPath(); ctx.arc(rx, ry, 7, 0, 7); ctx.fillStyle = '#050505'; ctx.fill(); ctx.stroke();
  handles.push({ x: rx, y: ry, k: 'rot' });
  ctx.restore();
  if (rubber) drawRubber();
}
function drawRubber() {
  const a = w2s(Math.min(rubber.x0, rubber.x1), Math.min(rubber.y0, rubber.y1));
  const b = w2s(Math.max(rubber.x0, rubber.x1), Math.max(rubber.y0, rubber.y1));
  ctx.save(); ctx.strokeStyle = '#aaa'; ctx.fillStyle = 'rgba(255,255,255,.06)';
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.restore();
}

// ---------- pointer interactions ----------
function evPos(e) { const r = canvas.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }
let lastUpsert = 0;
function sendUpsert(o) {
  const now = Date.now();
  if (now - lastUpsert < 50 && drawing) return; // throttle live strokes
  lastUpsert = now;
  wsSend({ t: 'upsert', obj: o });
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const { sx, sy } = evPos(e), w = s2w(sx, sy);
  hidePanels();
  if (e.button === 1 || e.button === 2 || spaceDown || tool === 'pan') {
    dragOp = { k: 'pan', sx, sy, cx: cam.x, cy: cam.y }; return;
  }
  if (tool === 'select') {
    const h = handles.find(h => Math.hypot(h.x - sx, h.y - sy) < 10);
    if (h) { pushHistory(); dragOp = { k: h.k === 'rot' ? 'rot' : 'resize', h: h.k, startW: w, orig: clone(objects.filter(o => selected.has(o.id))) }; return; }
    const o = hitTop(w.x, w.y);
    if (o) {
      if (e.shiftKey) { o && (selected.has(o.id) ? selected.delete(o.id) : selected.add(o.id)); render(); return; }
      if (!selected.has(o.id)) selected = new Set([o.id]);
      pushHistory();
      dragOp = { k: 'move', startW: w, orig: clone(objects.filter(x => selected.has(x.id))) };
    } else { rubber = { x0: w.x, y0: w.y, x1: w.x, y1: w.y }; }
    render(); return;
  }
  if (tool === 'pen') {
    pushHistory();
    drawing = { id: uid(), type: 'path', points: [w, w], stroke: '#f5f5f5', w: strokeW };
    objects.push(drawing); selected = new Set([drawing.id]); render(); return;
  }
  if (tool === 'eraser') { pushHistory(); eraseAt(w); dragOp = { k: 'erase' }; return; }
  // shape / text / sticky / frame creation
  pushHistory();
  dragOp = { k: 'create', startW: w, id: uid() };
});
canvas.addEventListener('pointermove', (e) => {
  const { sx, sy } = evPos(e), w = s2w(sx, sy);
  broadcastCursor(w);
  if (dragOp?.k === 'pan') { cam.x = dragOp.cx - (sx - dragOp.sx) / cam.zoom; cam.y = dragOp.cy - (sy - dragOp.sy) / cam.zoom; render(); return; }
  if (drawing) { drawing.points.push(w); sendUpsert(drawing); render(); return; }
  if (dragOp?.k === 'erase') { eraseAt(w); render(); return; }
  if (dragOp?.k === 'move') {
    const dx = w.x - dragOp.startW.x, dy = w.y - dragOp.startW.y;
    for (const orig of dragOp.orig) {
      const o = objects.find(x => x.id === orig.id); if (!o) continue;
      if (o.type === 'path') o.points = orig.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
      else { o.x = orig.x + dx; o.y = orig.y + dy; }
      sendUpsert(o);
    }
    render(); return;
  }
  if (dragOp?.k === 'create') {
    const s = dragOp.startW;
    const x = Math.min(s.x, w.x), y = Math.min(s.y, w.y), ww = Math.abs(w.x - s.x), hh = Math.abs(w.y - s.y);
    let o = objects.find(o => o.id === dragOp.id);
    const base = { id: dragOp.id, stroke: '#f5f5f5', w: strokeW, rotation: 0 };
    if (tool === 'rect') o ? Object.assign(o, { x, y, w: ww, h: hh }) : objects.push({ ...base, type: 'rect', x, y, w: ww, h: hh });
    if (tool === 'ellipse') o ? Object.assign(o, { x, y, w: ww, h: hh }) : objects.push({ ...base, type: 'ellipse', x, y, w: ww, h: hh });
    if (tool === 'line' || tool === 'arrow') o ? Object.assign(o, { x: s.x, y: s.y, w: w.x - s.x, h: w.y - s.y }) : objects.push({ ...base, type: tool, x: s.x, y: s.y, w: 1, h: 1 });
    if (tool === 'sticky') o ? Object.assign(o, { x, y, w: Math.max(ww, 120), h: Math.max(hh, 120) }) : objects.push({ id: dragOp.id, type: 'sticky', x: s.x, y: s.y, w: 160, h: 160, text: '', rotation: 0 });
    if (tool === 'text') o ? Object.assign(o, { x: s.x, y: s.y }) : objects.push({ id: dragOp.id, type: 'text', x: s.x, y: s.y, text: '', size: 22 });
    if (tool === 'frame') o ? Object.assign(o, { x, y, w: ww, h: hh }) : objects.push({ id: dragOp.id, type: 'frame', x, y, w: ww, h: hh, label: 'Frame' });
    if (o) sendUpsert(o); else { const n = objects.find(o => o.id === dragOp.id); if (n) sendUpsert(n); }
    render(); return;
  }
  if (dragOp?.k === 'resize') {
    for (const orig of dragOp.orig) {
      const o = objects.find(x => x.id === orig.id); if (!o || o.type === 'path' || o.type === 'text') continue;
      const b0 = orig.type === 'path' ? null : { x: orig.x, y: orig.y, w: orig.w, h: orig.h };
      if (!b0) continue;
      const dx = w.x - dragOp.startW.x, dy = w.y - dragOp.startW.y;
      let { x, y, w: ww, h: hh } = b0; const k = dragOp.h;
      if (k.includes('e')) ww += dx; if (k.includes('s')) hh += dy;
      if (k.includes('w')) { x += dx; ww -= dx; } if (k.includes('n')) { y += dy; hh -= dy; }
      if (o.type === 'line' || o.type === 'arrow') { o.x = x; o.y = y; o.w = ww; o.h = hh; }
      else { o.x = x; o.y = y; o.w = Math.max(10, ww); o.h = Math.max(10, hh); }
      sendUpsert(o);
    }
    render(); return;
  }
  if (dragOp?.k === 'rot') {
    const objs = objects.filter(o => selected.has(o.id));
    let cx = 0, cy = 0; objs.forEach(o => { const b = bbox(o); cx += b.x + b.w/2; cy += b.y + b.h/2; }); cx /= objs.length; cy /= objs.length;
    const ang = Math.atan2(w.y - cy, w.x - cx) * 180 / Math.PI + 90;
    objs.forEach(o => { o.rotation = Math.round(ang); sendUpsert(o); });
    render(); return;
  }
  if (rubber) { rubber.x1 = w.x; rubber.y1 = w.y; render(); }
});
window.addEventListener('pointerup', () => {
  if (drawing) { wsSend({ t: 'upsert', obj: drawing }); drawing = null; persistLocal(); }
  if (dragOp?.k === 'create') {
    const o = objects.find(o => o.id === dragOp.id);
    if (o) {
      selected = new Set([o.id]);
      if ((o.type === 'text' || o.type === 'sticky') && (!o.text)) openEditor(o.id);
      wsSend({ t: 'upsert', obj: o }); persistLocal();
      if (o.type === 'frame' && (o.w < 20 || o.h < 20)) { objects = objects.filter(x => x.id !== o.id); selected.clear(); }
      if ((o.type === 'rect' || o.type === 'ellipse') && (o.w < 4 || o.h < 4)) { objects = objects.filter(x => x.id !== o.id); selected.clear(); }
    }
    render();
  }
  if (rubber) {
    const x0 = Math.min(rubber.x0, rubber.x1), x1 = Math.max(rubber.x0, rubber.x1);
    const y0 = Math.min(rubber.y0, rubber.y1), y1 = Math.max(rubber.y0, rubber.y1);
    selected = new Set(objects.filter(o => { const b = bbox(o); return b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0; }).map(o => o.id));
    rubber = null; render();
  }
  if (dragOp?.k && dragOp.k !== 'pan') persistLocal();
  dragOp = null;
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { sx, sy } = evPos(e);
  if (e.ctrlKey || e.metaKey) {
    const before = s2w(sx, sy);
    cam.zoom = Math.min(4, Math.max(.15, cam.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    const after = s2w(sx, sy); cam.x += before.x - after.x; cam.y += before.y - after.y;
  } else { cam.x += e.deltaX / cam.zoom; cam.y += e.deltaY / cam.zoom; }
  render();
}, { passive: false });
canvas.addEventListener('dblclick', (e) => {
  const { sx, sy } = evPos(e), w = s2w(sx, sy);
  const o = hitTop(w.x, w.y);
  if (o && (o.type === 'text' || o.type === 'sticky' || o.type === 'frame')) openEditor(o.id);
});

// ---------- eraser ----------
function eraseAt(w) {
  const victims = objects.filter(o => hit(o, w.x, w.y)).map(o => o.id);
  if (!victims.length) return;
  objects = objects.filter(o => !victims.includes(o.id));
  victims.forEach(id => selected.delete(id));
  wsSend({ t: 'delete', ids: victims });
}

// ---------- text editor (live) ----------
function openEditor(id) {
  const o = objects.find(o => o.id === id); if (!o) return;
  pushHistory(); // one undo snapshot per edit session; keystrokes stream live after this
  editingId = id;
  const b = bbox(o); const p = w2s(o.type === 'text' ? o.x : b.x, o.type === 'text' ? o.y : b.y);
  textEdit.classList.remove('hidden');
  textEdit.style.left = p.x + 'px'; textEdit.style.top = (p.y - 10) + 'px';
  textEdit.style.width = Math.max(180, (o.w || 200) * cam.zoom) + 'px';
  textEdit.style.height = Math.max(70, (o.h || 80) * cam.zoom) + 'px';
  textEdit.value = o.type === 'frame' ? (o.label || '') : (o.text || '');
  wsSend({ t: 'edit', id });
  setTimeout(() => textEdit.focus(), 0);
}
function applyTextarea(o) {
  if (o.type === 'frame') o.label = textEdit.value.slice(0, 60) || 'Frame';
  else o.text = textEdit.value.slice(0, 2000);
}
function closeEditor() {
  if (!editingId) return;
  const o = objects.find(o => o.id === editingId);
  if (o) { applyTextarea(o); wsSend({ t: 'upsert', obj: o }); persistLocal(); render(); }
  wsSend({ t: 'edit', id: null });
  editingId = null; textEdit.classList.add('hidden');
}
let editThrottle = 0;
textEdit.addEventListener('input', () => {
  if (!editingId) return;
  const o = objects.find(o => o.id === editingId); if (!o) return;
  applyTextarea(o);
  persistLocal(); render();
  const now = Date.now();
  if (now - editThrottle > 80) { // stream keystrokes live, throttled; close flushes the rest
    editThrottle = now;
    wsSend({ t: 'upsert', obj: o });
    wsSend({ t: 'edit', id: o.id });
  }
});
textEdit.addEventListener('blur', () => closeEditor());
textEdit.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) closeEditor();
});

// ---------- toolbar / tools ----------
const SHAPES = ['rect', 'ellipse', 'line', 'frame'];
function setTool(t) {
  tool = t; closeEditor();
  document.querySelectorAll('#tools .tool, #mobilebar .tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  document.getElementById('shapeBtn').classList.toggle('active', SHAPES.includes(t));
  document.querySelectorAll('#shapeMenu button').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  canvas.style.cursor = t === 'select' ? 'default' : t === 'eraser' ? 'cell' : t === 'pan' ? 'grab' : 'crosshair';
  render();
}
document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => { setTool(b.dataset.tool); closeShapeMenu(); }));
document.getElementById('shapeBtn').addEventListener('click', (e) => { e.stopPropagation(); e.currentTarget.parentElement.classList.toggle('open'); });
document.querySelectorAll('#shapeMenu button').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); setTool(b.dataset.tool); closeShapeMenu(); }));
function closeShapeMenu() { document.getElementById('shapeMenu').parentElement.classList.remove('open'); }
document.querySelectorAll('.sw').forEach(s => s.addEventListener('click', () => { document.querySelectorAll('.sw').forEach(x => x.classList.remove('sel')); s.classList.add('sel'); strokeW = +s.dataset.w; }));
document.getElementById('undoBtn').onclick = undo;
document.getElementById('redoBtn').onclick = redo;
document.getElementById('zoomIn').onclick = () => { cam.zoom = Math.min(4, cam.zoom * 1.2); render(); };
document.getElementById('zoomOut').onclick = () => { cam.zoom = Math.max(.15, cam.zoom / 1.2); render(); };
document.getElementById('focusBtn').onclick = () => { document.body.classList.toggle('focus'); setTimeout(resize, 50); };

// ---------- panels ----------
function hidePanels() { document.getElementById('collabPanel').classList.add('hidden'); document.getElementById('sharePanel').classList.add('hidden'); closeShapeMenu(); }
document.getElementById('collabBtn').onclick = (e) => { e.stopPropagation(); const p = document.getElementById('collabPanel'); const was = p.classList.contains('hidden'); hidePanels(); if (was) p.classList.remove('hidden'); };
document.getElementById('shareBtn').onclick = (e) => { e.stopPropagation(); const p = document.getElementById('sharePanel'); const was = p.classList.contains('hidden'); hidePanels(); if (was) { p.classList.remove('hidden'); refreshShare(); } };
document.addEventListener('click', (e) => { if (!e.target.closest('.panel') && !e.target.closest('#collabBtn') && !e.target.closest('#shareBtn')) hidePanels(); });

// ---------- share / QR / address ----------
async function boardURL() {
  try { const info = await (await fetch('/api/info')).json();
    const lan = (info.addrs || [])[0];
    if (lan && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return `http://${lan}:${info.port}`;
  } catch {}
  return location.origin;
}
async function refreshShare() {
  const url = await boardURL();
  document.getElementById('shareAddr').textContent = url;
  document.getElementById('landAddr').textContent = url;
  document.getElementById('qrImg').src = '/api/qr?text=' + encodeURIComponent(url);
  document.getElementById('landQr').src = '/api/qr?text=' + encodeURIComponent(url);
}
document.getElementById('copyAddr').onclick = async () => {
  const t = document.getElementById('shareAddr').textContent;
  try { await navigator.clipboard.writeText(t); document.getElementById('copyAddr').textContent = 'Copied'; setTimeout(() => document.getElementById('copyAddr').textContent = 'Copy', 1200); } catch {}
};
document.getElementById('clearBtn').onclick = () => { if (!confirm('Clear the whole board for everyone?')) return; pushHistory(); objects = []; selected.clear(); wsSend({ t: 'clear' }); persistLocal(); render(); };
document.getElementById('dlBtn').onclick = () => {
  const blob = new Blob([JSON.stringify({ objects }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'wifi-board.json'; a.click();
};

// ---------- presence / cursors / live typing ----------
function renderPresence() {
  const n = users.length || 1;
  document.getElementById('collabCount').textContent = n;
  document.getElementById('collabN').textContent = '· ' + n;
  document.getElementById('userList').innerHTML = users.map(u =>
    `<div class="user-row"><div class="avatar">${esc(u.name).slice(0, 1).toUpperCase()}</div><div>${esc(u.name)}${u.id === selfId ? ' <span class="muted">(you)</span>' : ''}</div></div>`).join('');
}
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function positionCursors() {
  for (const [id, c] of remoteCursors) {
    let el = document.getElementById('cur-' + id);
    if (!el) { el = document.createElement('div'); el.className = 'cursor'; el.id = 'cur-' + id;
      el.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1l12 5-5 1.5L5 13z" fill="#f5f5f5" stroke="#000"/></svg><span></span>`;
      cursorsEl.appendChild(el); }
    const p = w2s(c.x, c.y);
    el.style.transform = `translate(${p.x}px,${p.y}px)`;
    el.querySelector('span').textContent = c.name;
    if (Date.now() - c.at > 8000) { el.remove(); remoteCursors.delete(id); }
  }
}
let curThrottle = 0;
function broadcastCursor(w) {
  const now = Date.now(); if (now - curThrottle < 40) return; curThrottle = now;
  wsSend({ t: 'cursor', x: Math.round(w.x), y: Math.round(w.y) });
}
function renderTypingPill() {
  const el = document.getElementById('typingPill');
  const now = Date.now();
  const names = [...new Set([...editingBy.values()].filter(v => now - v.at < 6000 && v.by !== selfId).map(v => v.name))];
  if (!names.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = '<b>' + names.map(esc).join('</b>, <b>') + '</b> ' + (names.length > 1 ? 'are' : 'is') + ' typing…';
}
function drawRemoteEdits() {
  const now = Date.now();
  let any = false;
  ctx.save();
  ctx.font = `600 11px 'Space Grotesk',sans-serif`;
  for (const [id, v] of editingBy) {
    if (now - v.at > 6000 || v.by === selfId) continue;
    const o = objects.find(o => o.id === id); if (!o) continue;
    any = true;
    const b = bbox(o), a = w2s(b.x, b.y), c = w2s(b.x + b.w, b.y + b.h);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
    ctx.strokeRect(a.x - 4, a.y - 4, c.x - a.x + 8, c.y - a.y + 8);
    ctx.setLineDash([]);
    const label = v.name + ' is typing…';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(a.x - 4, a.y - 26, tw + 16, 19, 9); else ctx.rect(a.x - 4, a.y - 26, tw + 16, 19);
    ctx.fill();
    ctx.fillStyle = '#000'; ctx.fillText(label, a.x + 4, a.y - 12);
  }
  ctx.restore();
  return any;
}

// ---------- networking ----------
let ws, wsQueue = [];
function wsSend(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); else wsQueue.push(m); }
function persistLocal() { try { localStorage.setItem('wifiboard', JSON.stringify(objects)); } catch {} }
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);
  ws.onopen = () => { wsQueue.splice(0).forEach(m => ws.send(JSON.stringify(m))); if (selfName) wsSend({ t: 'rename', name: selfName }); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'init') {
      selfId = m.self.id;
      if (!selfName) selfName = m.self.name;
      document.getElementById('nameInput').value = selfName;
      objects = m.objects || [];
      try { const local = JSON.parse(localStorage.getItem('wifiboard') || 'null'); if (!objects.length && local?.length) objects = local; } catch {}
      users = m.users; renderPresence(); render();
    }
    else if (m.t === 'presence') { users = m.users; renderPresence(); }
    else if (m.t === 'cursor') { remoteCursors.set(m.id, { x: m.x, y: m.y, name: m.name, at: Date.now() }); positionCursors(); }
    else if (m.t === 'leave') { remoteCursors.delete(m.id); document.getElementById('cur-' + m.id)?.remove(); for (const [k, v] of editingBy) if (v.by === m.id) editingBy.delete(k); renderTypingPill(); }
    else if (m.t === 'edit') {
      for (const [k, v] of editingBy) if (v.by === m.by.id) editingBy.delete(k);
      if (m.id) editingBy.set(m.id, { name: m.by.name, by: m.by.id, at: Date.now() });
      renderTypingPill(); render();
    }
    else if (m.t === 'upsert') {
      const i = objects.findIndex(o => o.id === m.obj.id);
      if (drawing && m.obj.id === drawing.id) return;
      if (i >= 0) objects[i] = m.obj; else objects.push(m.obj);
      if (m.obj.id === editingId) { // someone else typed into the note we're editing — merge live
        const incoming = m.obj.type === 'frame' ? (m.obj.label || '') : (m.obj.text || '');
        if (incoming !== textEdit.value) {
          const s = textEdit.selectionStart ?? incoming.length, e = textEdit.selectionEnd ?? incoming.length;
          textEdit.value = incoming;
          try { textEdit.setSelectionRange(Math.min(s, incoming.length), Math.min(e, incoming.length)); } catch {}
        }
      }
      render();
    }
    else if (m.t === 'delete') { objects = objects.filter(o => !m.ids.includes(o.id)); m.ids.forEach(id => { selected.delete(id); editingBy.delete(id); }); render(); }
    else if (m.t === 'full') { objects = m.objects; selected.clear(); for (const k of [...editingBy.keys()]) if (!objects.some(o => o.id === k)) editingBy.delete(k); persistLocal(); render(); }
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
function syncFull() { wsSend({ t: 'full', objects }); persistLocal(); }

// ---------- landing ----------
const NAMES_A = ['Blue', 'Silver', 'Quiet', 'Red', 'Pale', 'Swift', 'Calm', 'Misty', 'Amber', 'Onyx'];
const NAMES_N = ['Fox', 'Wolf', 'Raven', 'Panda', 'Heron', 'Otter', 'Falcon', 'Wren', 'Lynx', 'Badger'];
const randName = () => NAMES_A[Math.floor(Math.random() * NAMES_A.length)] + ' ' + NAMES_N[Math.floor(Math.random() * NAMES_N.length)];
document.getElementById('shuffleName').onclick = () => { document.getElementById('nameInput').value = randName(); };
document.getElementById('joinBtn').onclick = () => {
  selfName = document.getElementById('nameInput').value.trim().slice(0, 24) || randName();
  wsSend({ t: 'rename', name: selfName });
  document.getElementById('landing').style.display = 'none';
  setTimeout(() => document.getElementById('hint').style.display = 'none', 6000);
};

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea')) return;
  if (e.key === ' ') spaceDown = true;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicate(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'a' && tool === 'select') { e.preventDefault(); selected = new Set(objects.map(o => o.id)); render(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSel(); return; }
  const map = { v: 'select', p: 'pen', e: 'eraser', t: 'text', s: 'sticky', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', f: 'frame' };
  if (map[k] && !e.ctrlKey && !e.metaKey) setTool(map[k]);
  if (k === '+' || k === '=') { cam.zoom = Math.min(4, cam.zoom * 1.15); render(); }
  if (k === '-') { cam.zoom = Math.max(.15, cam.zoom / 1.15); render(); }
  if (k === '0') { cam.x = 0; cam.y = 0; cam.zoom = 1; render(); }
  if (k === '.') document.body.classList.toggle('focus');
  if (e.key === 'Escape') { selected.clear(); hidePanels(); closeEditor(); render(); }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });

function deleteSel() {
  if (!selected.size || editingId) return;
  pushHistory();
  const ids = [...selected]; objects = objects.filter(o => !selected.has(o.id)); selected.clear();
  wsSend({ t: 'delete', ids }); persistLocal(); render();
}
function duplicate() {
  if (!selected.size) return;
  pushHistory();
  const clones = objects.filter(o => selected.has(o.id)).map(o => { const c = clone(o); c.id = uid();
    if (c.type === 'path') c.points = c.points.map(p => ({ x: p.x + 24, y: p.y + 24 })); else { c.x += 24; c.y += 24; } return c; });
  objects.push(...clones); selected = new Set(clones.map(c => c.id));
  clones.forEach(c => wsSend({ t: 'upsert', obj: c })); persistLocal(); render();
}
document.getElementById('hint').textContent = 'Drag to draw · Space + drag to pan · Scroll to zoom · Double-click sticky/text to edit';

// ---------- boot ----------
document.getElementById('nameInput').value = randName();
resize(); connect(); refreshShare(); render();
setInterval(() => {
  let changed = false;
  for (const [id, c] of remoteCursors) if (Date.now() - c.at > 8000) { remoteCursors.delete(id); document.getElementById('cur-' + id)?.remove(); }
  for (const [k, v] of editingBy) if (Date.now() - v.at > 6000) { editingBy.delete(k); changed = true; }
  if (changed) { renderTypingPill(); render(); }
}, 3000);
