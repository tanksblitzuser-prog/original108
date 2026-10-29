'use strict';
/*
 * 108 — onlayn karta o'yini serveri.
 * Hamma qoidalar shu yerda (engine.js orqali) hal qilinadi. Mijoz faqat o'z kartalarini ko'radi.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attach } = require('./wslite.js');
const G = require('./engine.js');

const PORT = +process.env.PORT || 3000;
const TURN_MS = +process.env.TURN_MS || 40000;          // bitta yurish uchun vaqt
const SHUFFLE_MS = +process.env.SHUFFLE_MS || 5000;     // kartalar aralashtirilayotgandagi tanaffus
const MAX_ROOMS = +process.env.MAX_ROOMS || 300;
const LOBBY_GRACE_MS = +process.env.LOBBY_GRACE_MS || 45000;   // lobbida uzilgan o'yinchini kutish
const EMPTY_ROOM_MS = +process.env.EMPTY_ROOM_MS || 5 * 60 * 1000;
const INTRO_MAX_MS = +process.env.INTRO_MAX_MS || 60000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';       // masalan: https://mening-sayt.onrender.com (ixtiyoriy)

const BOT_NAMES = ['Ali', 'Vali', 'Sardor', 'Jasur', 'Bek', 'Aziz', 'Dilshod', 'Otabek'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 0/O va 1/I/L aralashmasin
const EMOJIS = ['👍', '😂', '😮', '😡', '👏', '🔥'];
const rooms = new Map();
const now = () => Date.now();

/* ---------------- yordamchilar ---------------- */
function genCode() {
  for (let k = 0; k < 60; k++) {
    const b = crypto.randomBytes(5); let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function cleanName(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>&"`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
}
function uniqueName(room, base) {
  let n = base, k = 2;
  while (room.seats.some((s) => s.name === n)) n = base.slice(0, 11) + ' ' + k++;
  return n;
}
function send(ws, obj) { if (ws && ws.open) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } } }
function err(ws, msg, fatal) { send(ws, { t: 'error', msg, fatal: !!fatal }); }
const idxOf = (room, seat) => room.seats.indexOf(seat);

function ensureHost(room) {
  const ok = (s) => s && room.seats.includes(s) && !s.left && !s.bot;
  if (ok(room.host) && (room.host.ws || !room.seats.some((s) => ok(s) && s.ws))) return;
  const next = room.seats.find((s) => ok(s) && s.ws) || room.seats.find((s) => ok(s));
  if (next) room.host = next;
}

/* ---------------- xabarlar ---------------- */
function roomMsg(room, seat) {
  return {
    t: 'room', code: room.code, phase: room.phase, you: idxOf(room, seat), host: idxOf(room, room.host),
    seats: room.seats.map((s) => ({ name: s.name, bot: !!s.bot, connected: !!(s.ws || s.bot), left: !!s.left })),
  };
}
function broadcastRoom(room) { for (const s of room.seats) if (s.ws) send(s.ws, roomMsg(room, s)); }

function sanitizeEvent(e) {
  switch (e.t) {
    case 'play': return { t: 'play', p: e.p, card: e.card, suit: e.suit };
    case 'draw': return { t: 'draw', p: e.p, n: e.n, penalty: !!e.penalty };
    case 'skip': return { t: 'skip', p: e.p };
    case 'out': return { t: 'out', p: e.p };
    case 'reshuffle': return { t: 'reshuffle' };
    case 'over': return { t: 'over', loser: e.loser };
    default: return null;
  }
}

function viewFor(room, seat, events) {
  const st = room.st, me = idxOf(room, seat), t = now(), cur = st.current;
  const v = {
    t: 'state', me, host: idxOf(room, room.host), current: cur, over: st.over, loser: st.loser, phase: st.phase, roomPhase: room.phase, roomPhase: room.phase,
    suit: st.currentSuit, top: G.topCard(st), deck: st.deck.length,
    penalty: st.penalty ? { rank: st.penalty.rank, amount: G.penaltyAmount(st.penalty) } : null,
    players: st.players.map((p, i) => {
      const s = room.seats[i];
      return { name: s.name, count: p.hand.length, out: p.out, bot: !!s.bot, connected: !!(s.ws || s.bot), auto: !!(s.auto && !s.bot), left: !!s.left };
    }),
    hand: st.players[me].hand,                       // faqat o'z kartalari!
    justDrew: me === cur && st.justDrew ? st.justDrew : null,
    legal: null,
    pauseLeft: Math.max(0, room.pauseUntil - t), shuffleMs: SHUFFLE_MS,
    turnLeft: !st.over && room.turnEndsAt > t ? room.turnEndsAt - t : 0, turnMs: TURN_MS,
    events: events || [],
  };
  if (!st.over && me === cur) {
    const mv = G.legalMoves(st);
    v.legal = {
      play: [...new Set(mv.filter((m) => m.type === 'play').map((m) => m.card.r + m.card.s))],
      draw: mv.some((m) => m.type === 'draw'),
      pass: mv.some((m) => m.type === 'pass'),
    };
  }
  return v;
}
function broadcastState(room, events) {
  if (!room.st) return;
  for (const s of room.seats) if (s.ws) send(s.ws, viewFor(room, s, events));
}

/* ---------------- o'yin boshqaruvi ---------------- */
function beginPlayingAfterIntro(room) {
  if (!room || room.phase !== 'intro') return;
  clearTimeout(room.introTimer);
  room.introTimer = null;
  room.phase = 'playing';
  room.pauseUntil = 0;
  schedule(room);
  broadcastRoom(room);
  broadcastState(room, []);
}

function startGame(room) {
  const names = room.seats.map((s) => s.name);
  room.st = G.createGame(names);
  room.phase = 'intro';
  room.introReady = new Set();
  room.pauseUntil = 0;
  for (const s of room.seats) { s.timeouts = 0; s.auto = false; }
  room.introTimer = setTimeout(() => beginPlayingAfterIntro(room), INTRO_MAX_MS);
  broadcastRoom(room);
  broadcastState(room, []);
}

function schedule(room) {
  clearTimeout(room.timer);
  room.timer = null;
  if (room.phase !== 'playing' || !room.st || room.st.over) { room.turnEndsAt = 0; return; }
  const seat = room.seats[room.st.current], t = now(), wait = Math.max(0, room.pauseUntil - t);
  if (seat.bot || seat.auto || !seat.ws) {              // bot yoki uzilgan/avto o'yinchi
    room.turnEndsAt = 0;
    room.timer = setTimeout(() => autoPlay(room, false), wait + 800 + Math.random() * 700);
  } else {
    room.turnEndsAt = t + wait + TURN_MS;
    room.timer = setTimeout(() => autoPlay(room, true), wait + TURN_MS);
  }
}

function doMove(room, move) {
  const st = room.st;
  G.applyMove(st, move);                                // noqonuniy bo'lsa xato tashlaydi, holat o'zgarmaydi
  const events = st.events.map(sanitizeEvent).filter(Boolean);
  if (st.over) { room.phase = 'over'; }
  if (st.events.some((e) => e.t === 'reshuffle')) room.pauseUntil = now() + SHUFFLE_MS;
  schedule(room);
  broadcastState(room, events);
  if (room.phase === 'over') broadcastRoom(room);
}

function autoPlay(room, isTimeout) {
  if (room.phase !== 'playing' || !room.st || room.st.over) return;
  if (now() < room.pauseUntil) { schedule(room); return; }
  const seat = room.seats[room.st.current];
  if (isTimeout && !seat.bot) {
    seat.timeouts = (seat.timeouts || 0) + 1;
    if (seat.timeouts >= 2) seat.auto = true;           // ketma-ket 2 marta kechiksa, avto-rejim
  }
  let mv;
  try { mv = G.botMove(room.st); } catch (e) { mv = G.legalMoves(room.st)[0]; }
  try { doMove(room, mv); } catch (e) { console.error('autoplay xatosi:', e.message); }
}

function parseMove(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type;
  if (type === 'draw' || type === 'pass') return { type };
  if (type !== 'play' || !raw.card || typeof raw.card !== 'object') return null;
  const r = String(raw.card.r), s = String(raw.card.s);
  if (!G.RANKS.includes(r) || !G.SUITS.includes(s)) return null;
  const mv = { type: 'play', card: { r, s } };
  if (raw.suit != null && G.SUITS.includes(String(raw.suit))) mv.suit = String(raw.suit);
  return mv;
}

/* ---------------- xona operatsiyalari ---------------- */
function makeSeat(name, ws, bot) {
  return { name, token: bot ? null : crypto.randomBytes(18).toString('hex'), ws: ws || null, bot: !!bot, auto: false, timeouts: 0, disc: 0, left: false };
}

function removeRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.introTimer);
  for (const s of room.seats) if (s.ws) { s.ws.ctx.room = null; s.ws.ctx.seat = null; }
  rooms.delete(room.code);
}

function leaveRoom(ws) {
  const ctx = ws.ctx, room = ctx.room, seat = ctx.seat;
  ctx.room = null; ctx.seat = null;
  if (!room || !seat) return;
  seat.ws = null; seat.token = null;
  if (room.phase === 'lobby') {
    room.seats.splice(room.seats.indexOf(seat), 1);
    if (!room.seats.some((s) => !s.bot)) { removeRoom(room); return; }
    ensureHost(room); broadcastRoom(room);
  } else {
    seat.left = true; seat.auto = true;                 // o'yin davom etadi, o'rniga bot o'ynaydi
    ensureHost(room);
    schedule(room); broadcastRoom(room); broadcastState(room, []);
  }
}

function attachSeat(room, seat, ws) {
  if (seat.ws && seat.ws !== ws) { seat.ws.ctx.room = null; seat.ws.ctx.seat = null; seat.ws.close(1000); }
  seat.ws = ws; seat.disc = 0; seat.auto = false; seat.timeouts = 0; room.emptySince = 0;
  ws.ctx.room = room; ws.ctx.seat = seat;
}

function handle(ws, m) {
  const ctx = ws.ctx;
  const room = ctx.room, seat = ctx.seat;
  switch (m.t) {
    case 'create': {
      if (room) return err(ws, 'Siz allaqachon xonadasiz');
      if (rooms.size >= MAX_ROOMS) return err(ws, "Server band, keyinroq urinib ko'ring");
      const name = cleanName(m.name) || 'Mehmon';
      const code = genCode(); if (!code) return err(ws, 'Xona yaratib bo\'lmadi');
      const r = { code, seats: [], host: null, phase: 'lobby', st: null, timer: null, pauseUntil: 0, turnEndsAt: 0, emptySince: 0 };
      const s = makeSeat(name, ws, false);
      r.seats.push(s); r.host = s; rooms.set(code, r);
      attachSeat(r, s, ws);
      send(ws, { t: 'joined', code, token: s.token, name, you: 0 });
      if (m.practice) {                                   // botlar bilan mashq: 3 ta bot qo'shib darhol boshlaymiz
        for (let i = 0; i < 3; i++) r.seats.push(makeSeat(uniqueName(r, BOT_NAMES[i]), null, true));
        startGame(r);
      } else broadcastRoom(r);
      return;
    }
    case 'join': {
      if (room) return err(ws, 'Siz allaqachon xonadasiz');
      const code = String(m.code || '').toUpperCase().trim();
      const r = /^[A-Z0-9]{5}$/.test(code) ? rooms.get(code) : null;
      if (!r) return err(ws, 'Bunday xona topilmadi');
      if (r.phase !== 'lobby') return err(ws, "O'yin allaqachon boshlangan");
      if (r.seats.length >= 5) return err(ws, "Xona to'la (5/5)");
      const s = makeSeat(uniqueName(r, cleanName(m.name) || 'Mehmon'), ws, false);
      r.seats.push(s); attachSeat(r, s, ws);
      send(ws, { t: 'joined', code, token: s.token, name: s.name, you: r.seats.length - 1 });
      broadcastRoom(r);
      return;
    }
    case 'rejoin': {
      if (room) return;
      const code = String(m.code || '').toUpperCase().trim(), token = String(m.token || '');
      const r = rooms.get(code);
      const s = r && token.length > 10 ? r.seats.find((x) => x.token && x.token === token && !x.left) : null;
      if (!s) return err(ws, 'Xona topilmadi yoki vaqti tugagan', true);
      attachSeat(r, s, ws);
      send(ws, { t: 'joined', code, token: s.token, name: s.name, you: idxOf(r, s) });
      ensureHost(r);
      broadcastRoom(r);
      if (r.st) { schedule(r); broadcastState(r, []); }
      return;
    }
    case 'start': {
      if (!room || room.host !== seat || room.phase !== 'lobby') return;
      if (room.seats.length < 3) return err(ws, "Kamida 3 o'yinchi kerak (bot qo'shing)");
      return startGame(room);
    }
    case 'introDone': {
      if (!room || !seat || room.phase !== 'intro') return;
      if (!room.introReady) room.introReady = new Set();
      room.introReady.add(seat.token || seat.name);
      const waiting = room.seats.filter((s) => !s.bot && s.ws && !s.left);
      if (waiting.every((s) => room.introReady.has(s.token || s.name))) beginPlayingAfterIntro(room);
      return;
    }
    case 'addBot': {
      if (!room || room.host !== seat || room.phase !== 'lobby') return;
      if (room.seats.length >= 5) return err(ws, "Xona to'la");
      const free = BOT_NAMES.find((n) => !room.seats.some((s) => s.name === n)) || 'Bot' + room.seats.length;
      room.seats.push(makeSeat(free, null, true));
      return broadcastRoom(room);
    }
    case 'removeBot': {
      if (!room || room.host !== seat || room.phase !== 'lobby') return;
      const i = +m.idx;
      if (Number.isInteger(i) && room.seats[i] && room.seats[i].bot) { room.seats.splice(i, 1); broadcastRoom(room); }
      return;
    }
    case 'rematch': {
      if (!room || room.host !== seat || room.phase !== 'over') return;
      room.seats = room.seats.filter((s) => s.bot || (s.ws && !s.left));
      room.st = null; room.pauseUntil = 0; room.turnEndsAt = 0;
      for (const s of room.seats) { s.auto = false; s.timeouts = 0; }
      ensureHost(room);
      if (room.seats.length >= 3) return startGame(room);
      room.phase = 'lobby'; return broadcastRoom(room);
    }
    case 'move': {
      if (!room || !seat || room.phase !== 'playing') return err(ws, room && room.phase === 'intro' ? 'Intro videosi tugashini kuting' : 'Hozir yurish mumkin emas');
      const st = room.st;
      if (st.current !== idxOf(room, seat)) return err(ws, 'Navbat sizniki emas');
      if (now() < room.pauseUntil) return err(ws, 'Kartalar aralashtirilmoqda, kuting');
      const mv = parseMove(m.move);
      if (!mv) return err(ws, "Noto'g'ri yurish");
      seat.timeouts = 0; seat.auto = false;
      try { doMove(room, mv); } catch (e) { err(ws, "Bu yurish mumkin emas"); send(ws, viewFor(room, seat, [])); }
      return;
    }
    case 'emoji': {
      if (!room || !seat) return;
      const t = now(); if (t - (seat.emojiAt || 0) < 800) return;
      if (!EMOJIS.includes(m.e)) return;
      seat.emojiAt = t;
      const msg = { t: 'emoji', from: idxOf(room, seat), e: m.e };
      for (const s of room.seats) if (s.ws) send(s.ws, msg);
      return;
    }
    case 'leave': {
      leaveRoom(ws);
      return send(ws, { t: 'left' });
    }
    default:
  }
}

function onClose(ws) {
  const ctx = ws.ctx, room = ctx.room, seat = ctx.seat;
  if (!room || !seat || seat.ws !== ws) return;
  seat.ws = null; seat.disc = now();
  if (room.phase === 'lobby') { broadcastRoom(room); return; }
  ensureHost(room);
  schedule(room);                                        // agar navbati unda bo'lsa, bot o'ynab turadi
  broadcastRoom(room);
  broadcastState(room, []);
}

/* ---------------- HTTP ---------------- */
const INDEX = path.join(__dirname, 'public', 'index.html');
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'none'",
};
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SEC); return res.end(); }
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (e, data) => {
      if (e) { res.writeHead(500, SEC); return res.end('index.html topilmadi'); }
      res.writeHead(200, { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  } else if (url.startsWith('/assets/')) {
    const assetName = path.basename(decodeURIComponent(url.slice('/assets/'.length)));
    const assetPath = path.join(__dirname, 'public', 'assets', assetName);
    const types = { '.wav': 'audio/wav', '.mp4': 'video/mp4' };
    const type = types[path.extname(assetName).toLowerCase()];
    if (!type) { res.writeHead(404, SEC); return res.end('Not found'); }
    fs.stat(assetPath, (statErr, stat) => {
      if (statErr || !stat.isFile()) { res.writeHead(404, SEC); return res.end('Not found'); }
      const baseHeaders = { ...SEC, 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'Accept-Ranges': 'bytes' };
      const range = req.headers.range;
      if (range && path.extname(assetName).toLowerCase() === '.mp4') {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) { res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
        let start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 0));
        let end = match[2] && match[1] ? Number(match[2]) : stat.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= stat.size || end < start) {
          res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` }); return res.end();
        }
        end = Math.min(end, stat.size - 1);
        res.writeHead(206, { ...baseHeaders, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(assetPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(assetPath).pipe(res);
      }
    });
  } else if (url === '/healthz') {
    res.writeHead(200, { ...SEC, 'Content-Type': 'text/plain' }); res.end('ok ' + rooms.size);
  } else if (url === '/favicon.ico') {
    res.writeHead(204, SEC); res.end();
  } else { res.writeHead(404, SEC); res.end('Not found'); }
});

attach(server, '/ws', (ws, req) => {
  ws.ctx = { room: null, seat: null, count: 0, win: now() };
  ws.on('message', (raw) => {
    const t = now();
    if (t - ws.ctx.win > 5000) { ws.ctx.win = t; ws.ctx.count = 0; }
    ws.ctx.count++;
    if (ws.ctx.count > 200) return ws.terminate();       // spam
    if (ws.ctx.count > 40) return;                       // tashlab yuboramiz
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error('handle xatosi:', e); }
  });
  ws.on('close', () => onClose(ws));
}, {
  maxPayload: 2048,
  verifyOrigin: ALLOWED_ORIGIN ? (req) => req.headers.origin === ALLOWED_ORIGIN : null,
});

/* ---------------- tozalash ---------------- */
setInterval(() => {
  const t = now();
  for (const room of [...rooms.values()]) {
    if (room.phase === 'lobby') {
      const before = room.seats.length;
      room.seats = room.seats.filter((s) => s.bot || s.ws || (s.disc && t - s.disc < LOBBY_GRACE_MS));
      if (!room.seats.some((s) => !s.bot)) { removeRoom(room); continue; }
      if (room.seats.length !== before) { ensureHost(room); broadcastRoom(room); }
    } else {
      const online = room.seats.some((s) => s.ws);
      if (online) room.emptySince = 0;
      else if (!room.emptySince) room.emptySince = t;
      else if (t - room.emptySince > EMPTY_ROOM_MS) removeRoom(room);
    }
  }
}, 2000).unref();

server.listen(PORT, '0.0.0.0', () => console.log('108 server: http://localhost:' + PORT));
process.on('SIGTERM', () => { server.close(); process.exit(0); });
