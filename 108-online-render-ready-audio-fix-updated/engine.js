/* 108 — qoidalar mexanizmi (UI va tarmoqsiz). Brauzerda ham, Node.js da ham ishlaydi. */
(function (root) {
  'use strict';

  const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const SUITS = ['H', 'D', 'C', 'S'];
  const SYMBOL = { H: '♥', D: '♦', C: '♣', S: '♠' };

  function makeDeck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
    return d;
  }

  function shuffle(a, rng) {
    rng = rng || Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const same = (a, b) => a.r === b.r && a.s === b.s;

  function createGame(names, rng) {
    rng = rng || Math.random;
    if (names.length < 3 || names.length > 5) throw new Error('3-5 o\'yinchi kerak');
    const deck = shuffle(makeDeck(), rng);
    const players = names.map((name, id) => ({ id, name, hand: [], out: false }));
    for (let k = 0; k < 4; k++) for (const p of players) p.hand.push(deck.pop());

    // Birinchi karta oddiy bo'lishi kerak (9, 10, J, K). Maxsus chiqsa — qaytarib aralashtiramiz.
    const special = ['6', '7', '8', 'A', 'Q'];
    const back = [];
    let first = null;
    while (deck.length) {
      const c = deck.pop();
      if (special.includes(c.r)) back.push(c); else { first = c; break; }
    }
    if (!first) first = back.pop();
    deck.push(...back);
    shuffle(deck, rng);

    return {
      rng,
      players,
      deck,
      discard: [first],
      current: Math.floor(rng() * players.length),
      currentSuit: first.s,
      penalty: null,        // { rank: '6'|'7', count }
      phase: 'normal',      // 'normal' | 'cover' (8 ni yopish)
      justDrew: null,       // olingan va tashlash mumkin bo'lgan karta
      over: false,
      loser: null,
      events: [],
    };
  }

  function topCard(st) { return st.discard[st.discard.length - 1]; }

  function reshuffle(st) {
    if (st.discard.length <= 1) return false;
    const top = st.discard.pop();
    const rest = st.discard;
    st.discard = [top];
    shuffle(rest, st.rng);
    st.deck.push(...rest);
    st.events.push({ t: 'reshuffle' });
    return true;
  }

  // Bitta karta olish. Koloda bo'sh bo'lsa — aralashtiriladi. Karta yo'q bo'lsa null.
  function drawOne(st, p) {
    if (!st.deck.length) reshuffle(st);
    if (!st.deck.length) return null;
    const c = st.deck.pop();
    p.hand.push(c);
    return c;
  }

  function drawMany(st, p, n) {
    let got = 0;
    for (let i = 0; i < n; i++) { if (drawOne(st, p)) got++; else break; }
    return got;
  }

  function canPlayNormal(st, c) {
    return c.r === 'Q' || c.s === st.currentSuit || c.r === topCard(st).r;
  }

  function penaltyAmount(pen) { return pen.rank === '7' ? 2 * pen.count : pen.count; }

  function legalMoves(st) {
    if (st.over) return [];
    const p = st.players[st.current];
    const plays = (pred) => p.hand.filter(pred).map((card) => ({ type: 'play', card }));

    if (st.justDrew) {
      return [{ type: 'play', card: st.justDrew }, { type: 'pass' }];
    }
    if (st.phase === 'cover') {
      const m = plays((c) => c.s === st.currentSuit || c.r === '8' || c.r === 'Q');
      return m.length ? m : [{ type: 'draw' }];
    }
    if (st.penalty) {
      return [...plays((c) => c.r === st.penalty.rank), { type: 'draw' }];
    }
    const m = plays((c) => canPlayNormal(st, c));
    // Oddiy navbatda mos karta bo'lsa ham, o'yinchi kolodadan qo'shimcha karta olishi mumkin.
    return m.length ? [...m, { type: 'draw' }] : [{ type: 'draw' }];
  }

  function bestSuit(hand) {
    const cnt = { H: 0, D: 0, C: 0, S: 0 };
    for (const c of hand) cnt[c.s]++;
    return SUITS.slice().sort((a, b) => cnt[b] - cnt[a])[0];
  }

  function nextActive(st, from) {
    const n = st.players.length;
    let j = from;
    for (let i = 0; i < n; i++) {
      j = (j + 1) % n;
      if (!st.players[j].out) return j;
    }
    return from;
  }

  // Navbat yakuni: chiqish, o'yin tugashi, navbatni uzatish
  function finishTurn(st, p, skip) {
    if (p.hand.length === 0 && !p.out) {
      p.out = true;
      st.events.push({ t: 'out', p: p.id });
    }
    const active = st.players.filter((x) => !x.out);
    if (active.length <= 1) {
      st.over = true;
      st.loser = active[0] ? active[0].id : null;
      st.events.push({ t: 'over', loser: st.loser });
      return;
    }
    let next = nextActive(st, st.current);
    if (skip) {
      const skipped = next;
      next = nextActive(st, next);
      st.events.push({ t: 'skip', p: skipped });
    }
    st.current = next;
  }

  function playCard(st, p, card, suit) {
    const idx = p.hand.findIndex((c) => same(c, card));
    if (idx < 0) throw new Error('Karta qo\'lda yo\'q');
    p.hand.splice(idx, 1);
    st.discard.push(card);
    st.justDrew = null;

    if (card.r === 'Q') {
      st.currentSuit = SUITS.includes(suit) ? suit : bestSuit(p.hand.length ? p.hand : [card]);
    } else {
      st.currentSuit = card.s;
    }
    st.events.push({ t: 'play', p: p.id, card, suit: st.currentSuit });

    if (card.r === '8') {       // ko'tini yopish kerak, navbat shu o'yinchida qoladi
      st.phase = 'cover';
      return;
    }
    st.phase = 'normal';

    let skip = false;
    if (card.r === '6' || card.r === '7') {
      st.penalty = st.penalty && st.penalty.rank === card.r
        ? { rank: card.r, count: st.penalty.count + 1 }
        : { rank: card.r, count: 1 };
    } else if (card.r === 'A') {
      skip = true;
    }
    finishTurn(st, p, skip);
  }

  function applyMove(st, move) {
    if (st.over) throw new Error('O\'yin tugagan');
    const legal = legalMoves(st);
    const ok = legal.some((m) => m.type === move.type && (m.type !== 'play' || same(m.card, move.card)));
    if (!ok) throw new Error('Noqonuniy yurish: ' + JSON.stringify(move));

    st.events = [];
    const p = st.players[st.current];

    if (move.type === 'pass') {
      st.justDrew = null;
      finishTurn(st, p, false);
      return st;
    }

    if (move.type === 'play') {
      playCard(st, p, move.card, move.suit);
      return st;
    }

    // draw
    if (st.phase === 'cover') {
      let found = null;
      while (!found) {
        const c = drawOne(st, p);
        if (!c) break;
        if (c.s === st.currentSuit) found = c;
      }
      st.events.push({ t: 'draw', p: p.id, n: 'cover' });
      if (found) {
        playCard(st, p, found, null);
      } else {
        st.phase = 'normal';
        finishTurn(st, p, false);
      }
      return st;
    }

    if (st.penalty) {
      const n = penaltyAmount(st.penalty);
      const got = drawMany(st, p, n);
      st.events.push({ t: 'draw', p: p.id, n: got, penalty: true });
      st.penalty = null;
      finishTurn(st, p, false);
      return st;
    }

    const c = drawOne(st, p);
    st.events.push({ t: 'draw', p: p.id, n: c ? 1 : 0 });
    if (c && canPlayNormal(st, c)) {
      st.justDrew = c;
    } else {
      finishTurn(st, p, false);
    }
    return st;
  }

  // ---- Oddiy bot ----
  function botMove(st) {
    const moves = legalMoves(st);
    const p = st.players[st.current];
    const plays = moves.filter((m) => m.type === 'play');
    if (!plays.length) return moves[0];
    const rng = st.rng;

    const suitCount = {};
    for (const c of p.hand) suitCount[c.s] = (suitCount[c.s] || 0) + 1;

    let best = null, bestScore = -Infinity;
    for (const m of plays) {
      const c = m.card;
      let s = rng() * 0.8 + (suitCount[c.s] || 0) * 0.3;
      if (st.penalty) s += 5;                              // jarimani uzatish
      if (c.r === 'Q') s -= 3;                             // Damani asrash
      if (c.r === '8') s += p.hand.some((x) => x.s === c.s && !same(x, c)) ? 1 : -2;
      if (c.r === '6' || c.r === '7' || c.r === 'A') s += 2;
      if (st.justDrew) s += 10;
      if (s > bestScore) { bestScore = s; best = m; }
    }
    if (st.justDrew && !best) return { type: 'pass' };
    return best.card.r === 'Q' ? { type: 'play', card: best.card, suit: bestSuit(p.hand.filter((x) => !same(x, best.card))) } : best;
  }

  const api = {
    RANKS, SUITS, SYMBOL, makeDeck, shuffle, createGame, legalMoves, applyMove,
    botMove, topCard, penaltyAmount, canPlayNormal, same,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Game108 = api;
})(typeof window !== 'undefined' ? window : globalThis);
