// End-to-end check in Chromium with a fake socket.io WebSocket.
// Needs Playwright (npm i -D playwright && npx playwright install chromium).
// Run: npm run build && npm run e2e
// Optional env: SHOT_DIR=<dir> (save screenshots), BG=<image> (page background), DSF=2
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pocket-signals.user.js'), 'utf8');
const BOOKMARKLET = fs.readFileSync(path.join(ROOT, 'dist', 'bookmarklet.txt'), 'utf8').trim();
const SHOT_DIR = process.env.SHOT_DIR;
const ASSET = 'EURJPY_otc';
const T0 = 1732230000; // minute aligned

const FAKE_WS = `(() => {
  class FakeWS extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; (window.__fakeSockets = window.__fakeSockets || []).push(this); }
    send(d) { this.sent.push(d); }
    close() {}
    emit(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  }
  FakeWS.OPEN = 1;
  window.WebSocket = FakeWS;
  const enc = new TextEncoder();
  window.__bin = (obj) => { const b = enc.encode(JSON.stringify(obj)); const u = new Uint8Array(b.length + 1); u[0] = 4; u.set(b, 1); return u.buffer; };
  window.__tick = (ws, a, t, p) => { ws.emit('451-["updateStream",{"_placeholder":true,"num":0}]'); ws.emit(window.__bin([[a, t, p]])); };
})();`;

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
// noisy uptrend, 1 tick per second with fractional timestamps
function series(from, seconds, start, drift, seed) {
  const r = rng(seed);
  const out = [];
  let p = start;
  for (let i = 0; i < seconds; i++) {
    p += drift + (r() - 0.5) * 0.004;
    out.push([+(from + i + 0.137).toFixed(3), +p.toFixed(3)]);
  }
  return out;
}

function pageHtml() {
  let bg = '#151826';
  if (process.env.BG) {
    const b64 = fs.readFileSync(process.env.BG).toString('base64');
    bg = `#151826 url(data:image/jpeg;base64,${b64}) top center / 100% auto no-repeat`;
  }
  const file = path.join(os.tmpdir(), 'pocket-signals-e2e.html');
  fs.writeFileSync(file, `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;height:100vh;background:${bg}"></body>`);
  return 'file://' + file;
}

async function panelText(page) {
  return page.evaluate(() => document.querySelector('pocket-signals').shadowRoot.querySelector('.ps').innerText);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: +(process.env.DSF || 1),
    isMobile: true,
    hasTouch: true,
    locale: 'ar',
  });
  const url = pageHtml();
  const hist = series(T0 - 5400, 5400, 174.0, 0.0004, 1);
  const live = series(T0, 600, hist[hist.length - 1][1], 0.0006, 2);
  const shot = async (page, name) => {
    if (!SHOT_DIR) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, name) });
  };

  // ---------- A: userscript installed at document-start ----------
  {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(FAKE_WS);
    await page.addInitScript(SRC);
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('pocket-signals'));

    await page.evaluate(
      ({ ASSET, hist }) => {
        const ws = new WebSocket('wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket');
        window.__ws = ws;
        ws.emit('0{"sid":"x","pingInterval":25000}');
        ws.emit('40');
        ws.send('42["changeSymbol",{"asset":"' + ASSET + '","period":60}]');
        ws.emit('451-["updateHistoryNewFast",{"_placeholder":true,"num":0}]');
        ws.emit(window.__bin({ asset: ASSET, period: 60, history: hist }));
      },
      { ASSET, hist },
    );
    let st = await page.evaluate(() => {
      const s = window.__pocketSignals.state;
      return { mode: s.hookMode, sockets: s.sockets, active: s.active, candles: s.builder.candles.length, chart: s.chartAsset };
    });
    assert.equal(st.mode, 'early');
    assert.equal(st.sockets, 1);
    assert.equal(st.active, ASSET);
    assert.equal(st.chart, ASSET);
    assert.ok(st.candles >= 35, 'history should give enough candles, got ' + st.candles);
    console.log('A1 history loaded:', st);

    // stream live ticks until a signal opens
    const opened = await page.evaluate(
      async ({ ASSET, live }) => {
        const s = window.__pocketSignals.state;
        for (let i = 0; i < live.length; i++) {
          window.__tick(window.__ws, ASSET, live[i][0], live[i][1]);
          if (s.tracker.open.length) return { i, sig: s.tracker.open[0] };
          if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        return null;
      },
      { ASSET, live },
    );
    assert.ok(opened, 'expected a signal on the trending data');
    console.log('A2 signal:', opened.sig.dir, 'score', opened.sig.score + '/' + opened.sig.max, 'at tick', opened.i);
    await page.waitForTimeout(600);
    let text = await panelText(page);
    assert.match(text, /BUY|SELL/);
    assert.match(text, /ادخل الآن/);
    await shot(page, '1-signal.png');

    // continue until the trade expires and is scored
    const resolved = await page.evaluate(
      async ({ ASSET, live, from }) => {
        const s = window.__pocketSignals.state;
        for (let i = from + 1; i < live.length; i++) {
          window.__tick(window.__ws, ASSET, live[i][0], live[i][1]);
          const main = s.tracker.closed.filter((x) => !x.paper);
          if (main.length) return main[main.length - 1];
          if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        return null;
      },
      { ASSET, live, from: opened.i },
    );
    assert.ok(resolved, 'signal should resolve after expiry');
    assert.equal(resolved.exitT - resolved.t >= 180, true);
    console.log('A3 resolved:', resolved.dir, resolved.entry, '->', resolved.exit, resolved.result);
    await page.waitForTimeout(600);
    text = await panelText(page);
    assert.match(text, /الفوز/);
    await shot(page, '2-result.png');

    // paper test: the same signal was also scored at 15s and 1m
    const paper = await page.evaluate(() => window.__pocketSignals.state.tracker.closed.filter((x) => x.paper).map((x) => ({ expiry: x.expiry, result: x.result, held: x.exitT - x.t })));
    assert.deepEqual(paper.map((x) => x.expiry).sort((a, b) => a - b), [15, 60]);
    assert.ok(paper.every((x) => x.held >= x.expiry && x.held < x.expiry + 2));
    console.log('A3b paper:', paper);
    assert.match(text, /اختبار ورقي/);

    // history is persisted (main + 2 paper)
    const savedCount = await page.evaluate(() => JSON.parse(localStorage.getItem('pocketSignals.v1.history') || '[]').length);
    assert.equal(savedCount, 3);

    // switching strategy updates the threshold choices
    await page.evaluate(() => {
      const r = document.querySelector('pocket-signals').shadowRoot;
      r.querySelector('details').open = true;
      const sel = r.querySelector('.s-strategy');
      sel.value = 'reversal';
      sel.dispatchEvent(new Event('change'));
    });
    await page.waitForTimeout(400);
    const thrOpts = await page.evaluate(() => document.querySelector('pocket-signals').shadowRoot.querySelectorAll('.s-thr option').length);
    assert.equal(thrOpts, 4);
    await shot(page, '3-settings.png');

    // minimize -> small pill
    await page.evaluate(() => document.querySelector('pocket-signals').shadowRoot.querySelector('.b-min').click());
    await page.waitForTimeout(300);
    const h = await page.evaluate(() => document.querySelector('pocket-signals').shadowRoot.querySelector('.ps').offsetHeight);
    assert.ok(h < 50, 'minimized height ' + h);
    assert.deepEqual(errors, []);
    console.log('A4 settings + minimize ok');
    await page.close();
  }

  // ---------- B: bookmarklet injected after the socket already exists ----------
  {
    const page = await (await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(FAKE_WS);
    await page.goto(url);
    await page.evaluate(
      ({ ASSET, live }) => {
        window.__ws = new WebSocket('wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket');
        for (let i = 0; i < 5; i++) window.__tick(window.__ws, ASSET, live[i][0], live[i][1]);
      },
      { ASSET, live },
    );
    const code = decodeURIComponent(BOOKMARKLET.replace(/^javascript:/, ''));
    await page.evaluate((c) => (0, eval)(c), code);
    let st = await page.evaluate(() => ({ mode: window.__pocketSignals.state.hookMode, sockets: window.__pocketSignals.state.sockets }));
    assert.deepEqual(st, { mode: 'late', sockets: 0 });

    // the page's next send (engine.io pong) lets the script attach to the existing socket
    await page.evaluate(
      ({ ASSET, hist, live }) => {
        const ws = window.__ws;
        ws.send('3');
        ws.send('42["changeSymbol",{"asset":"' + ASSET + '","period":60}]');
        ws.emit('451-["loadHistoryPeriod",{"_placeholder":true,"num":0}]');
        ws.emit(window.__bin({ asset: ASSET, period: 60, history: hist }));
        for (let i = 5; i < 40; i++) window.__tick(ws, ASSET, live[i][0], live[i][1]);
      },
      { ASSET, hist, live },
    );
    st = await page.evaluate(() => {
      const s = window.__pocketSignals.state;
      return { sockets: s.sockets, ticks: s.series.get('EURJPY_otc').ticks.length, candles: s.builder.candles.length };
    });
    assert.equal(st.sockets, 1);
    assert.ok(st.ticks >= hist.length + 35, 'ticks ' + st.ticks);
    assert.ok(st.candles >= 35);
    console.log('B1 late attach ok:', st);

    // running the bookmarklet again toggles the panel instead of loading twice
    await page.evaluate((c) => (0, eval)(c), code);
    const hidden = await page.evaluate(() => document.querySelector('pocket-signals').shadowRoot.querySelector('.ps').hidden);
    assert.equal(hidden, true);
    assert.deepEqual(errors, []);
    console.log('B2 toggle ok');
  }

  await browser.close();
  console.log('e2e: all checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
