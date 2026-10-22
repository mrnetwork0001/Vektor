// Records the live production Vektor site (https://tryvektor.vercel.app) for the film.
//   ONLY=landing,grid node scripts/capture.mjs     (ONLY is required)
// All traffic goes through a SOCKS tunnel (PROXY, default socks5://127.0.0.1:1080) with DNS
// resolved remotely, because *.vercel.app is unreachable from the local network.
// Writes: NONE against Strike or the app's live accounts. The terminal runs in Demo mode,
// where every click (deploy, flash crash, hedge) is simulated in the browser.
// Output: .cache/frames/<clip>/, .cache/marks.json, .cache/meta.json (element rects in CSS px),
// public/stills/<name>.png. scripts/encode.mjs turns frames into public/footage/<clip>.mp4.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const BASE = process.env.BASE || "https://tryvektor.vercel.app";
const PROXY = process.env.PROXY || "socks5://127.0.0.1:1080";
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FRAMES = join(ROOT, ".cache/frames");
const STILLS = join(ROOT, "public/stills");
const VIEW = { w: 1600, h: 900 };
const ONLY = process.env.ONLY?.split(",");
if (!ONLY) { console.error("Set ONLY=<clip,...>: landing,grid,backtest,harvester,shield,docs,proof,proof_ada,health,explorers"); process.exit(1); }
const want = (c) => ONLY.includes(c);
mkdirSync(FRAMES, { recursive: true });
mkdirSync(STILLS, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(0)}s`, ...a);
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const marks = readJson(join(ROOT, ".cache/marks.json"));
const meta = readJson(join(ROOT, ".cache/meta.json"));
const mark = (k) => { marks[k] = Date.now() / 1000; log("mark", k); };
const save = () => {
  writeFileSync(join(ROOT, ".cache/marks.json"), JSON.stringify(marks, null, 1));
  writeFileSync(join(ROOT, ".cache/meta.json"), JSON.stringify(meta, null, 1));
};

const OVERLAY = `(() => {
  window.__ease = (el, prop, to, ms) => new Promise((done) => {
    const from = el[prop]; const start = performance.now();
    const f = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => { const p = Math.min(1, (now - start) / ms); el[prop] = from + (to - from) * f(p); if (p < 1) requestAnimationFrame(step); else done(el[prop]); };
    requestAnimationFrame(step);
  });
  if (document.getElementById('__cur')) return;
  const s = document.createElement('style');
  s.textContent = 'html{scroll-behavior:auto!important}#__cur{position:fixed;left:-40px;top:-40px;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(255,255,255,.96);box-shadow:0 0 0 2px rgba(37,250,176,.8),0 4px 16px rgba(0,0,0,.5);z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .3s ease,transform .12s ease-out,left .8s cubic-bezier(.22,1,.36,1),top .8s cubic-bezier(.22,1,.36,1)}#__cur.down{transform:scale(.7)}.__ring{position:fixed;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;border:2px solid rgba(37,250,176,.9);z-index:2147483646;pointer-events:none;animation:__r .6s ease-out forwards}@keyframes __r{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}';
  document.head.appendChild(s);
  const c = document.createElement('div'); c.id = '__cur'; document.body.appendChild(c);
})()`;

let b;
const js = (e) => b.js(e);
async function overlay() { await js(OVERLAY); }
async function glide(x, y, settle = 900) {
  await js(`(() => { const k = document.getElementById('__cur'); if (k) { k.style.opacity = '1'; k.style.left = '${x}px'; k.style.top = '${y}px'; } })()`);
  await sleep(820);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(Math.max(0, settle - 820));
}
async function cursorHide() { await js(`(() => { const k = document.getElementById('__cur'); if (k) k.style.opacity = '0'; })()`); }
async function clickAt(x, y) {
  await js(`(() => { const k = document.getElementById('__cur'); k?.classList.add('down'); const r = document.createElement('div'); r.className = '__ring'; r.style.left = '${x}px'; r.style.top = '${y}px'; document.body.appendChild(r); setTimeout(() => { k?.classList.remove('down'); r.remove(); }, 650); })()`);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(90);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
/** Finder for a button/element whose text starts with `t`. */
const byText = (t, sel = "button") => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(t)}))`;
async function center(finder) {
  const r = await b.rectOf(finder);
  if (!r) throw new Error("not found: " + finder.slice(0, 90));
  return [r.x + r.width / 2, r.y + r.height / 2];
}
async function press(finder, settle = 700) {
  const [x, y] = await center(finder);
  await glide(x, y);
  await clickAt(x, y);
  await sleep(settle);
}
/** Scroll so the element sits `top` px from the viewport top, eased. */
async function scrollTo(finder, top = 90, ms = 1400) {
  await js(`(() => { const e = ${finder}; if (!e) return; const y = e.getBoundingClientRect().top + scrollY - ${top}; return window.__ease(document.scrollingElement, 'scrollTop', y, ${ms}); })()`);
  await sleep(ms + 200);
}
async function rects(clip, finders) {
  meta[clip] = meta[clip] || { scale: 2, view: VIEW, rects: {} };
  for (const [k, f] of Object.entries(finders)) { const r = await b.rectOf(f); if (r) meta[clip].rects[k] = r; }
}
async function record(clip, fn) {
  if (!want(clip)) return;
  log("clip", clip);
  rmSync(join(FRAMES, clip), { recursive: true, force: true });
  const stop = await b.screencast(join(FRAMES, clip));
  marks[`${clip}:start`] = Date.now() / 1000;
  try { await fn(); } finally { await stop(); marks[`${clip}:end`] = Date.now() / 1000; save(); }
}

b = await launch({ width: VIEW.w, height: VIEW.h, extraArgs: [`--proxy-server=${PROXY}`, `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1`, "--force-device-scale-factor=2"] });
await b.send("Emulation.setDeviceMetricsOverride", { width: VIEW.w, height: VIEW.h, deviceScaleFactor: 2, mobile: false });

// Terminal in Demo mode, walkthrough marked as seen so it doesn't cover the UI.
async function openTerminal() {
  await b.goto(`${BASE}/app.html`, 2500);
  await js(`localStorage.setItem("vektor:walkthrough:v1","done")`);
  await b.goto(`${BASE}/app.html`, 6000);
  await overlay();
}

if (want("landing")) {
  await b.goto(`${BASE}/`, 6000); await overlay();
  await record("landing", async () => {
    await sleep(4500); mark("landing_hero");
    await scrollTo(`document.querySelector('#features')`, 70, 2200); mark("landing_features"); await sleep(2200);
    await scrollTo(`document.querySelector('#builder')`, 70, 2000); mark("landing_builder"); await sleep(2500);
  });
  await b.shot(join(STILLS, "landing_hero.png"));
}

if (["grid", "backtest", "harvester", "shield"].some(want)) {
  await openTerminal();
  await rects("terminal", {
    telemetry: `document.querySelector('[data-tour="telemetry"]')`,
    ladder: `document.querySelector('[data-tour="ladder"]')`,
    design: `document.querySelector('[data-tour="design"]')`,
  });
  await record("grid", async () => {
    await sleep(1500); mark("grid_view");
    await scrollTo(`document.querySelector('[data-tour="design"]')`, 80, 1200);
    await rects("grid", { design: `document.querySelector('[data-tour="design"]')`, deploy: `document.querySelector('[data-tour="deploy"]')` });
    await press(`document.querySelector('[data-tour="deploy"]')`, 900); mark("grid_deploy");
    await scrollTo(`document.querySelector('[data-tour="ladder"]')`, 70, 1200);
    await rects("grid", { ladder: `document.querySelector('[data-tour="ladder"]')`, telemetry: `document.querySelector('[data-tour="telemetry"]')` });
    await sleep(7000); mark("grid_running");
    await scrollTo(`document.querySelector('.log')`, 380, 1200);
    await rects("grid", { log: `document.querySelector('.log')` });
    await sleep(4000); mark("grid_log");
  });
  await b.shot(join(STILLS, "telemetry.png"), `document.querySelector('[data-tour="telemetry"]')`);

  await record("backtest", async () => {
    await scrollTo(`document.querySelector('[data-tour="backtest"]')`, 90, 1400); await sleep(600);
    await press(byText("Backtest this grid"), 400); mark("bt_click");
    await sleep(6000);
    await rects("backtest", { card: `document.querySelector('[data-tour="backtest"]')` }); mark("bt_result");
    const [x] = await center(byText("Backtest both"));
    await press(byText("Backtest both"), 400); mark("h2h_click");
    await sleep(6500);
    await rects("backtest", { h2h: `${byText("Backtest both")}?.closest('.panel')` }); mark("h2h_result");
    void x;
  });

  await record("shield", async () => {
    await js(`window.scrollTo(0,0)`); await sleep(500);
    await press(byText("Flash crash"), 300); mark("crash");
    await sleep(9000);
    await press(byText("Aegis Shield"), 600); mark("shield_tab");
    await rects("shield", { gauge: `document.querySelector('.gauge-row')?.closest('.panel')`, rules: `document.querySelector('[data-tour="shield-rules"]')`, log: `document.querySelector('.log.tall')?.closest('.panel')` });
    await sleep(6000); mark("shield_view");
  });

  await record("harvester", async () => {
    await press(byText("Funding Harvester"), 1200); mark("harv_tab");
    await rects("harvester", { radar: `document.querySelector('[data-tour="funding"]')` });
    await sleep(3000);
    await scrollTo(byText("Launch delta-neutral hedge"), 520, 1400);
    await rects("harvester", { sizer: `${byText("Launch delta-neutral hedge")}?.closest('.panel')` });
    await press(byText("Launch delta-neutral hedge"), 600); mark("harv_launch");
    await sleep(5000);
    await rects("harvester", { tracker: `${byText("Unwind hedge")}?.closest('.panel')` }); mark("harv_done");
    await sleep(2500);
  });
}

if (want("docs")) {
  await b.goto(`${BASE}/docs/quick-start`, 5000); await overlay();
  await record("docs", async () => { await sleep(3000); mark("docs_view"); await js(`window.__ease(document.scrollingElement,'scrollTop',700,2600)`); await sleep(3500); });
}
for (const [clip, acct] of [["proof", "01a164cf-36b1-7387-aa2f-199cc57f8c3f"], ["proof_ada", "01a16503-d2a3-74ad-855e-2362748ad8bb"]]) {
  if (!want(clip)) continue;
  await b.goto(`${BASE}/proof.html?account=${acct}&bps=10`, 9000); await overlay();
  await record(clip, async () => { await sleep(3000); mark(`${clip}_view`); await js(`window.__ease(document.scrollingElement,'scrollTop',900,3200)`); await sleep(4000); mark(`${clip}_scrolled`); });
  await b.shot(join(STILLS, `${clip}.png`));
}
if (want("health")) {
  await b.goto("https://vektor.38-49-213-208.sslip.io/health", 3000);
  await b.shot(join(STILLS, "health.png"));
}
if (want("explorers")) {
  const pages = {
    etherscan: "https://etherscan.io/tx/0x5000652a28260cc9152cb5df90327cf57c756ac0748b7fd7ec4f1c1416abd7e8",
    solscan: "https://solscan.io/tx/3Gf7BvvapQ1yKLNKrnsjrKSMz2PQUgc84JmqRQqMEKT9uPbsGihhBq1tfFEWFC1tLdJfpBNtShfxukHrpa36H9mW",
    cardanoscan: "https://cardanoscan.io/transaction/aaf4deb1f8d0df3b329b1b428624d1633fc4efd48ccd78bc6aa064e9541ae27c",
  };
  for (const [n, u] of Object.entries(pages)) { await b.goto(u, 12000); await b.shot(join(STILLS, `${n}.png`)); log("still", n); }
}

const errs = b.consoleLines.filter((l) => !/favicon|DevTools|third-party/i.test(l));
if (errs.length) console.log("console:", errs.slice(0, 8).join("\n"));
save();
b.close();
log("done");
