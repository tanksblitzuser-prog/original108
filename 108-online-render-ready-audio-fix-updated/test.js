const assert = require('assert');
const G = require('./engine.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('OK  ' + name); }

const C = (r, s) => ({ r, s });

// Maxsus holat yaratish
function scenario({ hands, top, suit, current = 0, deck = [], discard = [], penalty = null, phase = 'normal' }) {
  const st = G.createGame(['A', 'B', 'C', 'D'].slice(0, hands.length));
  st.players.forEach((p, i) => { p.hand = hands[i].slice(); p.out = false; });
  st.deck = deck.slice();
  st.discard = [...discard, top];
  st.currentSuit = suit || top.s;
  st.current = current;
  st.penalty = penalty;
  st.phase = phase;
  st.justDrew = null;
  st.over = false;
  return st;
}

test('36 ta noyob karta', () => {
  const d = G.makeDeck();
  assert.strictEqual(d.length, 36);
  assert.strictEqual(new Set(d.map((c) => c.r + c.s)).size, 36);
});

test('Tarqatish: 3-5 o\'yinchi, har biriga 4 karta, birinchi karta oddiy', () => {
  for (let n = 3; n <= 5; n++) {
    for (let k = 0; k < 200; k++) {
      const st = G.createGame(Array.from({ length: n }, (_, i) => 'P' + i));
      st.players.forEach((p) => assert.strictEqual(p.hand.length, 4));
      assert.ok(['9', '10', 'J', 'K'].includes(G.topCard(st).r));
      assert.strictEqual(st.deck.length + st.discard.length + n * 4, 36);
    }
  }
});

test('7 jarimasi to\'planadi: 7 -> 7 -> 4 karta', () => {
  const st = scenario({
    hands: [[C('7', 'H'), C('9', 'C')], [C('7', 'D'), C('K', 'S')], [C('10', 'C'), C('J', 'D')]],
    top: C('9', 'H'),
    deck: Array.from({ length: 10 }, () => C('K', 'C')),
  });
  G.applyMove(st, { type: 'play', card: C('7', 'H') });
  assert.strictEqual(st.current, 1);
  G.applyMove(st, { type: 'play', card: C('7', 'D') });
  assert.strictEqual(st.current, 2);
  assert.strictEqual(G.penaltyAmount(st.penalty), 4);
  G.applyMove(st, { type: 'draw' });
  assert.strictEqual(st.players[2].hand.length, 2 + 4);
  assert.strictEqual(st.penalty, null);
  assert.strictEqual(st.current, 0);
});

test('6 jarimasida 7 tashlab bo\'lmaydi, Dama bilan bekor qilib bo\'lmaydi', () => {
  const st = scenario({
    hands: [[C('9', 'C')], [C('7', 'H'), C('Q', 'H'), C('K', 'H')], [C('10', 'C'), C('J', 'D')]],
    top: C('6', 'H'), penalty: { rank: '6', count: 1 }, current: 1,
  });
  const moves = G.legalMoves(st);
  assert.deepStrictEqual(moves.map((m) => m.type), ['draw']);
});

test('Tuz keyingi o\'yinchini o\'tkazadi', () => {
  const st = scenario({
    hands: [[C('A', 'H'), C('9', 'C')], [C('K', 'S')], [C('10', 'C')]],
    top: C('9', 'H'),
  });
  G.applyMove(st, { type: 'play', card: C('A', 'H') });
  assert.strictEqual(st.current, 2);
});

test('Dama: belgi tanlanadi va har qanday kartaga tashlanadi', () => {
  const st = scenario({
    hands: [[C('Q', 'S'), C('9', 'C')], [C('K', 'D')], [C('10', 'C')]],
    top: C('9', 'H'),
  });
  G.applyMove(st, { type: 'play', card: C('Q', 'S'), suit: 'D' });
  assert.strictEqual(st.currentSuit, 'D');
  assert.strictEqual(G.topCard(st).r, 'Q');
  assert.strictEqual(st.current, 1);
});

test('8: o\'sha o\'yinchi yopishi shart, mos belgi bilan', () => {
  const st = scenario({
    hands: [[C('8', 'H'), C('K', 'H'), C('9', 'C')], [C('K', 'S')], [C('10', 'C')]],
    top: C('9', 'H'),
  });
  G.applyMove(st, { type: 'play', card: C('8', 'H') });
  assert.strictEqual(st.current, 0);
  assert.strictEqual(st.phase, 'cover');
  const moves = G.legalMoves(st);
  assert.ok(moves.every((m) => m.type === 'play' && (m.card.s === 'H' || m.card.r === '8' || m.card.r === 'Q')));
  G.applyMove(st, { type: 'play', card: C('K', 'H') });
  assert.strictEqual(st.phase, 'normal');
  assert.strictEqual(st.current, 1);
});

test('8: mos belgi yo\'q bo\'lsa, kolodadan kerakli belgi chiqquncha olinadi', () => {
  const st = scenario({
    hands: [[C('8', 'H'), C('9', 'C')], [C('K', 'S')], [C('10', 'C')]],
    top: C('9', 'H'),
    deck: [C('K', 'H'), C('6', 'S'), C('7', 'C'), C('J', 'D')], // oxiridan olinadi: J♦, 7♣, 6♠, K♥
  });
  G.applyMove(st, { type: 'play', card: C('8', 'H') });
  G.applyMove(st, { type: 'draw' });
  // J♦, 7♣, 6♠ qo'lga, K♥ darhol tashlanadi
  assert.strictEqual(st.players[0].hand.length, 1 + 3);
  assert.strictEqual(G.topCard(st).r, 'K');
  assert.strictEqual(st.current, 1);
});

test('8 ni Tuz bilan yopsa, Tuz ta\'siri ishlaydi', () => {
  const st = scenario({
    hands: [[C('8', 'H'), C('A', 'H'), C('9', 'C')], [C('K', 'S')], [C('10', 'C')]],
    top: C('9', 'H'),
  });
  G.applyMove(st, { type: 'play', card: C('8', 'H') });
  G.applyMove(st, { type: 'play', card: C('A', 'H') });
  assert.strictEqual(st.current, 2);
});

test('8 ni 7 bilan yopsa, 7 jarimasi ishlaydi', () => {
  const st = scenario({
    hands: [[C('8', 'H'), C('7', 'H'), C('9', 'C')], [C('K', 'S')], [C('10', 'C')]],
    top: C('9', 'H'),
  });
  G.applyMove(st, { type: 'play', card: C('8', 'H') });
  G.applyMove(st, { type: 'play', card: C('7', 'H') });
  assert.strictEqual(st.penalty.rank, '7');
  assert.strictEqual(st.current, 1);
});

test('Oxirgi karta 8 bo\'lsa ham yopish shart; yopgandan keyin chiqadi', () => {
  const st = scenario({
    hands: [[C('8', 'H')], [C('K', 'S'), C('9', 'S')], [C('10', 'C'), C('J', 'C')]],
    top: C('9', 'H'),
    deck: [C('K', 'H'), C('6', 'S')],
  });
  G.applyMove(st, { type: 'play', card: C('8', 'H') });
  assert.strictEqual(st.players[0].out, false);
  G.applyMove(st, { type: 'draw' }); // 6♠ qo'lga, K♥ tashlanadi, qo'lda 6♠ qoladi
  assert.strictEqual(st.players[0].hand.length, 1);
  assert.strictEqual(st.players[0].out, false);
});

test('Oxirgi karta oddiy tashlansa o\'yinchi chiqadi, keyin 1 kishi qolsa o\'yin tugaydi', () => {
  const st = scenario({
    hands: [[C('9', 'C')], [C('K', 'S')], [C('10', 'C'), C('J', 'D')]],
    top: C('9', 'H'),
  });
  G.applyMove(st, { type: 'play', card: C('9', 'C') });
  assert.strictEqual(st.players[0].out, true);
  assert.strictEqual(st.over, false);
  assert.strictEqual(st.current, 1);
  st.players[1].hand = [C('K', 'C')];
  G.applyMove(st, { type: 'play', card: C('K', 'C') }); // 9♣ ustiga, belgi C
  assert.strictEqual(st.over, true);
  assert.strictEqual(st.loser, 2);
});

test('Oxirgi karta 7 bo\'lsa, jarima keyingi faol o\'yinchiga o\'tadi', () => {
  const st = scenario({
    hands: [[C('7', 'H')], [C('K', 'S'), C('9', 'S')], [C('10', 'C'), C('J', 'D')]],
    top: C('9', 'H'),
  });
  G.applyMove(st, { type: 'play', card: C('7', 'H') });
  assert.strictEqual(st.players[0].out, true);
  assert.strictEqual(st.current, 1);
  assert.strictEqual(st.penalty.rank, '7');
});

test('Koloda tugasa, tashlangan kartalar aralashtiriladi, ustki karta joyida qoladi', () => {
  const st = scenario({
    hands: [[C('K', 'C')], [C('K', 'S')], [C('10', 'C')]],
    top: C('9', 'H'),
    deck: [],
    discard: [C('6', 'C'), C('7', 'C'), C('J', 'S')],
  });
  const top = G.topCard(st);
  G.applyMove(st, { type: 'draw' });
  assert.ok(st.events.some((e) => e.t === 'reshuffle'));
  assert.strictEqual(G.topCard(st), top);
  const total = st.deck.length + st.discard.length + st.players.reduce((s, p) => s + p.hand.length, 0);
  assert.strictEqual(total, 3 + 1 + 3); // 3 ta qo'l + ustki karta + 3 ta aralashtirilgan karta
  assert.strictEqual(st.players[0].hand.length, 2);
});

test('Olingan karta mos bo\'lsa — tashlash yoki o\'tkazish tanlovi', () => {
  const st = scenario({
    hands: [[C('K', 'C')], [C('K', 'S')], [C('10', 'C')]],
    top: C('9', 'H'),
    deck: [C('J', 'H')],
  });
  G.applyMove(st, { type: 'draw' });
  assert.deepStrictEqual(G.legalMoves(st).map((m) => m.type), ['play', 'pass']);
});

test('Noqonuniy yurish rad etiladi', () => {
  const st = scenario({
    hands: [[C('K', 'C'), C('10', 'H')], [C('K', 'S')], [C('10', 'C')]],
    top: C('9', 'H'),
  });
  assert.throws(() => G.applyMove(st, { type: 'play', card: C('K', 'C') }));
});

// ---- Tasodifiy o'yinlar: invariantlar ----
test('5000 ta tasodifiy o\'yin: xatosiz tugaydi, kartalar saqlanadi', () => {
  let finished = 0;
  for (let g = 0; g < 5000; g++) {
    const n = 3 + (g % 3);
    const st = G.createGame(Array.from({ length: n }, (_, i) => 'P' + i));
    let steps = 0;
    while (!st.over) {
      const m = G.botMove(st);
      G.applyMove(st, m);
      const all = [...st.deck, ...st.discard, ...st.players.flatMap((p) => p.hand)];
      assert.strictEqual(all.length, 36, 'karta soni buzildi');
      assert.strictEqual(new Set(all.map((c) => c.r + c.s)).size, 36, 'takroriy karta');
      if (++steps > 5000) assert.fail('O\'yin tugamadi (g=' + g + ')');
    }
    assert.ok(st.players.filter((p) => !p.out).length <= 1);
    finished++;
  }
  assert.strictEqual(finished, 5000);
});

console.log(`\n${passed} ta test o'tdi`);
