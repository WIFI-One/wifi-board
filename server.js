const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3001; // 3000 is taken by wifi-chat in this suite
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'boards.json');
const LEGACY_FILE = path.join(__dirname, 'board.json'); // single-board store, migrated once
const bid = () => Math.random().toString(36).slice(2, 10);

// ---------- multi-board store ----------
let boards = {}; // id -> { id, name, objects, createdAt, updatedAt }
function saveBoards() {
  fs.writeFile(DATA_FILE, JSON.stringify({ boards }), () => {});
}
function touchBoard(b) { b.updatedAt = Date.now(); saveBoards(); }
function cleanName(n) {
  const s = String(n || '').trim().slice(0, 60);
  return s || 'Untitled board';
}
function makeBoard(name, objects) {
  const now = Date.now();
  const b = { id: bid(), name: cleanName(name), objects: Array.isArray(objects) ? objects : [], createdAt: now, updatedAt: now };
  boards[b.id] = b; saveBoards();
  return b;
}
function sanitizeBoard(b) {
  if (!b || typeof b !== 'object') return null;
  if (typeof b.id !== 'string' || !b.id) return null;
  return {
    id: b.id,
    name: typeof b.name === 'string' && b.name ? b.name.slice(0, 60) : 'Untitled board',
    objects: Array.isArray(b.objects) ? b.objects : [],
    createdAt: +b.createdAt || Date.now(),
    updatedAt: +b.updatedAt || Date.now(),
  };
}
function defaultBoard() {
  const all = Object.values(boards).sort((a, b) => a.createdAt - b.createdAt);
  return all[0] || makeBoard('Main board');
}
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw && typeof raw.boards === 'object') {
      for (const b of Object.values(raw.boards)) {
        const c = sanitizeBoard(b);
        if (c) boards[c.id] = c;
      }
    }
  }
} catch { boards = {}; }
// one-time migration from the old single-board file (kept, not written again)
if (!Object.keys(boards).length && fs.existsSync(LEGACY_FILE)) {
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    makeBoard('Main board', Array.isArray(legacy.objects) ? legacy.objects : []);
  } catch { /* ignore corrupt legacy file */ }
}
if (!Object.keys(boards).length) makeBoard('Main board');

function boardSummary(b, withCounts) {
  const s = { id: b.id, name: b.name, createdAt: b.createdAt, updatedAt: b.updatedAt, objectCount: b.objects.length };
  if (withCounts) s.clientCount = [...clients.values()].filter(c => c.boardId === b.id).length;
  return s;
}

// temp names
const ADJ = ['Blue','Silver','Quiet','Red','Pale','Swift','Calm','Bold','Misty','Amber','Ivory','Onyx'];
const NOUN = ['Fox','Wolf','Raven','Panda','Heron','Otter','Badger','Falcon','Deer','Wren','Lynx','Mole'];
const usedNames = new Set();
function genName() {
  for (let i = 0; i < 50; i++) {
    const n = ADJ[Math.floor(Math.random()*ADJ.length)] + ' ' + NOUN[Math.floor(Math.random()*NOUN.length)];
    if (!usedNames.has(n)) { usedNames.add(n); return n; }
  }
  const n = 'Guest ' + Math.floor(Math.random()*9000+1000);
  usedNames.add(n); return n;
}
function freeName(n){ usedNames.delete(n); }

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const arr of Object.values(nets)) for (const ni of arr || []) {
    if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

app.get('/api/boards', (req, res) => {
  res.json({ boards: Object.values(boards).sort((a, b) => a.createdAt - b.createdAt).map(b => boardSummary(b, true)) });
});
app.post('/api/boards', (req, res) => {
  const b = makeBoard(req.body && req.body.name);
  res.status(201).json({ board: boardSummary(b, true) });
});
app.delete('/api/boards/:id', (req, res) => {
  const b = boards[req.params.id];
  if (!b) return res.status(404).json({ error: 'unknown board' });
  delete boards[req.params.id];
  if (!Object.keys(boards).length) makeBoard('Main board');
  else saveBoards();
  broadcast(req.params.id, { t: 'board-deleted', id: req.params.id });
  res.json({ ok: true });
});
app.get('/api/board', (req, res) => {
  const b = boards[req.query.board] || defaultBoard();
  res.json({ id: b.id, name: b.name, objects: b.objects, updatedAt: b.updatedAt });
});
app.post('/api/board', (req, res) => {
  const b = boards[(req.body && req.body.boardId) || req.query.board] || defaultBoard();
  if (Array.isArray(req.body.objects)) { b.objects = req.body.objects; touchBoard(b); broadcast(b.id, { t:'full', objects: b.objects }); }
  res.json({ ok: true, id: b.id });
});
app.get('/api/info', (req, res) => {
  res.json({ addrs: lanAddresses(), port: PORT, count: clients.size });
});
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/qr', async (req, res) => {
  try {
    const text = String(req.query.text || `http://localhost:${PORT}`).slice(0, 500);
    const png = await QRCode.toBuffer(text, { width: 440, margin: 2 });
    res.type('png').send(png);
  } catch { res.status(500).end(); }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map(); // ws -> {id,name,color,boardId}

function broadcast(boardId, msg, except) {
  const s = JSON.stringify(msg);
  for (const [ws, c] of clients) {
    if (c.boardId !== boardId) continue;
    if (ws !== except && ws.readyState === 1) ws.send(s);
  }
}
function presence(boardId) {
  return [...clients.values()].filter(c => c.boardId === boardId).map(c => ({ id: c.id, name: c.name, color: c.color }));
}
function pushPresence(boardId) {
  broadcast(boardId, { t:'presence', users: presence(boardId) });
}

wss.on('connection', (ws, req) => {
  let boardId = null;
  try { boardId = new URL(req.url, 'http://x').searchParams.get('board'); } catch {}
  const board = boards[boardId] || defaultBoard();
  const id = Math.random().toString(36).slice(2, 9);
  const info = { id, name: genName(), color: '#e8e8e8', boardId: board.id };
  clients.set(ws, info);
  ws.send(JSON.stringify({ t:'init', self: info, board: { id: board.id, name: board.name }, objects: board.objects, users: presence(board.id) }));
  pushPresence(board.id);

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const me = clients.get(ws); if (!me) return;
    const b = boards[me.boardId]; if (!b) return; // board deleted while connected
    switch (m.t) {
      case 'rename': if (typeof m.name==='string' && m.name.trim()) { freeName(me.name); me.name = m.name.trim().slice(0,24); usedNames.add(me.name); pushPresence(me.boardId); } break;
      case 'cursor': broadcast(me.boardId, { t:'cursor', id: me.id, name: me.name, x: m.x, y: m.y }, ws); break;
      case 'edit': broadcast(me.boardId, { t:'edit', id: m.id || null, by: { id: me.id, name: me.name } }, ws); break;
      case 'upsert': {
        // m.obj single object upsert
        if (!m.obj || typeof m.obj.id !== 'string') break;
        const i = b.objects.findIndex(o => o.id === m.obj.id);
        if (i >= 0) b.objects[i] = m.obj; else b.objects.push(m.obj);
        touchBoard(b); broadcast(me.boardId, { t:'upsert', obj: m.obj }, ws); break;
      }
      case 'delete': {
        if (!Array.isArray(m.ids)) break;
        b.objects = b.objects.filter(o => !m.ids.includes(o.id));
        touchBoard(b); broadcast(me.boardId, { t:'delete', ids: m.ids }, ws); break;
      }
      case 'full': if (Array.isArray(m.objects)) { b.objects = m.objects; touchBoard(b); broadcast(me.boardId, { t:'full', objects: b.objects }, ws); } break;
      case 'clear': b.objects = []; touchBoard(b); broadcast(me.boardId, { t:'full', objects: [] }); break;
    }
  });
  ws.on('close', () => { const me = clients.get(ws); if (me) freeName(me.name); clients.delete(ws); if (me) { broadcast(me.boardId, { t:'leave', id: info.id }); pushPresence(me.boardId); } });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  WiFi Board running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  lanAddresses().forEach(a => console.log(`  Network: http://${a}:${PORT}`));
  console.log(`\n  Same WiFi. No cloud. No account.\n`);
});
