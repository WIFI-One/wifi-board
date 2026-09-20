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

const DATA_FILE = path.join(__dirname, 'board.json');
let board = { objects: [], updatedAt: Date.now() };
try {
  if (fs.existsSync(DATA_FILE)) {
    board = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(board.objects)) board.objects = [];
  }
} catch { board = { objects: [], updatedAt: Date.now() }; }

function persist() {
  board.updatedAt = Date.now();
  fs.writeFile(DATA_FILE, JSON.stringify(board), () => {});
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

app.get('/api/board', (req, res) => res.json(board));
app.post('/api/board', (req, res) => {
  if (Array.isArray(req.body.objects)) { board.objects = req.body.objects; persist(); broadcast({ t:'full', objects: board.objects }); }
  res.json({ ok: true });
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
const clients = new Map(); // ws -> {id,name,color}

function broadcast(msg, except) {
  const s = JSON.stringify(msg);
  for (const [ws] of clients) if (ws !== except && ws.readyState === 1) ws.send(s);
}
function presence() {
  return [...clients.values()].map(c => ({ id: c.id, name: c.name, color: c.color }));
}
function pushPresence() {
  broadcast({ t:'presence', users: presence() });
}

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).slice(2, 9);
  const info = { id, name: genName(), color: '#e8e8e8' };
  clients.set(ws, info);
  ws.send(JSON.stringify({ t:'init', self: info, objects: board.objects, users: presence() }));
  pushPresence();

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const me = clients.get(ws); if (!me) return;
    switch (m.t) {
      case 'rename': if (typeof m.name==='string' && m.name.trim()) { freeName(me.name); me.name = m.name.trim().slice(0,24); usedNames.add(me.name); pushPresence(); } break;
      case 'cursor': broadcast({ t:'cursor', id: me.id, name: me.name, x: m.x, y: m.y }, ws); break;
      case 'edit': broadcast({ t:'edit', id: m.id || null, by: { id: me.id, name: me.name } }, ws); break;
      case 'upsert': {
        // m.obj single object upsert
        const i = board.objects.findIndex(o => o.id === m.obj.id);
        if (i >= 0) board.objects[i] = m.obj; else board.objects.push(m.obj);
        persist(); broadcast({ t:'upsert', obj: m.obj }, ws); break;
      }
      case 'delete': {
        board.objects = board.objects.filter(o => !m.ids.includes(o.id));
        persist(); broadcast({ t:'delete', ids: m.ids }, ws); break;
      }
      case 'full': board.objects = m.objects; persist(); broadcast({ t:'full', objects: board.objects }, ws); break;
      case 'clear': board.objects = []; persist(); broadcast({ t:'full', objects: [] }); break;
    }
  });
  ws.on('close', () => { const me = clients.get(ws); if (me) freeName(me.name); clients.delete(ws); broadcast({ t:'leave', id: info.id }); pushPresence(); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  WiFi Board running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  lanAddresses().forEach(a => console.log(`  Network: http://${a}:${PORT}`));
  console.log(`\n  Same WiFi. No cloud. No account.\n`);
});
