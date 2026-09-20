# WiFi Board — local-network collaborative whiteboard

Single-host whiteboard (no internet). Node.js WebSocket server + dependency-free
vanilla JS canvas client. Server serves the client UI itself; board state lives
on the host and syncs to all browsers on the same WiFi.

## Repo layout (actual)

```
wifi-board/
├── AGENTS.md
├── README.md
├── package.json            # express, ws, qrcode; scripts: start, dev
├── package-lock.json       # npm is canonical (keep; do not add pnpm/yarn locks)
├── server.js               # entry: HTTP + WS + /api/* + static public/
├── board.json              # runtime board persistence (gitignored, created on first change)
└── public/
    ├── index.html          # floating pills, panels, landing overlay, inline SVG icons
    ├── styles.css          # wifi-chat-matched theme tokens + pill styles
    └── app.js              # canvas engine, tools, live typing, presence, networking
```

There is no build step, no framework, no `dist/`, no test suite.

## Stack

- Server: Node 20+, CommonJS, `express` (static + JSON API), `ws` (realtime),
  `qrcode` (local QR PNG generation).
- Client: vanilla JS Canvas 2D, single `app.js` (~600 lines), inline
  Lucide-style SVGs (`fill=none stroke=currentColor stroke-width=2 round caps`).
- Theme must stay matched to wifi-chat: pure black bg, `#141414` pills/panels,
  `#2a2a2a` borders, white accents, `rounded-full` pills, `bg-white/10`-style
  hovers, Space Grotesk, green `#22c55e` presence dot.

## Commands

```bash
npm install
npm start            # node server.js, defaults to port 3001
PORT=3005 npm start  # override port
```

## Ports

- Board: `http://<host>:3001` (default; wifi-chat owns 3000 in this suite).
  Binds `0.0.0.0` for LAN. No WS subpath — plain upgrade on `/`.
- The Share panel / QR always reflect the effective `PORT`; `GET /api/info`
  reports LAN IPs + port + client count.

## Protocol (source of truth: `server.js` + `public/app.js`)

```
Client -> Server: rename {name}, cursor {x,y}, upsert {obj}, delete {ids},
                  full {objects}, clear, edit {id|null}
Server -> Client: init {self, objects, users}, presence {users}, cursor,
                  leave {id}, upsert {obj}, delete {ids}, full {objects},
                  edit {id|null, by{id,name}}
```

- `upsert` broadcasts exclude the sender; `full` is used for undo/redo and
  replace-from-REST. Temp names (`Blue Fox`…) are server-assigned, unique per
  connection, freed on disconnect.
- REST: `GET /health`, `GET /api/info`, `GET /api/board`,
  `POST /api/board {objects}`, `GET /api/qr?text=…` (local PNG).

## State (public/app.js)

- `objects` — array of `{id, type, …}` where type is
  `path|rect|ellipse|line|arrow|text|sticky|frame`. Paths store world-space
  `points`; shapes store `x,y,w,h,rotation`.
- `cam {x,y,zoom}` — world center + scale; `s2w`/`w2s` convert coordinates.
- `tool`, `strokeW`, `selected:Set`, `undoStack`/`redoStack` (JSON snapshots).
- `users`, `remoteCursors:Map`, `editingBy:Map` (live-typing presence),
  `drawing`/`dragOp`/`rubber` (in-progress gestures), `editingId`.
- Persistence: server `board.json`; client `localStorage['wifiboard']` is only
  a fallback when the host board is empty.

## Conventions / gotchas

- One undo snapshot per edit session (`openEditor`), not per keystroke —
  keystrokes stream via throttled `upsert` + `edit`, `closeEditor` flushes.
- Remote `upsert` for `editingId` merges into the open textarea with caret
  preserved; never echo — server already excludes the sender.
- Every `getElementById` in `app.js` must exist in `index.html`
  (31 IDs; verify with a quick node script after markup changes).
- Never commit: `node_modules/`, `board.json` (user data), lockfiles other
  than `package-lock.json`, `.env*`, `*.log`, OS/editor files.
- Keep the client dependency-free and offline-capable (only the Google Fonts
  link may fail offline — it degrades to system fonts by design).

## Verify

- `node --check server.js && node --check public/app.js`
- Boot (`PORT=31xx node server.js`), then: `GET /health`, `GET /api/info`
  (real LAN IPs), `GET /api/qr?text=…` (PNG), `GET /` (board HTML).
- Two WS clients: unique names, `upsert` broadcast, `cursor` relay, `edit`
  presence + clear, keystroke streaming (`H→Hello` arrives live), and
  `GET /api/board` shows the persisted object.
- Two browsers (or host + phone on same Wi-Fi): draw, move, live-type in a
  sticky, undo/redo, refresh restores state, QR joins from phone.
