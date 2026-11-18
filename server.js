// Blend In online room server.
//
// A small relay: players join a room by its code, and the server passes
// messages between everyone in that room. It never runs the game itself;
// each player's game does, exactly like the claude.ai room channel.
//
// Messages (JSON text over a WebSocket at /ws):
//   client -> server
//     {op:"join", room, id?, key?} join (or open) a room. A client may pick its own
//                                  id (and a secret key) so that after a dropped
//                                  connection it rejoins as the same player.
//     {op:"presence", pr}          my current state (name, role, position...)
//     {op:"emit", t, d}            a moment for everyone in the room (shot, hit, paint...)
//     {op:"leave"}
//   server -> client
//     {op:"joined", room, me}      you are in; `me` is your player id
//     {op:"snapshot", peers:[{p, pr}]}   everyone already here (sent on join)
//     {op:"pr", p, pr}             a player's state changed (or a new player);
//                                  your own presence isn't sent back to you
//     {op:"left", p}               a player left
//     {op:"ev", t, d, p}           a moment from player p (yours come back too)
//     {op:"error", code}           room_full | bad_room | bad_message | rate_limited
//
// Run: npm install && npm start   (PORT env var, default 8080)

"use strict";
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT || "8080", 10);
const MAX_PER_ROOM = 20;            // 16 hiders + 4 seekers
const MAX_ROOMS = 2000;
const MAX_MSG_BYTES = 8 * 1024;
const MAX_MSGS_PER_SEC = 60;        // per player
const TOPICS = new Set(["start", "fire", "hit", "paint", "end"]);
const ROOM_RE = /^[a-z0-9]{3,12}$/;
const ID_RE = /^[a-z0-9]{4,16}$/;

const rooms = new Map();            // code -> Map(id -> {ws, pr})
let nextId = 1;

const server = http.createServer((req, res) => {
  // health check for hosting services
  const stats = {
    ok: true,
    rooms: rooms.size,
    players: [...rooms.values()].reduce((n, r) => n + r.size, 0),
    sent_mb: +(bytesOut / 1e6).toFixed(2),
    up_hours: +((Date.now() - startedAt) / 3.6e6).toFixed(2),
  };
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(stats));
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

function send(ws, obj) {
  if (ws.readyState !== 1) return;
  const txt = JSON.stringify(obj);
  ws.send(txt);
  bytesOut += txt.length;
}

let bytesOut = 0;
const startedAt = Date.now();

function broadcast(room, obj, except) {
  const txt = JSON.stringify(obj);
  for (const pl of room.values()) {
    if (pl.ws === except || pl.ws.readyState !== 1) continue;
    pl.ws.send(txt);
    bytesOut += txt.length;
  }
}

function leave(ws) {
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  if (room) {
    room.delete(ws.id);
    if (room.size === 0) rooms.delete(ws.room);
    else broadcast(room, { op: "left", p: ws.id });
  }
  ws.room = null;
}

wss.on("connection", (ws) => {
  ws.id = "s" + (nextId++).toString(36) + Math.random().toString(36).slice(2, 6);
  ws.room = null;
  ws.alive = true;
  ws.budget = MAX_MSGS_PER_SEC;
  ws.on("pong", () => { ws.alive = true; });

  ws.on("message", (raw) => {
    if (--ws.budget < 0) { if (ws.budget === -1) send(ws, { op: "error", code: "rate_limited" }); return; }
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return send(ws, { op: "error", code: "bad_message" }); }
    if (!m || typeof m !== "object") return;
    switch (m.op) {
      case "join": {
        const code = String(m.room || "").toLowerCase();
        if (!ROOM_RE.test(code)) return send(ws, { op: "error", code: "bad_room" });
        leave(ws);
        let room = rooms.get(code);
        if (!room) {
          if (rooms.size >= MAX_ROOMS) return send(ws, { op: "error", code: "server_full" });
          room = new Map();
          rooms.set(code, room);
        }
        // reconnect: same id + same key takes over the old (dead) connection
        const want = String(m.id || "").toLowerCase();
        const key = String(m.key || "").slice(0, 64);
        let pr = {};
        if (ID_RE.test(want)) {
          const old = room.get(want);
          if (old && old.ws !== ws) {
            if (!key || old.key !== key) return send(ws, { op: "error", code: "id_taken" });
            pr = old.pr;
            old.ws.room = null;          // so its close doesn't announce "left"
            old.ws.terminate();
            room.delete(want);
          }
          ws.id = want;
        }
        if (room.size >= MAX_PER_ROOM) return send(ws, { op: "error", code: "room_full" });
        room.set(ws.id, { ws, pr, key });
        ws.room = code;
        send(ws, { op: "joined", room: code, me: ws.id });
        send(ws, { op: "snapshot", peers: [...room.entries()].map(([p, pl]) => ({ p, pr: pl.pr })) });
        broadcast(room, { op: "pr", p: ws.id, pr });
        break;
      }
      case "presence": {
        const room = ws.room && rooms.get(ws.room);
        if (!room || !m.pr || typeof m.pr !== "object") return;
        room.get(ws.id).pr = m.pr;
        broadcast(room, { op: "pr", p: ws.id, pr: m.pr }, ws);
        break;
      }
      case "emit": {
        const room = ws.room && rooms.get(ws.room);
        if (!room || !TOPICS.has(m.t)) return;
        broadcast(room, { op: "ev", t: m.t, d: m.d, p: ws.id });
        break;
      }
      case "leave":
        leave(ws);
        break;
    }
  });

  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

// refill each player's message budget every second; drop dead connections
setInterval(() => { for (const ws of wss.clients) ws.budget = MAX_MSGS_PER_SEC; }, 1000);
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 20000);

server.listen(PORT, () => console.log(`Blend In room server on port ${PORT}`));
