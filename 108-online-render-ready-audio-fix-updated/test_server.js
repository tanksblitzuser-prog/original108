'use strict';
// Serverni haqiqiy WebSocket mijozlar bilan sinaydi. Ishga tushirish: node test_server.js
const { spawn } = require('child_process');
const assert = require('assert');
const http = require('http');

const PORT = 3111;
const ENV = { ...process.env, PORT: String(PORT), TURN_MS: '600', SHUFFLE_MS: '500', LOBBY_GRACE_MS: '1200', EMPTY_ROOM_MS: '60000' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('OK  ' + name); }

class Client {
  constructor() {
    this.ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    this.msgs = []; this.pos = 0; this.closed = false; this.onMsg = null; this.token = null; this.code = null; this.you = null;
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); this.msgs.push(m); if (m.t === 'joined') { this.token = m.token; this.code = m.code; this.you = m.you; } if (m.t === 'room' && m.phase === 'intro') setTimeout(() => { if (this.ws.readyState === WebSocket.OPEN) this.send({ t: 'introDone' }); }, 10); if (this.onMsg) this.onMsg(m); };
    this.ws.onclose = () => { this.closed = true; };
    this.opened = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  raw(s) { this.ws.send(s); }
  async next(pred, ms = 4000) {
    const t0 = Date.now();
    for (;;) {
      for (let i = this.pos; i < this.msgs.length; i++) if (pred(this.msgs[i])) { this.pos = i + 1; return this.msgs[i]; }
      if (Date.now() - t0 > ms) throw new Error('kutilgan xabar kelmadi');
      await sleep(15);
    }
  }
  last(type) { for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === type) return this.msgs[i]; return null; }
  close() { try { this.ws.close(); } catch (e) { /* */ } }
}
async function mk() { const c = new Client(); await c.opened; return c; }

// Mijoz o'zi tasodifiy mos yurishlar qilib o'ynaydi
function autoplay(c, opts = {}) {
  c.stats = { moves: 0, errors: 0, sawPauseTurn: false, reshuffles: 0, over: false, loser: null };
  c.onMsg = (m) => {
    if (m.t === 'error') c.stats.errors++;
    if (m.t !== 'state') return;
    c.last_ = m;
    if (m.events.some((e) => e.t === 'reshuffle')) c.stats.reshuffles++;
    if (m.over) { c.stats.over = true; c.stats.loser = m.loser; return; }
    if (!m.legal || opts.idle) return;
    if (m.pauseLeft > 0) { c.stats.sawPauseTurn = true; if (opts.probePause && !c.probed) { c.probed = true; c.send({ t: 'move', move: { type: 'draw' } }); } return; }
    const opts_ = [];
    for (const k of m.legal.play) opts_.push({ type: 'play', card: { r: k.slice(0, -1), s: k.slice(-1) }, suit: ['H', 'D', 'C', 'S'][Math.floor(Math.random() * 4)] });
    if (m.legal.draw) opts_.push({ type: 'draw' });
    if (m.legal.pass && !m.legal.play.length) opts_.push({ type: 'pass' });
    const pick = opts_[Math.floor(Math.random() * opts_.length)];
    setTimeout(() => { c.send({ t: 'move', move: pick }); c.stats.moves++; }, 5 + Math.random() * 20);
  };
}

async function newRoom(n = 3) {
  const cs = [await mk()];
  cs[0].send({ t: 'create', name: 'Host' });
  const j = await cs[0].next((m) => m.t === 'joined');
  for (let i = 1; i < n; i++) {
    const c = await mk(); c.send({ t: 'join', code: j.code, name: 'P' + i });
    await c.next((m) => m.t === 'joined'); cs.push(c);
  }
  return { code: j.code, cs };
}

(async () => {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr += d; });
  await sleep(700);
  try {
    await test('healthz va bosh sahifa', async () => {
      const get = (p) => new Promise((res, rej) => http.get({ port: PORT, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ s: r.statusCode, b, h: r.headers })); }).on('error', rej));
      const h = await get('/healthz'); assert.strictEqual(h.s, 200);
      const i = await get('/'); assert.strictEqual(i.s, 200); assert.ok(i.b.includes('108'));
      assert.strictEqual(i.h['x-content-type-options'], 'nosniff');
      assert.strictEqual((await get('/yoq')).s, 404);
    });

    await test('Xona yaratish, qo\'shilish, 5 belgili kod, noto\'g\'ri kod rad etiladi', async () => {
      const { code, cs } = await newRoom(3);
      assert.ok(/^[A-HJ-NP-Z2-9]{5}$/.test(code), code);
      const room = cs[0].last('room'); assert.strictEqual(room.seats.length, 3); assert.strictEqual(room.host, 0); assert.strictEqual(room.phase, 'lobby');
      const x = await mk(); x.send({ t: 'join', code: 'ZZZZZ', name: 'X' });
      assert.ok((await x.next((m) => m.t === 'error')).msg.includes('topilmadi'));
      x.send({ t: 'join', code: '<b>', name: 'X' });
      assert.ok((await x.next((m) => m.t === 'error')));
      cs.forEach((c) => c.close()); x.close();
    });

    await test('Ism tozalanadi (HTML belgilar olib tashlanadi), takroriy ism o\'zgartiriladi', async () => {
      const a = await mk(); a.send({ t: 'create', name: '  <script>alert(1)</script>Ali&"  ' });
      const j = await a.next((m) => m.t === 'joined'); assert.ok(!/[<>&"]/.test(j.name), j.name); assert.ok(j.name.length <= 14);
      const b = await mk(); b.send({ t: 'join', code: j.code, name: j.name });
      const jb = await b.next((m) => m.t === 'joined'); assert.notStrictEqual(jb.name, j.name);
      a.close(); b.close();
    });

    await test('Xona 5 kishidan ortiq bo\'lmaydi; boshlangan o\'yinga qo\'shilib bo\'lmaydi', async () => {
      const { code, cs } = await newRoom(5);
      const x = await mk(); x.send({ t: 'join', code, name: 'Oltinchi' });
      assert.ok((await x.next((m) => m.t === 'error')).msg.includes('to\'la'));
      cs[0].send({ t: 'start' }); await cs[0].next((m) => m.t === 'state');
      const y = await mk(); y.send({ t: 'join', code, name: 'Kech' });
      assert.ok((await y.next((m) => m.t === 'error')).msg.includes('boshlangan'));
      [...cs, x, y].forEach((c) => c.close());
    });

    await test('Faqat host boshlaydi va kamida 3 o\'yinchi kerak', async () => {
      const a = await mk(); a.send({ t: 'create', name: 'A' }); const j = await a.next((m) => m.t === 'joined');
      a.send({ t: 'start' }); assert.ok((await a.next((m) => m.t === 'error')).msg.includes('3'));
      const b = await mk(); b.send({ t: 'join', code: j.code, name: 'B' }); await b.next((m) => m.t === 'joined');
      a.send({ t: 'addBot' }); await a.next((m) => m.t === 'room' && m.seats.length === 3);
      b.send({ t: 'start' }); await sleep(150);
      assert.ok(!b.msgs.some((m) => m.t === 'state'), 'host bo\'lmagan o\'yinchi boshladi');
      a.send({ t: 'start' }); await a.next((m) => m.t === 'state');
      a.close(); b.close();
    });

    await test('MAXFIYLIK: faqat o\'z kartalari yuboriladi, hamma kartalar 36 ta', async () => {
      const { cs } = await newRoom(4);
      cs[0].send({ t: 'start' });
      const states = await Promise.all(cs.map((c) => c.next((m) => m.t === 'state')));
      const seen = new Set();
      states.forEach((s, i) => {
        assert.strictEqual(s.me, i); assert.strictEqual(s.hand.length, 4);
        s.hand.forEach((c) => { assert.ok(!seen.has(c.r + c.s), 'bir xil karta ikki kishida'); seen.add(c.r + c.s); });
        s.players.forEach((p) => { assert.ok(!('hand' in p) && !('cards' in p)); assert.strictEqual(p.count, 4); });
        assert.ok(!('deckCards' in s));
        const txt = JSON.stringify(s);
        // boshqa o'yinchi kartasi JSON ichida uchramasligi kerak (top kartadan tashqari)
        states.forEach((o, j) => { if (j !== i) o.hand.forEach((c) => { if (c.r + c.s !== s.top.r + s.top.s) assert.ok(!txt.includes(JSON.stringify(c)), 'boshqa kartasi sizib chiqdi'); }); });
      });
      assert.strictEqual(seen.size, 16); assert.strictEqual(states[0].deck + 16 + 1, 36);
      assert.ok(states.filter((s) => s.legal).length <= 1, 'faqat navbatdagiga legal yuboriladi');
      cs.forEach((c) => c.close());
    });

    await test('Navbatsiz va noqonuniy yurishlar rad etiladi, noto\'g\'ri JSON serverni yiqitmaydi', async () => {
      const { cs } = await newRoom(3);
      cs[0].send({ t: 'start' });
      const st = await Promise.all(cs.map((c) => c.next((m) => m.t === 'state')));
      const cur = st[0].current, other = (cur + 1) % 3;
      cs[other].send({ t: 'move', move: { type: 'draw' } });
      assert.ok((await cs[other].next((m) => m.t === 'error')).msg.includes('Navbat'));
      cs[cur].raw('{bu json emas'); cs[cur].raw('[]'); cs[cur].raw('"x"'); cs[cur].raw(JSON.stringify({ t: 5 }));
      cs[cur].send({ t: 'move', move: { type: 'play', card: { r: 'Z', s: 'X' } } });
      assert.ok((await cs[cur].next((m) => m.t === 'error')).msg.includes('Noto'));
      // qo'lida bo'lmagan karta
      const mine = new Set(st[cur].hand.map((c) => c.r + c.s));
      const all = []; for (const r of ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']) for (const s of ['H', 'D', 'C', 'S']) if (!mine.has(r + s)) all.push({ r, s });
      cs[cur].send({ t: 'move', move: { type: 'play', card: all[0] } });
      assert.ok((await cs[cur].next((m) => m.t === 'error')).msg.includes('mumkin emas'));
      // server tirik
      cs[cur].send({ t: 'emoji', e: '👍' }); await cs[cur].next((m) => m.t === 'emoji');
      cs.forEach((c) => c.close());
    });

    await test('Spam va katta xabar: ulanish yopiladi', async () => {
      const c = await mk(); c.raw('x'.repeat(5000)); await sleep(300); assert.ok(c.closed);
      const d = await mk(); for (let i = 0; i < 400; i++) d.raw('{"t":"zz"}'); await sleep(400); assert.ok(d.closed);
    });

    await test('To\'liq o\'yin: 3 ta haqiqiy mijoz o\'ynab oxirigacha yetadi (10 ta o\'yin)', async () => {
      for (let g = 0; g < 10; g++) {
        const { cs } = await newRoom(3 + (g % 3));
        cs.forEach((c) => autoplay(c)); cs[0].send({ t: 'start' });
        const t0 = Date.now();
        while (!cs.every((c) => c.stats.over) && Date.now() - t0 < 25000) await sleep(50);
        assert.ok(cs.every((c) => c.stats.over), 'o\'yin tugamadi g=' + g);
        const loser = cs[0].stats.loser; assert.ok(Number.isInteger(loser));
        cs.forEach((c) => assert.strictEqual(c.stats.loser, loser));
        const fin = cs[0].last_; assert.strictEqual(fin.players.filter((p) => !p.out).length, 1);
        cs.forEach((c) => c.close());
      }
    });

    await test('Rematch: host qayta boshlaydi, yangi kartalar tarqatiladi', async () => {
      const { cs } = await newRoom(3);
      cs.forEach((c) => autoplay(c)); cs[0].send({ t: 'start' });
      const t0 = Date.now(); while (!cs.every((c) => c.stats.over) && Date.now() - t0 < 25000) await sleep(50);
      assert.ok(cs.every((c) => c.stats.over));
      cs[1].send({ t: 'rematch' }); await sleep(150);
      assert.ok(!cs[1].last_.events.length || cs[1].last_.over, 'host bo\'lmagan boshlay olmaydi');
      cs.forEach((c) => c.onMsg = null);
      cs[0].send({ t: 'rematch' });
      const s = await cs[0].next((m) => m.t === 'state' && !m.over && m.hand.length === 4);
      assert.strictEqual(s.players.length, 3);
      cs.forEach((c) => c.close());
    });

    await test('Taymer: javob bermagan o\'yinchi uchun server avto-yuradi, 2 martadan keyin avto-rejim', async () => {
      const { cs } = await newRoom(3);
      cs[0].send({ t: 'start' });
      const t0 = Date.now(); let sawAuto = false;
      while (Date.now() - t0 < 12000 && !sawAuto) {
        await sleep(100);
        const s = cs[0].last('state'); if (s && s.players.some((p) => p.auto)) sawAuto = true;
        if (s && s.over) break;
      }
      assert.ok(sawAuto || cs[0].last('state').over, 'avto-rejim ishga tushmadi');
      // o'yin qotib qolmaydi: holat yangilanib turadi
      assert.ok(cs[0].msgs.filter((m) => m.t === 'state').length > 4);
      cs.forEach((c) => c.close());
    });

    await test('Uzilish va qayta ulanish: bot o\'rniga o\'ynaydi, token bilan qaytadi', async () => {
      const { code, cs } = await newRoom(3);
      cs[0].send({ t: 'start' });
      const s0 = await cs[1].next((m) => m.t === 'state');
      const token = cs[1].token, myHand = s0.hand.map((c) => c.r + c.s).sort().join();
      cs[1].close();
      const off = await cs[0].next((m) => m.t === 'state' && m.players[1].connected === false);
      assert.strictEqual(off.players[1].connected, false);
      const before = cs[0].last('state');
      await sleep(2500);                                    // o'yin davom etadi (bot yuradi)
      const mid = cs[0].last('state');
      assert.ok(mid.deck !== before.deck || mid.current !== before.current || mid.players.some((p, i) => p.count !== before.players[i].count) || mid.over, 'o\'yin to\'xtab qoldi');
      const r = await mk(); r.send({ t: 'rejoin', code, token });
      const j = await r.next((m) => m.t === 'joined'); assert.strictEqual(j.you, 1);
      const st = await r.next((m) => m.t === 'state'); assert.strictEqual(st.me, 1);
      assert.ok(st.hand.length > 0 || st.over);
      const back = await cs[0].next((m) => m.t === 'state' && m.players[1].connected === true);
      assert.ok(back);
      // yaroqsiz token
      const z = await mk(); z.send({ t: 'rejoin', code, token: 'a'.repeat(36) });
      assert.strictEqual((await z.next((m) => m.t === 'error')).fatal, true);
      [cs[0], cs[2], r, z].forEach((c) => c.close());
    });

    await test('Aralashtirish pauzasi: ruxsat etilmagan yurishlar rad etiladi, o\'yin davom etadi', async () => {
      let probed = 0, rejected = 0, reshuffles = 0;
      for (let g = 0; g < 40 && !rejected; g++) {
        const { cs } = await newRoom(5);
        cs.forEach((c) => autoplay(c, { probePause: true }));
        cs[0].send({ t: 'start' });
        const t0 = Date.now();
        while (!cs.every((c) => c.stats.over) && Date.now() - t0 < 25000) await sleep(40);
        assert.ok(cs.every((c) => c.stats.over));
        cs.forEach((c) => { reshuffles += c.stats.reshuffles; if (c.probed) { probed++; if (c.msgs.some((m) => m.t === 'error' && m.msg.includes('aralashtirilmoqda'))) rejected++; } });
        cs.forEach((c) => c.close());
      }
      assert.ok(reshuffles > 0, 'aralashtirish sodir bo\'lmadi');
      assert.ok(probed > 0 && rejected > 0, 'pauza tekshiruvi sinalmadi (probed=' + probed + ')');
    });

    await test('Botlar bilan mashq xonasi darhol boshlanadi va botlar o\'ynaydi', async () => {
      const a = await mk(); a.send({ t: 'create', name: 'Men', practice: true });
      const s = await a.next((m) => m.t === 'state');
      assert.strictEqual(s.players.length, 4); assert.strictEqual(s.players.filter((p) => p.bot).length, 3);
      await sleep(3500);
      assert.ok(a.msgs.filter((m) => m.t === 'state').length >= 2, 'botlar yurmadi');
      a.close();
    });

    await test('Lobbida uzilgan o\'yinchi muddatdan keyin olib tashlanadi, host o\'tadi', async () => {
      const a = await mk(); a.send({ t: 'create', name: 'A' }); const j = await a.next((m) => m.t === 'joined');
      const b = await mk(); b.send({ t: 'join', code: j.code, name: 'B' }); await b.next((m) => m.t === 'joined');
      a.close();
      const r = await b.next((m) => m.t === 'room' && m.seats.length === 1, 6000);
      assert.strictEqual(r.host, 0);
      b.close();
    });

    await test('Emoji faqat ruxsat etilgan to\'plamdan', async () => {
      const { cs } = await newRoom(3);
      cs[0].send({ t: 'emoji', e: '💣' }); await sleep(150);
      assert.ok(!cs[1].msgs.some((m) => m.t === 'emoji'));
      cs[0].send({ t: 'emoji', e: '🔥' }); const e = await cs[1].next((m) => m.t === 'emoji'); assert.strictEqual(e.from, 0);
      cs.forEach((c) => c.close());
    });

    await test('Chiqish: o\'yin paytida chiqqan o\'rniga bot o\'ynaydi', async () => {
      const { cs } = await newRoom(3);
      cs[0].send({ t: 'start' }); await cs[2].next((m) => m.t === 'state');
      cs[1].send({ t: 'leave' }); await cs[1].next((m) => m.t === 'left');
      const s = await cs[0].next((m) => m.t === 'state' && m.players[1].left === true);
      assert.ok(s);
      cs.forEach((c) => c.close());
    });

    console.log('\n' + passed + ' ta server testi o\'tdi');
    if (srvErr.trim()) { console.log('SERVER STDERR:\n' + srvErr); process.exitCode = 1; }
  } catch (e) {
    console.error('XATO:', e.stack || e); if (srvErr) console.error('SERVER STDERR:\n' + srvErr); process.exitCode = 1;
  } finally { srv.kill(); setTimeout(() => process.exit(), 200); }
})();
