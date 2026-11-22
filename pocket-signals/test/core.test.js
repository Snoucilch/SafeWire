'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../pocket-signals.user.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// deterministic PRNG
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function candlesFrom(closes) {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: 1_700_000_000 + i * 60, o, c, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01 };
  });
}

test('ema of a linear series lags by (period-1)/2', () => {
  const v = Array.from({ length: 10 }, (_, i) => i + 1);
  const e = C.ema(v, 3);
  assert.ok(Number.isNaN(e[1]));
  close(e[2], 2);
  close(e[3], 3);
  close(e[9], 9);
});

test('ema skips leading NaN', () => {
  const e = C.ema([NaN, NaN, 2, 2, 2, 2], 3);
  assert.ok(Number.isNaN(e[3]));
  close(e[4], 2);
  close(e[5], 2);
});

test("rsi matches the classic Wilder / StockCharts example (their table rounds averages, so +-0.1)", () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
  const r = C.rsi(closes, 14);
  close(r[14], 70.53, 0.1);
  close(r[15], 66.32, 0.1);
  close(r[16], 66.55, 0.1);
  close(r[17], 69.41, 0.1);
  close(r[18], 66.36, 0.1);
  close(r[19], 57.97, 0.1);
});

test('bollinger of a flat series has zero width; stochastic of flat is 50', () => {
  const bb = C.bollinger(new Array(25).fill(5), 20, 2);
  close(bb.mid, 5);
  close(bb.upper, 5);
  const st = C.stochastic(candlesFrom(new Array(25).fill(5)).map((c) => ({ ...c, h: 5, l: 5 })), 14, 3, 3);
  close(st.k[24], 50);
  close(st.d[24], 50);
});

test('macd histogram is positive while a series accelerates upward', () => {
  const v = Array.from({ length: 60 }, (_, i) => 100 + 0.01 * i * i);
  const m = C.macd(v, 12, 26, 9);
  assert.ok(m.hist[59] > 0);
  assert.ok(Number.isNaN(m.hist[32]));
  assert.ok(Number.isFinite(m.hist[33]));
});

test('evaluate: not ready below the minimum candle count', () => {
  const ev = C.evaluate('trend', candlesFrom(new Array(20).fill(1)), 4);
  assert.equal(ev.ready, false);
  assert.equal(ev.need, C.MIN_CANDLES);
});

test('evaluate trend: noisy uptrend -> CALL, mirrored downtrend -> PUT', () => {
  const r = rng(7);
  const up = [];
  let p = 174;
  for (let i = 0; i < 80; i++) {
    p += 0.01 + (r() - 0.5) * 0.012;
    up.push(+p.toFixed(3));
  }
  const cu = candlesFrom(up);
  cu[cu.length - 1].c = cu[cu.length - 1].o + 0.02; // bullish last candle
  const evUp = C.evaluate('trend', cu, 4);
  assert.equal(evUp.ready, true);
  assert.equal(evUp.dir, 'CALL', JSON.stringify(evUp.votes));

  const down = up.map((x) => 348 - x);
  const cd = candlesFrom(down);
  cd[cd.length - 1].c = cd[cd.length - 1].o - 0.02;
  const evDown = C.evaluate('trend', cd, 4);
  assert.equal(evDown.dir, 'PUT', JSON.stringify(evDown.votes));
});

test('evaluate reversal: sharp drop with a long lower wick -> CALL', () => {
  const closes = [];
  let p = 174;
  for (let i = 0; i < 50; i++) closes.push((p += Math.sin(i) * 0.005));
  for (let i = 0; i < 10; i++) closes.push((p -= 0.03));
  const cs = candlesFrom(closes);
  const last = cs[cs.length - 1];
  // hammer: small body near the top, long wick down through the lower band
  last.o = last.c - 0.002;
  last.h = last.c + 0.002;
  last.l = last.c - 0.08;
  // make %K turn up above %D: lift the last close a bit
  last.c += 0.01;
  last.h = last.c + 0.002;
  const ev = C.evaluate('reversal', cs, 3);
  assert.equal(ev.ready, true);
  assert.equal(ev.dir, 'CALL', JSON.stringify(ev.votes));
});

test('parsePacket: socket.io event, binary placeholder, control frames', () => {
  const a = C.parsePacket('42["updateStream",[["EURJPY_otc",1732230019.123,174.347]]]');
  assert.equal(a.event, 'updateStream');
  assert.equal(a.attachments, 0);
  const b = C.parsePacket('451-["updateStream",{"_placeholder":true,"num":0}]');
  assert.equal(b.event, 'updateStream');
  assert.equal(b.attachments, 1);
  assert.deepEqual(C.parsePacket('2'), { control: '2' });
  assert.equal(C.parsePacket('not json {'), null);
});

test('FrameParser: text tick frame', () => {
  const fp = new C.FrameParser();
  const r = fp.incoming('42["updateStream",[["EURJPY_otc",1732230019.123,174.347]]]', false);
  assert.deepEqual(r.ticks, [{ a: 'EURJPY_otc', t: 1732230019.123, p: 174.347, hist: false }]);
});

test('FrameParser: binary attachment after placeholder, with 0x04 marker and ms timestamps', () => {
  const fp = new C.FrameParser();
  fp.incoming('451-["updateStream",{"_placeholder":true,"num":0}]', false);
  const json = new TextEncoder().encode('[["EURJPY_otc",1732230019123,174.35]]');
  const buf = new Uint8Array(json.length + 1);
  buf[0] = 4;
  buf.set(json, 1);
  const text = C.decodeBinary(buf.buffer);
  const r = fp.incoming(text, true);
  assert.equal(r.event, 'updateStream');
  assert.equal(r.ticks.length, 1);
  close(r.ticks[0].t, 1732230019.123);
  assert.equal(fp.events.updateStream, 2);
});

test('FrameParser: history ticks + [t,o,c,h,l] candles', () => {
  const fp = new C.FrameParser();
  const t0 = 1732230000;
  const payload = {
    asset: 'EURJPY_otc',
    period: 60,
    history: [
      [t0 + 1, 174.1],
      [t0 + 2, 174.2],
    ],
    candles: [
      [t0 - 120, 174.0, 174.05, 174.08, 173.99],
      [t0 - 60, 174.05, 174.02, 174.06, 174.0],
    ],
  };
  const r = fp.incoming(JSON.stringify(payload), true);
  assert.equal(r.ticks.length, 2);
  assert.ok(r.ticks.every((x) => x.hist && x.a === 'EURJPY_otc'));
  assert.equal(r.candleSets.length, 1);
  assert.equal(r.candleSets[0].period, 60);
  assert.deepEqual(r.candleSets[0].list[0], { t: t0 - 120, o: 174.0, c: 174.05, h: 174.08, l: 173.99 });
});

test('parseCandleList: [t,o,h,l,c] and object formats', () => {
  const t0 = 1732230000;
  const ohlc = C.parseCandleList([
    [t0, 1.0, 1.3, 0.9, 1.2],
    [t0 + 60, 1.2, 1.25, 1.1, 1.15],
  ]);
  assert.deepEqual(ohlc[0], { t: t0, o: 1.0, h: 1.3, l: 0.9, c: 1.2 });
  const objs = C.parseCandleList([
    { time: t0 + 60, open: 2, close: 2.1, high: 2.2, low: 1.9 },
    { time: t0, open: 1, close: 2, high: 2.1, low: 0.9 },
  ]);
  assert.equal(objs[0].t, t0); // sorted
  assert.equal(objs[1].c, 2.1);
  assert.equal(C.parseCandleList([[1, 2, 3]]), null);
});

test('extract ignores arrays that only look a bit like ticks', () => {
  const out = { ticks: [], candleSets: [] };
  C.extract(['EURJPY_otc', 5, 3], { asset: null }, out, 0); // no timestamp
  C.extract([[1, 'EURJPY_otc', 'EUR/JPY OTC', 'currency', 92, 1732230019]], { asset: null }, out, 0); // asset list row
  C.extract(['bad asset!', 1732230019, 1], { asset: null }, out, 0);
  assert.equal(out.ticks.length, 0);
});

test('FrameParser.outgoing: changeSymbol yes, unsubscribe no', () => {
  const fp = new C.FrameParser();
  assert.deepEqual(fp.outgoing('42["changeSymbol",{"asset":"EURJPY_otc","period":60}]'), {
    asset: 'EURJPY_otc',
    period: 60,
    event: 'changeSymbol',
  });
  assert.equal(fp.outgoing('42["unsubscribeSymbol",{"asset":"EURJPY_otc"}]'), null);
  assert.equal(fp.outgoing('42["auth",{"session":"x"}]'), null);
  assert.equal(fp.outgoing('3'), null);
});

test('FrameParser samples redact session-like values', () => {
  const fp = new C.FrameParser();
  fp.incoming('42["successauth",{"id":123456,"session":"abc"}]', false);
  assert.ok(!fp.samples[0].text.includes('123456'));
  assert.ok(!fp.samples[0].text.includes('abc'));
});

test('Series keeps ticks sorted, drops duplicates, merges bulk history', () => {
  const s = new C.Series('X');
  assert.equal(s.addTick(10, 1), 'append');
  assert.equal(s.addTick(12, 2), 'append');
  assert.equal(s.addTick(11, 3), 'insert');
  assert.equal(s.addTick(11, 3), 'dup');
  s.addBulk([
    [5, 9],
    [10, 1],
  ]);
  assert.deepEqual(
    s.ticks.map((x) => x[0]),
    [5, 10, 11, 12],
  );
  assert.equal(s.lastP, 2);
});

test('CandleBuilder: push reports the closed candle; rebuild merges server candles', () => {
  const b = new C.CandleBuilder(60);
  assert.equal(b.push(120, 1), null);
  b.push(130, 3);
  b.push(170, 2);
  const closed = b.push(181, 4);
  assert.deepEqual({ ...closed }, { t: 120, o: 1, h: 3, l: 1, c: 2, n: 3 });
  assert.equal(b.candles.length, 2);

  const r = new C.CandleBuilder(60);
  const server = [
    { t: 0, o: 1, h: 2, l: 0.5, c: 1.5 },
    { t: 60, o: 1.5, h: 2.5, l: 1.4, c: 2 },
  ];
  r.rebuild(
    [
      [100, 1.8],
      [110, 2.6],
      [125, 3],
    ],
    server,
  );
  assert.equal(r.candles.length, 3);
  // first tick bucket (60) is partial: keeps server open, widens high
  assert.deepEqual({ ...r.candles[1], n: 0 }, { t: 60, o: 1.5, h: 2.6, l: 1.4, c: 2.6, n: 0 });
  assert.equal(r.candles[2].o, 3);
});

test('Tracker resolves at expiry and computes stats', () => {
  const tr = new C.Tracker();
  tr.add({ asset: 'A', dir: 'CALL', t: 0, entry: 10, expiryAt: 60 });
  tr.add({ asset: 'B', dir: 'PUT', t: 0, entry: 10, expiryAt: 60 });
  assert.equal(tr.onTick('A', 59, 11).length, 0);
  assert.equal(tr.onTick('A', 60, 11)[0].result, 'win');
  assert.equal(tr.onTick('B', 61, 11)[0].result, 'loss');
  tr.add({ asset: 'A', dir: 'PUT', t: 100, entry: 10, expiryAt: 160 });
  assert.equal(tr.onTick('A', 160, 10)[0].result, 'tie');
  const st = tr.stats();
  assert.deepEqual(st, { wins: 1, losses: 1, ties: 1, total: 3, winRate: 0.5 });
  close(C.breakeven(92), 0.5208, 1e-4);
  tr.add({ asset: 'C', dir: 'CALL', t: 0, entry: 1, expiryAt: 60 });
  assert.equal(tr.dropStale(200, 90), 1);
  assert.equal(tr.open.length, 0);
});

test('Tracker restores only valid saved records', () => {
  const tr = new C.Tracker([{ dir: 'CALL', entry: 1, exit: 2, result: 'win' }, { junk: true }, null]);
  assert.equal(tr.closed.length, 1);
});

test("paper trades do not block new signals on the same asset", () => {
  const tr = new C.Tracker();
  tr.add({ asset: "A", dir: "CALL", t: 0, entry: 10, expiryAt: 15, expiry: 15, paper: true });
  assert.equal(tr.hasOpen("A"), false);
  tr.add({ asset: "A", dir: "CALL", t: 0, entry: 10, expiryAt: 180, expiry: 180 });
  assert.equal(tr.hasOpen("A"), true);
  const done = tr.onTick("A", 15.2, 10.5);
  assert.equal(done.length, 1);
  assert.equal(done[0].expiry, 15);
  assert.equal(tr.stats((x) => x.expiry === 15).wins, 1);
});
