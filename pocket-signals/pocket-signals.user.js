// ==UserScript==
// @name         Pocket Signals — مساعد إشارات Pocket Option
// @namespace    pocket-signals
// @version      1.1.0
// @description  يقرأ أسعار الشارت من اتصال الموقع نفسه، يحسب مؤشرات فنية، ويعرض إشارات BUY/SELL مع عدّاد نتائج حقيقي.
// @match        https://pocketoption.com/*
// @match        https://*.pocketoption.com/*
// @match        https://po.trade/*
// @match        https://*.po.trade/*
// @match        https://po2.trade/*
// @match        https://*.po2.trade/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==

/*
 * Pocket Signals
 * --------------
 * - يستمع لاتصال WebSocket الخاص بالموقع (قراءة فقط) ويلتقط الأسعار اللحظية وتاريخ الشموع.
 * - يبني شموعاً بالفريم المختار ويحسب: EMA 9/21، MACD، RSI، Bollinger، Stochastic.
 * - يعطي إشارة عند إغلاق الشمعة إذا اتفقت المؤشرات بالقوة المطلوبة.
 * - يسجّل كل إشارة ويحسب نتيجتها تلقائياً عند انتهاء المدة، ويعرض نسبة الفوز الحقيقية.
 * لا يفتح صفقات ولا يرسل أي شيء للموقع. لا يوجد مؤشر يضمن الربح.
 */
(function (root) {
  'use strict';

  const VERSION = '1.1.0';

  /* =====================================================================
   * Core — pure logic (indicators, parsing, candles, tracking).
   * Exported as a CommonJS module when loaded in Node for tests.
   * ===================================================================== */
  const Core = (function () {
    const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
    const MIN_CANDLES = 35;
    const MAX_CANDLES = 400;
    const MAX_TICKS = 40000;
    const MAX_HISTORY = 300;

    // ---------- indicators ----------
    function sma(values, period) {
      const n = values.length;
      const out = new Array(n).fill(NaN);
      for (let i = period - 1; i < n; i++) {
        let sum = 0;
        let ok = true;
        for (let j = i - period + 1; j <= i; j++) {
          if (!isNum(values[j])) {
            ok = false;
            break;
          }
          sum += values[j];
        }
        if (ok) out[i] = sum / period;
      }
      return out;
    }

    // EMA seeded with the SMA of the first `period` finite values (skips leading NaN).
    function ema(values, period) {
      const n = values.length;
      const out = new Array(n).fill(NaN);
      let start = 0;
      while (start < n && !isNum(values[start])) start++;
      if (n - start < period) return out;
      let sum = 0;
      for (let i = start; i < start + period; i++) sum += values[i];
      let prev = sum / period;
      out[start + period - 1] = prev;
      const k = 2 / (period + 1);
      for (let i = start + period; i < n; i++) {
        prev = (values[i] - prev) * k + prev;
        out[i] = prev;
      }
      return out;
    }

    // Wilder's RSI.
    function rsi(closes, period) {
      const n = closes.length;
      const out = new Array(n).fill(NaN);
      if (n <= period) return out;
      let gain = 0;
      let loss = 0;
      for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gain += d;
        else loss -= d;
      }
      gain /= period;
      loss /= period;
      const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
      out[period] = val();
      for (let i = period + 1; i < n; i++) {
        const d = closes[i] - closes[i - 1];
        gain = (gain * (period - 1) + Math.max(d, 0)) / period;
        loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
        out[i] = val();
      }
      return out;
    }

    // Bollinger bands of the last `period` closes (population standard deviation).
    function bollinger(closes, period, mult) {
      const n = closes.length;
      if (n < period) return null;
      let sum = 0;
      for (let i = n - period; i < n; i++) sum += closes[i];
      const mid = sum / period;
      let v = 0;
      for (let i = n - period; i < n; i++) v += (closes[i] - mid) * (closes[i] - mid);
      const sd = Math.sqrt(v / period);
      return { mid, upper: mid + mult * sd, lower: mid - mult * sd, sd };
    }

    function stochastic(candles, kPeriod, kSmooth, dPeriod) {
      const n = candles.length;
      const raw = new Array(n).fill(NaN);
      for (let i = kPeriod - 1; i < n; i++) {
        let hh = -Infinity;
        let ll = Infinity;
        for (let j = i - kPeriod + 1; j <= i; j++) {
          if (candles[j].h > hh) hh = candles[j].h;
          if (candles[j].l < ll) ll = candles[j].l;
        }
        raw[i] = hh === ll ? 50 : (100 * (candles[i].c - ll)) / (hh - ll);
      }
      const k = sma(raw, kSmooth);
      const d = sma(k, dPeriod);
      return { k, d };
    }

    function macd(closes, fast, slow, signal) {
      const ef = ema(closes, fast);
      const es = ema(closes, slow);
      const line = closes.map((_, i) => (isNum(ef[i]) && isNum(es[i]) ? ef[i] - es[i] : NaN));
      const sig = ema(line, signal);
      const hist = line.map((v, i) => (isNum(v) && isNum(sig[i]) ? v - sig[i] : NaN));
      return { line, signal: sig, hist };
    }

    // ---------- strategies ----------
    const vote = (key, label, short, v, value) => ({ key, label, short, vote: v, value });
    const sign = (a, b) => (a > b ? 1 : a < b ? -1 : 0);

    const STRATEGIES = {
      trend: {
        label: 'اتجاه (Trend)',
        max: 5,
        threshold: 4,
        evaluate(candles) {
          const closes = candles.map((c) => c.c);
          const i = closes.length - 1;
          const c = candles[i];
          const e9 = ema(closes, 9)[i];
          const e21 = ema(closes, 21)[i];
          const m = macd(closes, 12, 26, 9);
          const h = m.hist[i];
          const hp = m.hist[i - 1];
          const r = rsi(closes, 14)[i];
          const ev = sign(e9, e21);
          const pv = sign(c.c, e21);
          const mv = h > 0 && h > hp ? 1 : h < 0 && h < hp ? -1 : 0;
          const rv = r > 50 && r < 70 ? 1 : r < 50 && r > 30 ? -1 : 0;
          const cv = sign(c.c, c.o);
          return [
            vote('ema', 'EMA 9/21', 'EMA', ev, ev > 0 ? 'صاعد' : ev < 0 ? 'هابط' : 'محايد'),
            vote('pos', 'السعر و EMA21', 'السعر', pv, pv > 0 ? 'فوق' : pv < 0 ? 'تحت' : 'عليه'),
            vote('macd', 'MACD', 'MACD', mv, h > 0 ? (h > hp ? 'موجب ↑' : 'موجب ↓') : h < hp ? 'سالب ↓' : 'سالب ↑'),
            vote('rsi', 'RSI 14', 'RSI', rv, isNum(r) ? r.toFixed(0) : '—'),
            vote('candle', 'آخر شمعة', 'شمعة', cv, cv > 0 ? 'خضراء' : cv < 0 ? 'حمراء' : 'دوجي'),
          ];
        },
      },
      reversal: {
        label: 'ارتداد (Reversal)',
        max: 4,
        threshold: 3,
        evaluate(candles) {
          const closes = candles.map((c) => c.c);
          const i = closes.length - 1;
          const c = candles[i];
          const r = rsi(closes, 14)[i];
          const bb = bollinger(closes, 20, 2);
          const st = stochastic(candles, 14, 3, 3);
          const k = st.k[i];
          const d = st.d[i];
          const rv = r < 30 ? 1 : r > 70 ? -1 : 0;
          const touchLow = c.l <= bb.lower;
          const touchHigh = c.h >= bb.upper;
          const bv = touchLow && !touchHigh ? 1 : touchHigh && !touchLow ? -1 : 0;
          const sv = k < 20 && k > d ? 1 : k > 80 && k < d ? -1 : 0;
          const range = c.h - c.l;
          const lowerWick = Math.min(c.o, c.c) - c.l;
          const upperWick = c.h - Math.max(c.o, c.c);
          const wv = range > 0 && lowerWick / range >= 0.5 ? 1 : range > 0 && upperWick / range >= 0.5 ? -1 : 0;
          return [
            vote('rsi', 'RSI 14', 'RSI', rv, isNum(r) ? r.toFixed(0) : '—'),
            vote('bb', 'Bollinger 20', 'BB', bv, touchLow ? 'لمس السفلي' : touchHigh ? 'لمس العلوي' : 'داخل'),
            vote('stoch', 'Stochastic', 'Stoch', sv, isNum(k) ? k.toFixed(0) + '/' + (isNum(d) ? d.toFixed(0) : '—') : '—'),
            vote('wick', 'ذيل الرفض', 'ذيل', wv, wv > 0 ? 'ذيل سفلي' : wv < 0 ? 'ذيل علوي' : 'لا يوجد'),
          ];
        },
      },
    };

    function evaluate(key, candles, threshold) {
      const s = STRATEGIES[key] || STRATEGIES.trend;
      const have = candles ? candles.length : 0;
      if (have < MIN_CANDLES) {
        return { ready: false, have, need: MIN_CANDLES, dir: null, score: 0, max: s.max, threshold: s.threshold, votes: [] };
      }
      const votes = s.evaluate(candles);
      const score = votes.reduce((a, v) => a + v.vote, 0);
      const thr = Math.min(Math.max(Math.round(threshold || s.threshold), 1), s.max);
      const dir = score >= thr ? 'CALL' : score <= -thr ? 'PUT' : null;
      return { ready: true, have, need: MIN_CANDLES, dir, score, max: s.max, threshold: thr, votes };
    }

    // ---------- frame parsing (socket.io over WebSocket) ----------
    const ASSET_RE = /^[A-Za-z0-9#._-]{2,40}$/;
    const normTime = (t) => (t > 1e12 ? t / 1000 : t);
    const isTimeLike = (t) => isNum(t) && ((t > 1.2e9 && t < 5e9) || (t > 1.2e12 && t < 5e12));
    const isTickArr = (x) =>
      Array.isArray(x) &&
      (x.length === 3 || x.length === 4) &&
      typeof x[0] === 'string' &&
      ASSET_RE.test(x[0]) &&
      isTimeLike(x[1]) &&
      isNum(x[2]) &&
      x[2] > 0;

    function decodeBinary(buf) {
      let bytes;
      if (buf instanceof Uint8Array) bytes = buf;
      else if (ArrayBuffer.isView(buf)) bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      else bytes = new Uint8Array(buf);
      let start = 0;
      // skip a leading engine.io binary marker or any non-JSON prefix bytes
      while (start < bytes.length && start < 16 && bytes[start] !== 0x5b && bytes[start] !== 0x7b) start++;
      if (start >= bytes.length || (bytes[start] !== 0x5b && bytes[start] !== 0x7b)) return null;
      try {
        return new TextDecoder('utf-8').decode(bytes.subarray(start));
      } catch (e) {
        return null;
      }
    }

    function parsePacket(text) {
      if (typeof text !== 'string' || !text) return null;
      let idx = -1;
      for (let i = 0; i < text.length && i < 64; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 0x5b || ch === 0x7b) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return { control: text.slice(0, 16) };
      const prefix = text.slice(0, idx);
      if (prefix && !/^\d/.test(prefix)) return null;
      let json;
      try {
        json = JSON.parse(text.slice(idx));
      } catch (e) {
        return null;
      }
      const att = /^4[56](\d+)-/.exec(prefix);
      const out = { prefix, json, attachments: att ? +att[1] : 0, event: null, args: null };
      if (/^4[2-6]/.test(prefix) && Array.isArray(json) && typeof json[0] === 'string') {
        out.event = json[0];
        out.args = json.slice(1);
      }
      return out;
    }

    function candleFromObj(o) {
      const t = [o.time, o.t, o.from, o.timestamp].find(isTimeLike);
      if (t === undefined) return null;
      if (![o.open, o.close, o.high, o.low].every(isNum)) return null;
      return { t: normTime(t), o: o.open, h: o.high, l: o.low, c: o.close };
    }

    // Accepts [{time,open,close,high,low}], [[t,o,c,h,l]] or [[t,o,h,l,c]] (format detected by validity).
    function parseCandleList(v) {
      if (!Array.isArray(v) || v.length < 2) return null;
      const first = v[0];
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        if (!candleFromObj(first)) return null;
        const list = v.map((x) => (x && typeof x === 'object' ? candleFromObj(x) : null)).filter(Boolean);
        return list.length ? list.sort((a, b) => a.t - b.t) : null;
      }
      const okArr = (x) => Array.isArray(x) && x.length >= 5 && isTimeLike(x[0]) && x.slice(1, 5).every(isNum);
      if (!okArr(first)) return null;
      let A = 0;
      let B = 0;
      for (const x of v) {
        if (!okArr(x)) continue;
        const a = x[1];
        const b = x[2];
        const c = x[3];
        const d = x[4];
        if (c >= Math.max(a, b, d) && d <= Math.min(a, b, c)) A++; // t,o,c,h,l
        if (b >= Math.max(a, c, d) && c <= Math.min(a, b, d)) B++; // t,o,h,l,c
      }
      if (!A && !B) return null;
      const ochl = A >= B;
      return v
        .filter(okArr)
        .map((x) =>
          ochl
            ? { t: normTime(x[0]), o: x[1], c: x[2], h: x[3], l: x[4] }
            : { t: normTime(x[0]), o: x[1], h: x[2], l: x[3], c: x[4] },
        )
        .sort((a, b) => a.t - b.t);
    }

    function inferPeriod(list) {
      let best = Infinity;
      for (let i = 1; i < list.length; i++) {
        const d = list[i].t - list[i - 1].t;
        if (d > 0 && d < best) best = d;
      }
      return isFinite(best) ? Math.round(best) : null;
    }

    function extract(node, ctx, out, depth) {
      if (depth > 10 || node == null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        if (isTickArr(node)) {
          out.ticks.push({ a: node[0], t: normTime(node[1]), p: node[2], hist: false });
          return;
        }
        if (ctx.asset) {
          const list = parseCandleList(node);
          if (list) {
            out.candleSets.push({ asset: ctx.asset, period: ctx.period || inferPeriod(list), list });
            return;
          }
        }
        for (const x of node) extract(x, ctx, out, depth + 1);
        return;
      }
      const asset =
        typeof node.asset === 'string' && ASSET_RE.test(node.asset)
          ? node.asset
          : typeof node.symbol === 'string' && ASSET_RE.test(node.symbol)
            ? node.symbol
            : ctx.asset;
      const period = isNum(node.period) && node.period > 0 ? node.period : ctx.period;
      const sub = { asset, period, event: ctx.event };
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (!v || typeof v !== 'object') continue;
        if (Array.isArray(v) && asset) {
          if (key === 'history') {
            for (const h of v) {
              if (Array.isArray(h) && isTimeLike(h[0]) && isNum(h[1]) && h[1] > 0) {
                out.ticks.push({ a: asset, t: normTime(h[0]), p: h[1], hist: true });
              }
            }
            continue;
          }
          const list = parseCandleList(v);
          if (list) {
            out.candleSets.push({ asset, period: period || inferPeriod(list), list });
            continue;
          }
        }
        extract(v, sub, out, depth + 1);
      }
    }

    const REDACT_RE = /("(?:session|token|secret|password|email|uid|user_?id|id|balance|ip)"\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)/gi;

    class FrameParser {
      constructor() {
        this.pending = [];
        this.events = Object.create(null);
        this.frames = { in: 0, out: 0, bin: 0 };
        this.samples = [];
      }
      incoming(text, isBinary) {
        this.frames.in++;
        if (isBinary) this.frames.bin++;
        const res = { ticks: [], candleSets: [], event: null };
        const pkt = parsePacket(text);
        if (!pkt || pkt.json === undefined) return res;
        let event = pkt.event;
        const payload = pkt.event ? pkt.args : pkt.json;
        if (!pkt.event && !pkt.prefix && this.pending.length) {
          event = this.pending[0].event;
          if (--this.pending[0].left <= 0) this.pending.shift();
        }
        if (pkt.attachments > 0 && pkt.event) {
          this.pending.push({ event: pkt.event, left: pkt.attachments });
          if (this.pending.length > 8) this.pending.shift();
        }
        if (event) this.events[event] = (this.events[event] || 0) + 1;
        res.event = event || null;
        extract(payload, { asset: null, period: null, event }, res, 0);
        if (this.samples.length < 12 && (res.ticks.length || res.candleSets.length || this.events[event] === 1)) {
          this.samples.push({ event: event || '?', bin: !!isBinary, text: String(text).slice(0, 180).replace(REDACT_RE, '$1"***"') });
        }
        return res;
      }
      outgoing(text) {
        this.frames.out++;
        const pkt = parsePacket(typeof text === 'string' ? text : null);
        if (!pkt || !pkt.event) return null;
        if (!/changesymbol|^subscribe/i.test(pkt.event) || /unsub/i.test(pkt.event)) return null;
        const a = pkt.args && pkt.args[0];
        if (a && typeof a === 'object' && typeof a.asset === 'string' && ASSET_RE.test(a.asset)) {
          return { asset: a.asset, period: isNum(a.period) && a.period > 0 ? a.period : null, event: pkt.event };
        }
        return null;
      }
    }

    // ---------- price series & candles ----------
    class Series {
      constructor(asset) {
        this.asset = asset;
        this.ticks = []; // [t, p] sorted by t
        this.server = new Map(); // period -> Map(t -> candle)
        this.lastLocal = 0;
      }
      get lastP() {
        const n = this.ticks.length;
        return n ? this.ticks[n - 1][1] : NaN;
      }
      get lastT() {
        const n = this.ticks.length;
        return n ? this.ticks[n - 1][0] : 0;
      }
      addTick(t, p) {
        const ticks = this.ticks;
        const n = ticks.length;
        if (!n || t > ticks[n - 1][0]) {
          ticks.push([t, p]);
          this.trim();
          return 'append';
        }
        if (t === ticks[n - 1][0]) {
          if (ticks[n - 1][1] === p) return 'dup';
          ticks.push([t, p]);
          return 'append';
        }
        let lo = 0;
        let hi = n;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (ticks[mid][0] < t) lo = mid + 1;
          else hi = mid;
        }
        if (lo < n && ticks[lo][0] === t && ticks[lo][1] === p) return 'dup';
        ticks.splice(lo, 0, [t, p]);
        this.trim();
        return 'insert';
      }
      addBulk(list) {
        if (!list.length) return;
        const all = this.ticks.concat(list).sort((a, b) => a[0] - b[0]);
        const out = [];
        for (const x of all) {
          const l = out[out.length - 1];
          if (l && l[0] === x[0] && l[1] === x[1]) continue;
          out.push(x);
        }
        this.ticks = out;
        this.trim(true);
      }
      trim(force) {
        if (this.ticks.length > MAX_TICKS * 1.1 || (force && this.ticks.length > MAX_TICKS)) {
          this.ticks.splice(0, this.ticks.length - MAX_TICKS);
        }
      }
      addServerCandles(period, list) {
        if (!isNum(period) || period <= 0) return;
        let m = this.server.get(period);
        if (!m) {
          m = new Map();
          this.server.set(period, m);
        }
        for (const c of list) m.set(c.t, c);
        if (m.size > MAX_CANDLES * 2) {
          const keys = [...m.keys()].sort((a, b) => a - b);
          for (const k of keys.slice(0, m.size - MAX_CANDLES * 2)) m.delete(k);
        }
      }
      serverList(period) {
        const m = this.server.get(period);
        return m ? [...m.values()].sort((a, b) => a.t - b.t) : null;
      }
    }

    class CandleBuilder {
      constructor(tf, max) {
        this.tf = tf;
        this.max = max || MAX_CANDLES;
        this.candles = [];
      }
      bucket(t) {
        return Math.floor(t / this.tf + 1e-9) * this.tf;
      }
      // Returns the candle that just closed (when t starts a new bucket), else null.
      push(t, p) {
        const b = this.bucket(t);
        const cs = this.candles;
        const last = cs[cs.length - 1];
        if (last && b === last.t) {
          if (p > last.h) last.h = p;
          if (p < last.l) last.l = p;
          last.c = p;
          last.n++;
          return null;
        }
        if (last && b < last.t) return null;
        cs.push({ t: b, o: p, h: p, l: p, c: p, n: 1 });
        if (cs.length > this.max) cs.splice(0, cs.length - this.max);
        return last || null;
      }
      rebuild(ticks, server) {
        const map = new Map();
        if (server) {
          for (const c of server) {
            const b = this.bucket(c.t);
            map.set(b, { t: b, o: c.o, h: c.h, l: c.l, c: c.c, n: 0 });
          }
        }
        let cur = null;
        let firstB = null;
        const flush = () => {
          const s = map.get(cur.t);
          if (s && cur.t === firstB) {
            // first tick bucket is usually partial: keep the server open/high/low
            map.set(cur.t, { t: cur.t, o: s.o, h: Math.max(s.h, cur.h), l: Math.min(s.l, cur.l), c: cur.c, n: cur.n });
          } else map.set(cur.t, cur);
        };
        for (const [t, p] of ticks) {
          const b = this.bucket(t);
          if (!cur || cur.t !== b) {
            if (cur) flush();
            if (firstB === null) firstB = b;
            cur = { t: b, o: p, h: p, l: p, c: p, n: 1 };
          } else {
            if (p > cur.h) cur.h = p;
            if (p < cur.l) cur.l = p;
            cur.c = p;
            cur.n++;
          }
        }
        if (cur) flush();
        this.candles = [...map.values()].sort((a, b) => a.t - b.t).slice(-this.max);
      }
    }

    // ---------- signal tracking ----------
    const validRecord = (s) =>
      s && (s.dir === 'CALL' || s.dir === 'PUT') && isNum(s.entry) && isNum(s.exit) && /^(win|loss|tie)$/.test(s.result);

    class Tracker {
      constructor(history) {
        this.open = [];
        this.closed = Array.isArray(history) ? history.filter(validRecord).slice(-MAX_HISTORY) : [];
        this.seq = Date.now();
      }
      hasOpen(asset) {
        return this.open.some((s) => s.asset === asset && !s.paper);
      }
      add(sig) {
        const s = Object.assign({ id: ++this.seq, result: null }, sig);
        this.open.push(s);
        return s;
      }
      onTick(asset, t, p) {
        const done = [];
        for (let i = this.open.length - 1; i >= 0; i--) {
          const s = this.open[i];
          if (s.asset !== asset || t < s.expiryAt) continue;
          s.exit = p;
          s.exitT = t;
          s.result = p === s.entry ? 'tie' : p > s.entry === (s.dir === 'CALL') ? 'win' : 'loss';
          this.open.splice(i, 1);
          this.closed.push(s);
          done.push(s);
        }
        if (this.closed.length > MAX_HISTORY) this.closed.splice(0, this.closed.length - MAX_HISTORY);
        return done;
      }
      // Drop open signals whose asset stopped streaming (e.g. user switched asset).
      dropStale(now, grace) {
        const before = this.open.length;
        this.open = this.open.filter((s) => now < s.expiryAt + grace);
        return before - this.open.length;
      }
      stats(filter) {
        let wins = 0;
        let losses = 0;
        let ties = 0;
        for (const s of this.closed) {
          if (filter && !filter(s)) continue;
          if (s.result === 'win') wins++;
          else if (s.result === 'loss') losses++;
          else ties++;
        }
        const decided = wins + losses;
        return { wins, losses, ties, total: decided + ties, winRate: decided ? wins / decided : null };
      }
      clear() {
        this.closed = [];
        this.open = [];
      }
    }

    // Minimum win rate needed to break even at a given payout (92% -> 52.08%).
    const breakeven = (payoutPct) => 1 / (1 + payoutPct / 100);

    return {
      VERSION,
      MIN_CANDLES,
      sma,
      ema,
      rsi,
      bollinger,
      stochastic,
      macd,
      STRATEGIES,
      evaluate,
      decodeBinary,
      parsePacket,
      parseCandleList,
      extract,
      FrameParser,
      Series,
      CandleBuilder,
      Tracker,
      breakeven,
    };
  })();

  if (typeof window === 'undefined' && typeof module === 'object' && module && module.exports) {
    module.exports = Core;
    return;
  }

  /* =====================================================================
   * Browser app — WebSocket listener + floating panel
   * ===================================================================== */
  if (root.__pocketSignals) {
    root.__pocketSignals.toggle();
    return;
  }

  const ENTRY_WINDOW = 10; // seconds the "enter now" prompt stays up
  const PRE_WINDOW = 8; // seconds before candle close to show "get ready"
  const RESULT_SHOW = 20; // seconds to show a resolved result
  const TF_OPTIONS = [15, 30, 60, 120, 180, 300, 600];
  const PAPER_EXPIRIES = [15, 60]; // virtual trades opened alongside every signal
  const EXPIRY_OPTIONS = [15, 30, 60, 120, 180, 300, 600, 900];

  const store = {
    get(k) {
      try {
        const v = root.localStorage.getItem('pocketSignals.v1.' + k);
        return v ? JSON.parse(v) : null;
      } catch (e) {
        return null;
      }
    },
    set(k, v) {
      try {
        root.localStorage.setItem('pocketSignals.v1.' + k, JSON.stringify(v));
      } catch (e) {
        /* storage blocked: keep going without persistence */
      }
    },
  };

  const DEFAULTS = {
    strategy: 'trend',
    tf: 60,
    syncTf: true,
    expiry: 180,
    thresholds: { trend: 4, reversal: 3 },
    payout: 92,
    stake: 10,
    sound: true,
    asset: 'auto',
    pos: null,
    min: false,
  };
  const saved = store.get('settings') || {};
  const settings = Object.assign({}, DEFAULTS, saved);
  settings.thresholds = Object.assign({}, DEFAULTS.thresholds, saved.thresholds || {});
  if (!Core.STRATEGIES[settings.strategy]) settings.strategy = DEFAULTS.strategy;
  const saveSettings = () => store.set('settings', settings);

  const parser = new Core.FrameParser();
  const state = {
    series: new Map(),
    chartAsset: null,
    active: null,
    builder: new Core.CandleBuilder(settings.tf),
    tracker: new Core.Tracker(store.get('history') || []),
    lastTickT: 0,
    lastTickLocal: 0,
    sockets: 0,
    hookMode: document.readyState === 'loading' ? 'early' : 'late',
    errors: 0,
  };

  const nowS = () => (state.lastTickT ? state.lastTickT + (Date.now() - state.lastTickLocal) / 1000 : Date.now() / 1000);
  const thr = () => settings.thresholds[settings.strategy];

  function getSeries(a) {
    let s = state.series.get(a);
    if (!s) {
      s = new Core.Series(a);
      state.series.set(a, s);
      ui.assetsChanged = true;
    }
    return s;
  }

  function rebuild() {
    state.builder = new Core.CandleBuilder(settings.tf);
    const s = state.active && state.series.get(state.active);
    if (s) state.builder.rebuild(s.ticks, s.serverList(settings.tf));
  }

  function setActive(a) {
    if (a === state.active) return;
    state.active = a;
    rebuild();
    scheduleRender();
  }

  function mostRecentSeries() {
    let best = null;
    for (const s of state.series.values()) if (!best || s.lastLocal > best.lastLocal) best = s;
    return best;
  }

  function resolveActive() {
    let target = settings.asset !== 'auto' ? settings.asset : state.chartAsset;
    if (settings.asset === 'auto') {
      const ts = target && state.series.get(target);
      if (!ts || Date.now() - ts.lastLocal > 12000) {
        const live = mostRecentSeries();
        if (live && Date.now() - live.lastLocal < 12000) target = live.asset;
      }
    }
    if (target) setActive(target);
  }

  // ---------- data in ----------
  function handleText(text, isBinary) {
    if (text == null) return;
    const res = parser.incoming(text, isBinary);
    if (!res.ticks.length && !res.candleSets.length) return;
    let needRebuild = false;
    for (const set of res.candleSets) {
      getSeries(set.asset).addServerCandles(set.period, set.list);
      if (set.asset === state.active || !state.active) needRebuild = true;
    }
    const hist = res.ticks.filter((x) => x.hist);
    const live = hist.length ? res.ticks.filter((x) => !x.hist) : res.ticks;
    if (hist.length) {
      const by = new Map();
      for (const x of hist) {
        if (!by.has(x.a)) by.set(x.a, []);
        by.get(x.a).push([x.t, x.p]);
      }
      for (const [a, list] of by) {
        getSeries(a).addBulk(list);
        if (a === state.active || !state.active) needRebuild = true;
      }
    }
    for (const x of live) onTick(x.a, x.t, x.p);
    if (!state.active) resolveActive();
    if (needRebuild) rebuild();
    scheduleRender();
  }

  function onTick(a, t, p) {
    const s = getSeries(a);
    const r = s.addTick(t, p);
    if (r === 'dup') return;
    s.lastLocal = Date.now();
    if (t >= state.lastTickT) {
      state.lastTickT = t;
      state.lastTickLocal = Date.now();
    }
    resolveActive();
    if (a === state.active) {
      if (r === 'insert') rebuild();
      else {
        const closed = state.builder.push(t, p);
        if (closed) onCandleClose(a, t, p);
      }
    }
    const done = state.tracker.onTick(a, t, p);
    if (done.length) {
      store.set('history', state.tracker.closed);
      for (const d of done) if (d.asset === state.active && !d.paper) beep(d.result === 'win' ? [880, 1320] : d.result === 'loss' ? [330] : [600], false);
    }
    scheduleRender();
  }

  function onCandleClose(asset, t, p) {
    const closed = state.builder.candles.slice(0, -1);
    const ev = Core.evaluate(settings.strategy, closed, thr());
    if (!ev.ready || !ev.dir || state.tracker.hasOpen(asset)) return;
    const base = { asset, dir: ev.dir, t, entry: p, strategy: settings.strategy, tf: settings.tf, score: ev.score, max: ev.max };
    state.tracker.add(Object.assign({ expiry: settings.expiry, expiryAt: t + settings.expiry }, base));
    // paper test: the same signal scored at other expiries, without blocking new signals
    for (const x of PAPER_EXPIRIES) {
      if (x !== settings.expiry) state.tracker.add(Object.assign({ expiry: x, expiryAt: t + x, paper: true }, base));
    }
    beep(ev.dir === 'CALL' ? [660, 990] : [990, 660], true);
  }

  function onIncoming(data) {
    try {
      if (typeof data === 'string') return handleText(data, false);
      const tag = Object.prototype.toString.call(data);
      if (tag === '[object ArrayBuffer]' || ArrayBuffer.isView(data)) return handleText(Core.decodeBinary(data), true);
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data.arrayBuffer().then((b) => handleText(Core.decodeBinary(b), true), () => {});
      }
    } catch (e) {
      state.errors++;
    }
  }

  function onOutgoing(data) {
    try {
      if (typeof data !== 'string') return;
      const sym = parser.outgoing(data);
      if (!sym) return;
      state.chartAsset = sym.asset;
      if (sym.period && settings.syncTf && sym.period >= 5 && sym.period <= 3600 && sym.period !== settings.tf) {
        settings.tf = sym.period;
        saveSettings();
        rebuild();
        ui.settingsChanged = true;
      }
      resolveActive();
      scheduleRender();
    } catch (e) {
      state.errors++;
    }
  }

  // ---------- WebSocket hook (read-only) ----------
  const attached = new WeakSet();
  function attach(ws) {
    if (!ws || attached.has(ws)) return;
    attached.add(ws);
    state.sockets++;
    ws.addEventListener('message', (ev) => onIncoming(ev.data));
  }
  (function hook() {
    const NativeWS = root.WebSocket;
    if (!NativeWS || root.__pocketSignalsHooked) return;
    root.__pocketSignalsHooked = true;
    const origSend = NativeWS.prototype.send;
    // Sockets created before this script ran are picked up on their next send (ping/pong every ~25s).
    NativeWS.prototype.send = function (data) {
      try {
        attach(this);
        onOutgoing(data);
      } catch (e) {
        state.errors++;
      }
      return origSend.apply(this, arguments);
    };
    const Wrapped = new Proxy(NativeWS, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
        try {
          attach(ws);
        } catch (e) {
          state.errors++;
        }
        return ws;
      },
    });
    try {
      root.WebSocket = Wrapped;
    } catch (e) {
      state.errors++;
    }
  })();

  // ---------- sound / vibration ----------
  let audioCtx = null;
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (root.AudioContext || root.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {
      audioCtx = null;
    }
  }
  function beep(freqs, vibrate) {
    if (!settings.sound) return;
    try {
      if (vibrate && navigator.vibrate) navigator.vibrate([180, 80, 180]);
    } catch (e) {
      /* ignore */
    }
    if (!audioCtx) return;
    try {
      let t0 = audioCtx.currentTime;
      for (const f of freqs) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start(t0);
        o.stop(t0 + 0.2);
        t0 += 0.22;
      }
    } catch (e) {
      /* ignore */
    }
  }

  // ---------- formatting ----------
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDur = (s) => {
    s = Math.max(0, Math.round(s));
    return s >= 3600 ? Math.floor(s / 3600) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60) : Math.floor(s / 60) + ':' + pad(s % 60);
  };
  const tfLabel = (tf) => (tf < 60 ? 'S' + tf : tf < 3600 ? 'M' + tf / 60 : 'H' + tf / 3600);
  const fmtP = (p) => (Number.isFinite(p) ? p.toFixed(p >= 100 ? 3 : p >= 10 ? 4 : 5) : '—');
  const fmtClock = (t) => {
    const d = new Date(t * 1000);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const prettyAsset = (a) => {
    const m = /^([A-Z]{3})([A-Z]{3})(_otc)?$/i.exec(a);
    if (m) return m[1].toUpperCase() + '/' + m[2].toUpperCase() + (m[3] ? ' OTC' : '');
    return a.replace(/^#/, '').replace(/_otc$/i, ' OTC');
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = (s) => '<bdi class="n">' + esc(s) + '</bdi>';
  const dirText = (d) => (d === 'CALL' ? '▲ BUY · شراء' : '▼ SELL · بيع');
  const resText = { win: '✅ ربح', loss: '❌ خسارة', tie: '➖ تعادل' };

  // ---------- UI ----------
  const CSS = `
:host { all: initial; }
.ps { position: fixed; z-index: 2147483647; top: 165px; left: 6px; width: 240px; max-width: calc(100vw - 16px);
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", Tahoma, sans-serif;
  color: #e7e9f1; background: rgba(22, 25, 37, .95); border: 1px solid #353b55; border-radius: 12px;
  box-shadow: 0 10px 28px rgba(0,0,0,.5); direction: rtl; -webkit-user-select: none; user-select: none; overflow: hidden; }
.ps[hidden] { display: none; }
.hdr { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #23283c; cursor: move; touch-action: none; }
.logo { font-size: 14px; }
.title { font-weight: 700; }
.badge { font-weight: 800; font-size: 11px; padding: 1px 6px; border-radius: 6px; background: #343a52; display: none; }
.ps.min .badge { display: inline-block; }
.badge.call { background: #2a9d4b; } .badge.put { background: #d63c34; }
.asset { margin-inline-start: auto; color: #a3abc4; font-size: 11px; white-space: nowrap; }
.hb { all: unset; width: 24px; height: 22px; display: grid; place-items: center; border-radius: 6px; background: #30364f; color: #d4d9e8; cursor: pointer; font-size: 13px; }
.body { padding: 7px; display: grid; gap: 6px; }
.ps.min .body { display: none; }
.sig { border-radius: 10px; padding: 8px 6px; text-align: center; background: #2a2f45; transition: background .2s; }
.sig.call { background: linear-gradient(#33b257, #26893f); }
.sig.put { background: linear-gradient(#ee4a40, #c4352d); }
.sig.pre-call { box-shadow: inset 0 0 0 2px #33b257; }
.sig.pre-put { box-shadow: inset 0 0 0 2px #ee4a40; }
.sig.win { background: #1f5133; } .sig.loss { background: #5a2523; } .sig.tie { background: #3a3f55; }
.main { font-size: 17px; font-weight: 800; letter-spacing: .2px; }
.sub { font-size: 11px; opacity: .92; margin-top: 3px; }
.meta { display: flex; justify-content: space-between; color: #a3abc4; font-size: 11px; }
.votes { display: flex; flex-wrap: wrap; gap: 4px; }
.votes:empty { display: none; }
.chip { padding: 2px 6px; border-radius: 6px; background: #1f2438; font-size: 11px; white-space: nowrap; }
.chip.up { background: rgba(69,209,111,.14); } .chip.down { background: rgba(255,97,87,.14); }
.up { color: #45d16f; } .down { color: #ff6157; } .flat { color: #6d7591; }
.box { background: #1f2438; border-radius: 8px; padding: 6px 7px; }
.good { color: #45d16f; } .bad { color: #ff6157; } .muted { color: #8890ab; font-size: 11px; }
.n { direction: ltr; unicode-bidi: isolate; font-variant-numeric: tabular-nums; }
details { background: #1f2438; border-radius: 8px; padding: 4px 7px; }
summary { cursor: pointer; color: #c9cfe0; padding: 2px 0; }
label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 5px 0; }
select, input[type=number] { font: inherit; color: #e7e9f1; background: #2a3049; border: 1px solid #3b4262; border-radius: 6px; padding: 2px 4px; max-width: 132px; }
input[type=number] { width: 60px; }
.btns { display: flex; gap: 6px; margin: 6px 0 2px; }
.btn { all: unset; flex: 1; text-align: center; padding: 4px; border-radius: 6px; background: #30364f; cursor: pointer; font-size: 11px; }
.foot { display: grid; gap: 2px; }
.pr { display: grid; grid-template-columns: 40px 1fr 40px 60px; gap: 4px; font-size: 11px; }
.status { color: #8890ab; font-size: 10.5px; }
.warn { color: #d9b25f; font-size: 10.5px; }
`;

  const HTML = `
<div class="ps" dir="rtl">
  <div class="hdr">
    <span class="logo">⚡</span><span class="title">إشارات</span><span class="badge"></span>
    <span class="asset"></span>
    <button class="hb b-min" title="تصغير / تكبير">–</button>
    <button class="hb b-close" title="إخفاء (اضغط الرابط مرة أخرى لإظهاره)">×</button>
  </div>
  <div class="body">
    <div class="sig"><div class="main"></div><div class="sub"></div></div>
    <div class="meta"><span class="clock"></span><span class="tfx"></span></div>
    <div class="votes"></div>
    <div class="box stats"></div>
    <div class="box paper"></div>
    <details class="settings"><summary>⚙ الإعدادات</summary>
      <label>الأصل <select class="s-asset"></select></label>
      <label>الاستراتيجية <select class="s-strategy"></select></label>
      <label>فريم الشموع <select class="s-tf"></select></label>
      <label>مزامنة الفريم مع الشارت <input type="checkbox" class="s-sync"></label>
      <label>مدة الصفقة <select class="s-expiry"></select></label>
      <label>أقل قوة للإشارة <select class="s-thr"></select></label>
      <label>نسبة الربح % <input type="number" class="s-payout" min="1" max="100"></label>
      <label>مبلغ الصفقة $ <input type="number" class="s-stake" min="1"></label>
      <label>صوت واهتزاز <input type="checkbox" class="s-sound"></label>
      <div class="btns"><button class="btn b-reset">مسح النتائج</button><button class="btn b-diag">نسخ التشخيص</button></div>
    </details>
    <div class="foot"><div class="status"></div><div class="warn">⚠ للتجربة على الحساب التجريبي. لا يوجد مؤشر يضمن الربح.</div></div>
  </div>
</div>`;

  const ui = { els: null, host: null, assetsChanged: true, settingsChanged: true, queued: false };

  function mountUI() {
    if (ui.host) return;
    const host = document.createElement('pocket-signals');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + CSS + '</style>' + HTML;
    const $ = (s) => shadow.querySelector(s);
    const els = {
      panel: $('.ps'),
      hdr: $('.hdr'),
      badge: $('.badge'),
      asset: $('.asset'),
      sig: $('.sig'),
      main: $('.main'),
      sub: $('.sub'),
      clock: $('.clock'),
      tfx: $('.tfx'),
      votes: $('.votes'),
      stats: $('.stats'),
      paper: $('.paper'),
      status: $('.status'),
      sAsset: $('.s-asset'),
      sStrategy: $('.s-strategy'),
      sTf: $('.s-tf'),
      sSync: $('.s-sync'),
      sExpiry: $('.s-expiry'),
      sThr: $('.s-thr'),
      sPayout: $('.s-payout'),
      sStake: $('.s-stake'),
      sSound: $('.s-sound'),
    };
    ui.els = els;
    ui.host = host;
    (document.body || document.documentElement).appendChild(host);

    if (settings.min) els.panel.classList.add('min');
    if (settings.pos) placePanel(settings.pos.x, settings.pos.y);

    els.sStrategy.innerHTML = Object.keys(Core.STRATEGIES)
      .map((k) => `<option value="${k}">${esc(Core.STRATEGIES[k].label)}</option>`)
      .join('');
    els.sTf.innerHTML = TF_OPTIONS.map((v) => `<option value="${v}">${tfLabel(v)}</option>`).join('');
    els.sExpiry.innerHTML = EXPIRY_OPTIONS.map((v) => `<option value="${v}">${fmtDur(v)}</option>`).join('');

    els.panel.addEventListener('pointerup', unlockAudio, { passive: true });
    els.panel.addEventListener('click', unlockAudio, { passive: true });
    $('.b-min').addEventListener('click', () => {
      settings.min = !settings.min;
      els.panel.classList.toggle('min', settings.min);
      saveSettings();
      scheduleRender();
    });
    $('.b-close').addEventListener('click', () => toggle(false));
    els.sAsset.addEventListener('change', () => {
      settings.asset = els.sAsset.value;
      saveSettings();
      state.active = null;
      resolveActive();
      rebuild();
      scheduleRender();
    });
    els.sStrategy.addEventListener('change', () => {
      settings.strategy = els.sStrategy.value;
      saveSettings();
      ui.settingsChanged = true;
      scheduleRender();
    });
    els.sTf.addEventListener('change', () => {
      settings.tf = +els.sTf.value;
      settings.syncTf = false;
      saveSettings();
      rebuild();
      ui.settingsChanged = true;
      scheduleRender();
    });
    els.sSync.addEventListener('change', () => {
      settings.syncTf = els.sSync.checked;
      saveSettings();
    });
    els.sExpiry.addEventListener('change', () => {
      settings.expiry = +els.sExpiry.value;
      saveSettings();
      scheduleRender();
    });
    els.sThr.addEventListener('change', () => {
      settings.thresholds[settings.strategy] = +els.sThr.value;
      saveSettings();
      scheduleRender();
    });
    els.sPayout.addEventListener('change', () => {
      const v = +els.sPayout.value;
      if (v > 0 && v <= 100) settings.payout = v;
      saveSettings();
      scheduleRender();
    });
    els.sStake.addEventListener('change', () => {
      const v = +els.sStake.value;
      if (v > 0) settings.stake = v;
      saveSettings();
      scheduleRender();
    });
    els.sSound.addEventListener('change', () => {
      settings.sound = els.sSound.checked;
      saveSettings();
      if (settings.sound) unlockAudio();
    });
    $('.b-reset').addEventListener('click', () => {
      if (!root.confirm('مسح كل النتائج المسجلة؟')) return;
      state.tracker.clear();
      store.set('history', []);
      scheduleRender();
    });
    $('.b-diag').addEventListener('click', copyDiag);

    // drag by header
    let drag = null;
    els.hdr.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = els.panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try {
        els.hdr.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });
    els.hdr.addEventListener('pointermove', (e) => {
      if (drag) placePanel(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      const r = els.panel.getBoundingClientRect();
      settings.pos = { x: Math.round(r.left), y: Math.round(r.top) };
      saveSettings();
    };
    els.hdr.addEventListener('pointerup', endDrag);
    els.hdr.addEventListener('pointercancel', endDrag);

    // keep the panel attached if the app re-renders <body>
    setInterval(() => {
      if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    }, 2000);
    setInterval(tick, 500);
    render();
  }

  function placePanel(x, y) {
    const p = ui.els.panel;
    const w = p.offsetWidth || 240;
    const maxX = Math.max(0, root.innerWidth - w);
    const maxY = Math.max(0, root.innerHeight - 40);
    p.style.left = Math.min(Math.max(0, x), maxX) + 'px';
    p.style.top = Math.min(Math.max(0, y), maxY) + 'px';
  }

  function toggle(show) {
    if (!ui.els) return;
    const p = ui.els.panel;
    p.hidden = show === undefined ? !p.hidden : !show;
  }

  function tick() {
    const now = nowS();
    if (state.tracker.dropStale(now, 90)) scheduleRender();
    resolveActive();
    render();
  }

  function scheduleRender() {
    if (ui.queued || !ui.els) return;
    ui.queued = true;
    setTimeout(render, 250);
  }

  function syncControls() {
    const e = ui.els;
    if (ui.assetsChanged) {
      ui.assetsChanged = false;
      const list = [...state.series.keys()].sort();
      if (settings.asset !== 'auto' && !list.includes(settings.asset)) list.push(settings.asset);
      e.sAsset.innerHTML =
        '<option value="auto">تلقائي (الشارت)</option>' +
        list.map((a) => `<option value="${esc(a)}">${esc(prettyAsset(a))}</option>`).join('');
      e.sAsset.value = settings.asset;
    }
    if (ui.settingsChanged) {
      ui.settingsChanged = false;
      const st = Core.STRATEGIES[settings.strategy];
      e.sStrategy.value = settings.strategy;
      if (!TF_OPTIONS.includes(settings.tf)) {
        e.sTf.insertAdjacentHTML('beforeend', `<option value="${settings.tf}">${tfLabel(settings.tf)}</option>`);
      }
      e.sTf.value = String(settings.tf);
      e.sSync.checked = settings.syncTf;
      e.sExpiry.value = String(settings.expiry);
      e.sThr.innerHTML = Array.from({ length: st.max }, (_, i) => i + 1)
        .map((v) => `<option value="${v}">${v} من ${st.max}</option>`)
        .join('');
      e.sThr.value = String(thr());
      e.sPayout.value = settings.payout;
      e.sStake.value = settings.stake;
      e.sSound.checked = settings.sound;
    }
  }

  function render() {
    ui.queued = false;
    const e = ui.els;
    if (!e) return;
    syncControls();
    const now = nowS();
    const a = state.active;
    const s = a ? state.series.get(a) : null;
    const tf = settings.tf;
    const hasData = !!(s && s.ticks.length);
    const left = hasData ? Math.max(0, Math.ceil(state.builder.bucket(now) + tf - now)) : null;
    const live = Core.evaluate(settings.strategy, state.builder.candles, thr());

    e.asset.textContent = a ? prettyAsset(a) : '—';
    e.clock.innerHTML = left == null ? 'الشمعة: —' : 'تغلق الشمعة بعد ' + num(fmtDur(left));
    e.tfx.innerHTML = num(tfLabel(tf)) + ' · صفقة ' + num(fmtDur(settings.expiry));

    // ----- signal box -----
    const open = a ? state.tracker.open.find((x) => x.asset === a && !x.paper) : null;
    const closed = state.tracker.closed.filter((x) => !x.paper);
    const lastRes = closed.length ? closed[closed.length - 1] : null;
    let cls = 'wait';
    let main = 'انتظار';
    let sub = '';
    let badge = '•';
    if (!hasData) {
      main = 'بانتظار البيانات';
      sub =
        state.hookMode === 'late'
          ? 'غيّر الأصل أو الفريم في الشارت مرة واحدة لبدء القراءة'
          : 'افتح الشارت… إذا تأخر غيّر الأصل مرة واحدة';
    } else if (open) {
      const age = now - open.t;
      const cur = s.lastP;
      const st = cur === open.entry ? 'tie' : cur > open.entry === (open.dir === 'CALL') ? 'win' : 'loss';
      cls = open.dir === 'CALL' ? 'call' : 'put';
      main = dirText(open.dir);
      badge = open.dir === 'CALL' ? '▲ BUY' : '▼ SELL';
      sub =
        age <= ENTRY_WINDOW
          ? 'ادخل الآن ' + num('(' + Math.max(0, Math.ceil(ENTRY_WINDOW - age)) + 's)') + ' · مدة ' + num(fmtDur(open.expiry)) + ' · قوة ' + num(Math.abs(open.score) + '/' + open.max)
          : 'جارية · تنتهي بعد ' + num(fmtDur(open.expiryAt - now)) + ' · ' + (st === 'win' ? 'رابحة الآن ✅' : st === 'loss' ? 'خاسرة الآن ❌' : 'متعادلة ➖');
    } else if (lastRes && lastRes.asset === a && now - lastRes.exitT < RESULT_SHOW) {
      cls = lastRes.result;
      main = resText[lastRes.result];
      badge = main;
      sub = (lastRes.dir === 'CALL' ? '▲ ' : '▼ ') + num(fmtP(lastRes.entry)) + ' ← ' + num(fmtP(lastRes.exit));
    } else if (!live.ready) {
      main = 'تجميع الشموع';
      sub = num(live.have + '/' + live.need) + ' — غيّر الفريم في الشارت ثم أرجعه لتحميل التاريخ فوراً';
    } else if (left != null && left <= PRE_WINDOW && live.dir) {
      cls = live.dir === 'CALL' ? 'pre-call' : 'pre-put';
      main = live.dir === 'CALL' ? 'استعد ▲ شراء' : 'استعد ▼ بيع';
      badge = live.dir === 'CALL' ? '▲؟' : '▼؟';
      sub = 'تأكيد عند إغلاق الشمعة بعد ' + num(left + 's');
    } else {
      sub = 'لا توجد إشارة قوية · القوة ' + num((live.score > 0 ? '+' : '') + live.score + '/' + live.max) + ' والمطلوب ' + num(String(live.threshold));
    }
    e.sig.className = 'sig ' + cls;
    e.main.textContent = main;
    e.sub.innerHTML = sub;
    e.badge.textContent = badge;
    e.badge.className = 'badge ' + (cls === 'call' || cls === 'pre-call' ? 'call' : cls === 'put' || cls === 'pre-put' ? 'put' : '');

    if (settings.min) return;

    // ----- indicator chips (live, including the forming candle) -----
    e.votes.innerHTML = live.ready
      ? live.votes
          .map((v) => {
            const c = v.vote > 0 ? 'up' : v.vote < 0 ? 'down' : 'flat';
            const arrow = v.vote > 0 ? '▲' : v.vote < 0 ? '▼' : '•';
            const val = v.key === 'rsi' || v.key === 'stoch' ? ' ' + num(v.value) : '';
            return `<span class="chip ${c}" title="${esc(v.label + ': ' + v.value)}">${esc(v.short)}${val} ${arrow}</span>`;
          })
          .join('')
      : '';

    // ----- real results for the current settings + last signals -----
    const filt = (x) => x.strategy === settings.strategy && x.tf === settings.tf && x.expiry === settings.expiry;
    const st = state.tracker.stats(filt);
    const be = Core.breakeven(settings.payout);
    const recent = state.tracker.open
      .filter((x) => !x.paper)
      .concat(closed.slice(-8))
      .sort((x, y) => x.t - y.t)
      .slice(-8)
      .map((x) => `<span title="${esc(fmtClock(x.t) + ' ' + prettyAsset(x.asset) + ' ' + x.dir)}">${x.result ? resText[x.result].slice(0, 1) : '⏳'}</span>`)
      .join('');
    if (!st.total) {
      e.stats.innerHTML =
        '<div>النتائج: لا شيء بعد لهذا الإعداد</div><div class="muted">كل إشارة تُسجَّل وتُحسب نتيجتها تلقائياً عند انتهاء المدة.</div>' +
        (recent ? '<div class="muted">آخر الإشارات: ' + recent + '</div>' : '');
    } else {
      const wr = st.winRate;
      const net = ((st.wins * settings.payout) / 100 - st.losses) * settings.stake;
      const ok = wr != null && wr > be;
      e.stats.innerHTML =
        `<div>✅ ${num(st.wins)} ❌ ${num(st.losses)} ➖ ${num(st.ties)} · الفوز <b class="${ok ? 'good' : 'bad'}">${num(wr == null ? '—' : (wr * 100).toFixed(1) + '%')}</b></div>` +
        `<div class="muted">للتعادل تحتاج ${num((be * 100).toFixed(1) + '%')} · الصافي (${num(settings.stake + '$')}/صفقة) <b class="${net >= 0 ? 'good' : 'bad'}">${num((net >= 0 ? '+' : '') + net.toFixed(2) + '$')}</b></div>` +
        `<div class="muted">آخر الإشارات: ${recent}</div>` +
        (st.wins + st.losses < 30 ? '<div class="muted">عينة صغيرة — لا تحكم قبل 30 إشارة.</div>' : '');
    }

    // ----- paper test: the same signals at several expiries -----
    const exps = [...new Set(PAPER_EXPIRIES.concat(settings.expiry))].sort((x, y) => x - y);
    e.paper.innerHTML =
      '<div>🧪 اختبار ورقي (نفس الإشارات)</div>' +
      exps
        .map((x) => {
          const r = state.tracker.stats((z) => z.strategy === settings.strategy && z.tf === settings.tf && z.expiry === x);
          const wr = r.winRate;
          const pnl = ((r.wins * settings.payout) / 100 - r.losses) * settings.stake;
          const cls = wr == null ? '' : wr > be ? 'good' : 'bad';
          const money = (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + '$';
          return '<div class="pr"><span>' + num(fmtDur(x)) + '</span><span>✅' + num(r.wins) + ' ❌' + num(r.losses) + '</span><b class="' + cls + '">' + num(wr == null ? '—' : (wr * 100).toFixed(0) + '%') + '</b><b class="' + (pnl >= 0 ? 'good' : 'bad') + '">' + num(money) + '</b></div>';
        })
        .join('');

    // ----- status -----
    const ticks = s ? s.ticks.length : 0;
    const stale = state.lastTickT ? Math.round((Date.now() - state.lastTickLocal) / 1000) : null;
    e.status.innerHTML =
      (state.sockets ? 'متصل' : 'لم يُلتقط الاتصال بعد') +
      ' · ' +
      num(ticks.toLocaleString('en')) +
      ' تيك · ' +
      num(state.builder.candles.length) +
      ' شمعة' +
      (stale != null && stale > 10 ? ' · <span class="bad">لا بيانات منذ ' + num(stale + 's') + '</span>' : '') +
      ' · v' +
      VERSION;
  }

  function copyDiag() {
    const d = {
      version: VERSION,
      ua: navigator.userAgent,
      mode: state.hookMode,
      sockets: state.sockets,
      frames: parser.frames,
      events: parser.events,
      errors: state.errors,
      chartAsset: state.chartAsset,
      active: state.active,
      series: [...state.series.values()].map((s) => ({ asset: s.asset, ticks: s.ticks.length, server: [...s.server.keys()] })),
      candles: state.builder.candles.length,
      settings: { strategy: settings.strategy, tf: settings.tf, expiry: settings.expiry },
      samples: parser.samples,
    };
    const text = JSON.stringify(d, null, 1);
    const fallback = () => root.prompt('انسخ النص التالي:', text);
    try {
      navigator.clipboard.writeText(text).then(() => root.alert('تم نسخ التشخيص ✅'), fallback);
    } catch (e) {
      fallback();
    }
  }

  root.__pocketSignals = {
    version: VERSION,
    core: Core,
    state,
    settings,
    toggle,
    ingest: onIncoming,
    outgoing: onOutgoing,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUI, { once: true });
  else mountUI();
})(typeof window !== 'undefined' ? window : globalThis);
