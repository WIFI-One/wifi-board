# WiFi Board
*Your Network. Your Space.*

Real-time collaborative whiteboard for people on the **same WiFi network**.
**Same WiFi. No cloud. No account.**

Black canvas + white UI + Space Grotesk, themed to match WiFi Chat
(pure black, rounded-full pills, white/10 icon hovers, Lucide-style SVG icons).
No gradients, no clutter — a focused creative tool.

## Quick start

```bash
npm install
npm start   # defaults to port 3001 (wifi-chat uses 3000); override with PORT=xxxx
```

The server prints its reachable addresses on boot:

```
WiFi Board running
Local:   http://localhost:3001
Network: http://192.168.x.x:3001
```

## Joining a board

1. The host runs `npm start` and clicks **Share** (top-right pill) to see the
   board address + QR code.
2. Anyone on the **same WiFi** opens `http://<host-lan-ip>:3001` in a browser
   — or scans the QR with a phone — and picks a temporary display name.
3. No accounts, no email, no internet required after the page loads.

If the page is refreshed, the current board state is restored from the host.

## Features

- **Infinite canvas** — pan (Space+drag, wheel, right/middle-drag), zoom
  (Ctrl+wheel, pill controls, `+`/`-`/`0`), faint dot grid
- **Floating pill toolbar** — icon-only tools with tooltips:
  Select · Pen · Eraser · Text · Sticky · Shapes (Rectangle, Circle, Line,
  Frame) · Arrow, plus stroke-thickness control
- **Objects** — move, resize (8 handles), rotate, multi-select
  (Shift-click, rubber-band), duplicate (`Ctrl+D`), delete, undo/redo
- **Live text typing** — keystrokes in text / sticky / frame editors stream
  to everyone as you type; `Name is typing…` pill + dashed outline shows
  who is editing what
- **Brainstorming** — dark-gray sticky notes, mind-map arrows, labeled
  frames/sections, drag-and-drop organization
- **Presence** — live `● N` count in the brand pill, collaborator panel with
  temporary names (Blue Fox, Silver Wolf…), named remote cursors
- **Focus mode** (`.` or the expand icon) hides all UI for a larger canvas
- **Responsive** — tool pill collapses to a floating bottom icon bar on phones
- **Privacy** — `LOCAL NETWORK · Nothing leaves your WiFi` chip; board data
  lives on the host (`board.json`) and is never sent to any cloud service

## Shortcuts

`V P E T S R O L A F` tools · `Space+drag` pan · `wheel` pan ·
`Ctrl+wheel` zoom · `Del` delete · `Ctrl+D` duplicate · `Ctrl+Z` / `Ctrl+Y`
undo/redo · `Ctrl+A` select all · `0` reset view · `.` focus · `Esc` deselect

## How it works

- `server.js` — Express static host + WebSocket hub. Keeps the board in
  memory, persists to `board.json`, relays cursor/edit presence, generates
  QR PNGs locally (`qrcode` package, no external service).
- `public/` — dependency-free vanilla JS canvas app (`index.html`,
  `styles.css`, `app.js`). No CDN assets except the Space Grotesk webfont
  (falls back to system fonts offline).
- Sync is message-based: single-object `upsert` for live strokes/typing,
  `full` snapshots for undo/redo and late joiners.

## REST endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/health` | Liveness probe (`{"ok":true}`) |
| GET | `/api/info` | LAN addresses, port, client count |
| GET | `/api/board` | Current board state |
| POST | `/api/board` | Replace board (`{objects}`), rebroadcasts |
| GET | `/api/qr?text=…` | QR code PNG for any text (generated locally) |

## Troubleshooting

- **Nobody can join** — devices must be on the same WiFi; host firewalls must
  allow inbound TCP on the board port.
- **Port in use** — run with another port: `PORT=3005 npm start`. The Share
  panel and QR always reflect the actual port.
- **Blank board after restart** — `board.json` may have been deleted; the app
  falls back to each browser's last `localStorage` copy when the host is empty.
