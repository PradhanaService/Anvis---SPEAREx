// End-to-end test of every part of the Anvis web page, in a real (headless) browser.
//
// Start the app first (python app.py), then, from this folder:
//     npm install            # once: installs Playwright
//     npx playwright install chromium   # once: downloads the browser
//     node ui.test.mjs       # or: BASE_URL=http://host:port node ui.test.mjs
//
// It uses live SPHEREx data from IRSA and Gaia data from MAST (internet needed). Failures of
// those services are simulated by intercepting the page's own requests. Each check prints
// PASS or FAIL; the exit code is the number of failures.

import { chromium, devices } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const BARNARD_STACKS = "#ra=269.446259&dec=4.768324&size=240&band=SPHEREx-D3";
const BARNARD = BARNARD_STACKS + "&view=frames";   // most checks are about single frames
const results = [];
let browser;

// ------------------------------------------------------------------ tiny test harness
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log("PASS", name); }
  catch (e) { results.push([false, name]); console.log("FAIL", name, "\n     ", String(e.message || e).split("\n")[0]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A fresh page; console errors and page errors are collected in page.errors.
async function open(hash = "", opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 820 }, ...opts });
  // Original-file links point at ~70 MB FITS files: answer them locally instead of downloading.
  await ctx.route("https://irsa.ipac.caltech.edu/ibe/**", (r) => r.fulfill({ status: 200, contentType: "text/plain", body: "FITS" }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  if (opts.setup) await opts.setup(page);
  await page.goto(BASE + "/" + hash);
  return page;
}
const previewReady = (p) => p.waitForFunction(() => document.getElementById("pvLoading").hidden, null, { timeout: 120000 });
const exploreReady = (p) => p.waitForFunction(() => ex.lists[ex.view] && ex.lists[ex.view].finished, null, { timeout: 400000 });
const close = (p) => p.context().close();
// setup for open(): answer requests matching pattern with this status and JSON body
const routeJSON = (pattern, status, body) => async (page) => page.route(pattern, (r) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
async function newTab(p, action) {        // run action; return the URL of the tab it opens (or null)
  const [tab] = await Promise.all([p.context().waitForEvent("page", { timeout: 5000 }).catch(() => null), action()]);
  const url = tab ? tab.url() : null; if (tab) await tab.close(); return url;
}
// How many non-black pixels a canvas has (is a picture drawn?).
const litPixels = (p, sel) => p.$eval(sel, (c) => {
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0;
  for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
  return n;
});
const search = (p) => p.click("#goBtn");
// Page 1 starts on the empty sky grid; type Barnard's Star's position (as a user would) and wait
// for its SPHEREx picture.
async function pickBarnard(p) {
  await p.fill("#ra", "269.44626"); await p.fill("#dec", "+4.76832"); await p.press("#dec", "Tab");
  await p.waitForFunction(() => pk.center && Math.abs(pk.center.ra - 269.44626) < 1e-4, null, { timeout: 10000 });
  await previewReady(p);
}

// ================================================================== page 1: pick
async function page1() {
  const p = await open();
  const requests = []; p.on("request", (r) => { if (/\/api\/(frames|cutout)/.test(r.url())) requests.push(r.url()); });
  await check("P1 starts on an empty sky grid (black, lines only): nothing is downloaded until the user chooses", async () => {
    assert(await p.isVisible("#pvMap") && await p.isHidden("#pvSky"), "map first");
    await p.waitForTimeout(1500);
    assert(!requests.length, "downloaded without user input: " + requests.join());
    assert((await p.inputValue("#ra")) === "" && (await p.inputValue("#dec")) === "");
    assert((await p.locator("#pvMap .ov, #pvMap button").count()) === 0, "no text or buttons on the grid");
    const colours = await p.$eval("#pvMap canvas", (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) n++; return n; });
    assert(colours === 0, "only gray lines on black");
  });
  const mp = await p.locator("#pvMap").boundingBox();
  await check("P1 sky grid: hover reads RA / Dec; a click chooses the spot and then loads its picture", async () => {
    const want = await p.evaluate(() => mapSky(mapSize().W * 0.35, mapSize().H * 0.45));
    await p.mouse.move(mp.x + mp.width * 0.35, mp.y + mp.height * 0.45);
    assert(/^RA\s+\d\dh \d\dm \d\d\.\ds\nDEC [+−]\d\d° \d\d′ \d\d″$/.test(await p.textContent("#pvMap .hovertag")), await p.textContent("#pvMap .hovertag"));
    await p.mouse.click(mp.x + mp.width * 0.35, mp.y + mp.height * 0.45);
    assert(near(parseFloat(await p.inputValue("#ra")), want.ra, 0.01) && near(parseFloat(await p.inputValue("#dec")), want.dec, 0.01));
    assert(await p.isVisible("#pvSky") && await p.isVisible("#mapBtn"));
    await p.waitForFunction(() => pk.center, null, { timeout: 5000 });
    assert(requests.length > 0, "picture requested after the click");
    await p.click("#mapBtn");
    assert(await p.isVisible("#pvMap") && await p.isHidden("#pvSky"), "SKY MAP returns to the grid");
  });
  await pickBarnard(p);

  await check("P1 preview: a real SPHEREx image is drawn, labelled with the start preset", async () => {
    assert((await litPixels(p, "#pvSky canvas")) > 500, "canvas is blank");
    assert((await p.textContent("#pvName")) === "Barnard's Star");
    assert(/D3 · 1\.63–2\.41 µm · 6\.15″\/px/.test(await p.textContent("#pvSubl")));
  });
  await check("P1 preview credit links to the image file at IRSA", async () => {
    const url = await newTab(p, () => p.click("#pvCredit a"));
    assert(url && url.startsWith("https://irsa.ipac.caltech.edu/ibe/data/spherex/"), "no tab: " + url);
  });
  await check("P1 sidebar: typed position recognised as a preset, preset highlighted", async () => {
    assert((await p.inputValue("#ra")) === "269.44626" && (await p.inputValue("#dec")) === "+4.76832");
    assert((await p.textContent("#raHint")) === "= 17h 57m 47.1s");
    assert((await p.locator(".pr.on").allTextContents()).join() === "Barnard's Star");
  });
  await check("P1 dashed field box shows the area Search will fetch", async () => {
    assert(await p.isVisible(".region"));
    assert(/^4′ × [\d.]+′ FIELD$/.test(await p.textContent(".region .rtag")));
  });

  const sky = await p.locator("#pvSky").boundingBox();
  await check("P1 hover: crosshair and RA/Dec read-out follow the mouse", async () => {
    await p.mouse.move(sky.x + sky.width * 0.3, sky.y + sky.height * 0.4);
    assert(await p.isVisible("#pvSky .cross-h") && await p.isVisible("#pvSky .cross-v"));
    assert(/^RA\s+\d\dh \d\dm \d\d\.\ds\nDEC [+−]\d\d° \d\d′ \d\d″$/.test(await p.textContent("#pvSky .hovertag")));
    await p.mouse.move(sky.x - 50, sky.y - 50);
    assert(await p.isHidden("#pvSky .hovertag"), "read-out stays after leaving");
  });
  await check("P1 click picks a position: fields, label, ring, presets update", async () => {
    await p.mouse.click(sky.x + sky.width * 0.3, sky.y + sky.height * 0.4);
    assert((await p.inputValue("#ra")) !== "269.44626", "RA not updated");
    assert((await p.textContent("#pvName")) === "Custom field");
    assert(await p.isVisible(".selmark .ring"), "selection ring");
    assert((await p.locator(".pr.on").count()) === 0);
  });
  await check("P1 zoom buttons, mouse wheel and drag-to-pan", async () => {
    await p.click('#pvZoom [data-zoom="in"]');
    assert((await p.textContent("#pvZoom .zpct")) === "150%");
    await p.click('#pvZoom [data-zoom="out"]');
    assert((await p.textContent("#pvZoom .zpct")) === "100%");
    await p.mouse.move(sky.x + sky.width / 2, sky.y + sky.height / 2); await p.mouse.wheel(0, -300); await p.waitForTimeout(150);
    assert((await p.textContent("#pvZoom .zpct")) !== "100%", "wheel did not zoom");
    const t0 = await p.evaluate(() => pvView.tx);
    await p.mouse.move(sky.x + 500, sky.y + 300); await p.mouse.down(); await p.mouse.move(sky.x + 380, sky.y + 260, { steps: 6 }); await p.mouse.up();
    assert((await p.evaluate(() => pvView.tx)) !== t0, "drag did not pan");
    assert((await p.inputValue("#ra")) !== "", "drag must not clear the pick");
  });
  await check("P1 there are only zoom in / zoom out buttons (no reset, no tabs)", async () => {
    const labels = await p.locator("#pvZoom button").evaluateAll((b) => b.map((x) => x.getAttribute("aria-label")));
    assert(labels.join() === "Zoom in,Zoom out", labels.join());
    assert((await p.locator(".tabs, .tab, .scale, .disclaim").count()) === 0);
  });
  await check("P1 coordinate parsing: degrees and sexagesimal, with hints", async () => {
    await p.fill("#ra", "14 03 12.5"); await p.fill("#dec", "+54 20 56");
    assert((await p.textContent("#raHint")) === "= 14h 03m 12.5s");
    assert((await p.textContent("#decHint")) === "= +54° 20′ 56″");
    await p.fill("#ra", "210.80227");
    assert((await p.textContent("#raHint")) === "= 14h 03m 12.5s");
  });
  await check("P1 typing a far-away position re-centres the preview there", async () => {
    await p.press("#dec", "Tab");
    await p.waitForFunction(() => Math.abs(pk.center.ra - 210.80227) < 1e-4, null, { timeout: 10000 });
    await previewReady(p);
    assert((await litPixels(p, "#pvSky canvas")) > 500);
  });
  await check("P1 invalid input shows clear errors and blocks the search", async () => {
    await p.fill("#ra", "400"); await p.press("#ra", "Tab");
    assert(/RA should be/.test(await p.textContent("#err")));
    await p.fill("#ra", "210.8"); await p.fill("#dec", "95"); await p.press("#dec", "Tab");
    assert(/Dec should be/.test(await p.textContent("#err")));
    await p.fill("#dec", ""); await p.click("#goBtn");
    assert(/Enter both/.test(await p.textContent("#err")) && await p.isVisible("#pick"));
    await p.fill("#dec", "+54.34895"); await p.press("#dec", "Tab");
  });
  await check("P1 field-height slider: labelled, 1′–30′ by keyboard, field size and download estimate", async () => {
    assert((await p.getAttribute("#size", "aria-label")).includes("1 to 30") && (await p.getAttribute("#size", "title")).length > 40);
    assert(/^Field 4′ × [\d.]+′$/.test(await p.textContent("#sizeHint")) && (await p.textContent("#sizeVal")) === "4′");
    await p.focus("#size"); await p.keyboard.press("End");
    assert((await p.inputValue("#size")) === "30" && (await p.textContent("#sizeVal")) === "30′");
    assert((await p.textContent("#sizeHint")) === "Field 30′ × 30′", "width must stop at the backend's 1800″");
    await p.waitForFunction(() => /MB/.test(document.getElementById("sizeEst").textContent), null, { timeout: 60000 });
    assert(/^~\d+( of \d+)? frames · ~[\d.]+ MB · larger = slower$/.test(await p.textContent("#sizeEst")), await p.textContent("#sizeEst"));
    const big = parseFloat((await p.textContent("#sizeEst")).split("~")[2]);
    await p.keyboard.press("Home"); assert((await p.inputValue("#size")) === "1");
    await p.waitForFunction((b) => /MB/.test(document.getElementById("sizeEst").textContent) && parseFloat(document.getElementById("sizeEst").textContent.split("~")[2]) < b, big, { timeout: 60000 });
    for (let i = 0; i < 3; i++) await p.keyboard.press("ArrowRight");
    assert((await p.inputValue("#size")) === "4");
  });
  await check("P1 credit names the data releases in use", async () => {
    await p.waitForFunction(() => /Releases/.test(document.getElementById("pvReleases").textContent), null, { timeout: 20000 });
    assert(/^ · Releases DR1 \+ QR3$/.test(await p.textContent("#pvReleases")), await p.textContent("#pvReleases"));
  });
  await check("P1 changing the band reloads the preview in that band", async () => {
    await p.selectOption("#band", "SPHEREx-D5"); await previewReady(p);
    assert(/^D5 · 3\.83–4\.41 µm/.test(await p.textContent("#pvSubl")));
    assert(/SPHEREx D5/.test(await p.textContent("#pvCredit")));
    await p.selectOption("#band", "SPHEREx-D3"); await previewReady(p);
  });
  await check("P1 Search is a normal labelled button", async () => {
    assert((await p.textContent("#goBtn")).trim() === "SEARCH" && (await p.getAttribute("#goBtn", "type")) === "submit");
    assert((await p.getAttribute("#goBtn", "title")).length > 10 && (await p.locator("#goSlide").count()) === 0);
  });
  await check("P1 Search opens page 2 for the typed position", async () => {
    const typed = await p.evaluate(() => parseRA($("ra").value));
    await search(p);
    assert(await p.isVisible("#explore"));
    assert(near(await p.evaluate(() => ex.target.ra), typed, 1e-6));
  });
  if (p.errors.length) await check("P1 no script errors", async () => assert(false, p.errors.join(" | ")));
  await close(p);

  for (const [label, act] of [
    ["Enter on the Search button", async (q) => { await q.focus("#goBtn"); await q.keyboard.press("Enter"); }],
    ["Space on the Search button", async (q) => { await q.focus("#goBtn"); await q.keyboard.press(" "); }],
    ["Enter in the Dec field", async (q) => { await q.press("#dec", "Enter"); }],
  ]) {
    const q = await open(); await pickBarnard(q);
    await check(`P1 keyboard search: ${label}`, async () => { await act(q); await q.waitForTimeout(200); assert(await q.isVisible("#explore")); });
    await close(q);
  }

  const q = await open(); await previewReady(q);
  await check("P1 presets: five targets; each fills the target, 10′ and D3, and searches", async () => {
    const names = await q.locator(".pr").allTextContents();
    assert(names.join() === "WISE 0855,Barnard's Star,Epsilon Indi B,RW Aurigae,R Draconis", names.join());
    await q.click('.pr:has-text("Epsilon Indi B")');
    assert(await q.isVisible("#explore"));
    const s = await q.evaluate(() => ({ ra: ex.target.ra, dec: ex.target.dec, h: ex.h, band: ex.band }));
    assert(near(s.ra, 331.096669, 1e-6) && near(s.dec, -56.800649, 1e-6) && s.h === 600 && s.band === "SPHEREx-D3", JSON.stringify(s));
  });
  await close(q);
}

// ================================================================== page 2: epoch stacks
// Pixel-scale noise of a frame: robust spread of (pixel - mean of its 4 neighbours). Sky structure
// (stars, background) mostly cancels, so this measures the noise.
const pixelNoise = (p, cut) => p.evaluate((c) => {
  const r = [], W = c.width, v = (x, y) => c.data[y * W + x];
  for (let y = 1; y < c.height - 1; y++) for (let x = 1; x < W - 1; x++) {
    const a = [v(x, y), v(x - 1, y), v(x + 1, y), v(x, y - 1), v(x, y + 1)];
    if (a.every((q) => q !== null)) r.push(a[0] - (a[1] + a[2] + a[3] + a[4]) / 4);
  }
  r.sort((a, b) => a - b); const m = r[r.length >> 1];
  const d = r.map((q) => Math.abs(q - m)).sort((a, b) => a - b);
  return 1.4826 * d[d.length >> 1];
}, cut);

async function stacks() {
  const p = await open(BARNARD_STACKS);
  await exploreReady(p);
  await check("STACK default view: one chip per survey epoch with its months and frame count", async () => {
    assert(await p.evaluate(() => ex.view === "stacks"));
    assert((await p.getAttribute('[data-view="stacks"]', "aria-pressed")) === "true");
    const n = await p.evaluate(() => ex.frames.length);
    assert(n >= 2 && (await p.locator(".fr").count()) === n, "epochs " + n);
    const t = await p.locator(".fr").first().innerText();
    assert(/^Survey 1\s+\w{3}(–\w{3})? 20\d\d(–\w{3} 20\d\d)? · \d+ frames$/.test(t.trim()), t);
    const total = await p.evaluate(() => ex.frames.reduce((a, s) => a + s.n, 0));
    assert(total === await p.evaluate(() => ex.lists.frames.items.length), "every frame in one epoch");
  });
  await check("STACK label shows the epoch's dates, wavelength range and frames stacked", async () => {
    assert(/^Survey 1 · \d{1,2} \w{3}( 20\d\d)? – \d{1,2} \w{3} 20\d\d$|^Survey 1 · \d{1,2} \w{3} 20\d\d$/.test(await p.textContent("#shownDate")), await p.textContent("#shownDate"));
    assert(/^λ \d\.\d\d–\d\.\d\d µm · \d+ frames stacked · D3 · (DR1|QR3)$/.test(await p.textContent("#chanShort")), await p.textContent("#chanShort"));
    assert(/stack of \d+ images/.test(await p.textContent("#exCredit")));
  });
  await check("VIEW switching to Single frames loads every image", async () => {
    await p.click('[data-view="frames"]');
    await p.waitForFunction(() => ex.lists.frames.finished, null, { timeout: 400000 });
    assert((await p.locator(".fr").count()) === await p.evaluate(() => ex.lists.frames.items.length));
  });
  await check("VIEW switching keeps the same epoch and is saved in the URL", async () => {
    assert(await p.evaluate(() => ex.view === "frames" && ex.frames[ex.current].epoch === 0));
    assert(/view=frames/.test(await p.evaluate(() => location.hash)));
    await p.locator(".fr").last().click();
    const e = await p.evaluate(() => ex.frames[ex.current].epoch);
    await p.click('[data-view="stacks"]');
    assert(await p.evaluate((e) => ex.view === "stacks" && ex.current === e, e));
    assert(!/view=/.test(await p.evaluate(() => location.hash)));
  });
  await check("STACK Prev / Next / BLINK step through epochs", async () => {
    await p.locator(".fr").first().click(); await p.click("#next");
    assert((await p.textContent("#frameNo")).startsWith("2/"));
    await p.click('[data-mode="blink"]'); assert(/SURVEY 1 ↔ SURVEY 2/.test(await p.textContent("#modeLabel")), await p.textContent("#modeLabel"));
    await p.click('[data-mode="normal"]');
  });
  await check("STACK DIFF: Barnard's Star leaves a bright + dark pair (it moved north)", async () => {
    await p.locator(".fr").last().click();
    await p.click('[data-mode="diff"]'); await p.selectOption("#refSel", "first");
    // Along the column through the star: the strongest positive change lies north of the strongest negative one.
    const r = await p.evaluate(() => {
      const d = ex.diff, W = d.width, x0 = Math.round(W / 2);
      let best = { pos: [-Infinity, 0], neg: [Infinity, 0] };
      for (let y = 0; y < d.height; y++) for (let x = x0 - 2; x <= x0 + 2; x++) {
        const v = d.data[y * W + x]; if (v === null) continue;
        if (v > best.pos[0]) best.pos = [v, y]; if (v < best.neg[0]) best.neg = [v, y];
      }
      return best;
    });
    assert(r.pos[0] >= 5 && r.neg[0] <= -5 && r.pos[1] < r.neg[1], JSON.stringify(r));   // row 0 = north
    await p.selectOption("#refSel", "prev"); await p.click('[data-mode="normal"]');
    await p.locator(".fr").nth(1).click();
  });
  await check("STACK pop-up shows the epoch, images stacked, wavelengths and noise", async () => {
    const sky = await p.locator("#exSky").boundingBox(); await p.mouse.click(sky.x + sky.width / 3, sky.y + sky.height / 3);
    const t = await p.textContent("#popRows");
    assert(/Survey epoch2 ·/.test(t) && /Stacked\d+ of \d+ images/.test(t) && /Wavelengths\d\.\d{3}–\d\.\d{3} µm/.test(t) && /Noise \(1σ\)0\.\d+ MJy\/sr/.test(t), t);
    await p.click("#popClose");
  });
  await check("STACK the VIEW buttons have labels and tooltips", async () => {
    for (const v of ["stacks", "frames"]) {
      const b = p.locator(`[data-view="${v}"]`);
      assert((await b.getAttribute("aria-label")) && (await b.getAttribute("title")).length > 40);
    }
  });

  await check("LOCK is on by default for stacks, off for single frames, and saved in the URL when changed", async () => {
    assert((await p.getAttribute("#lockBtn", "aria-pressed")) === "true");
    const r0 = await p.evaluate(() => lockRange()), first = await p.evaluate(() => ex.frames[0].range);
    assert(r0 && first && r0[0] === first[0] && r0[1] === first[1], "scale from the first epoch");
    await p.click('[data-view="frames"]');
    assert((await p.getAttribute("#lockBtn", "aria-pressed")) === "false");
    await p.click("#lockBtn"); assert(/lock=1/.test(await p.evaluate(() => location.hash)));
    await p.click("#lockBtn"); await p.click('[data-view="stacks"]');
    assert((await p.getAttribute("#lockBtn", "aria-pressed")) === "true" && !/lock=/.test(await p.evaluate(() => location.hash)));
  });
  await check("CURVE: one point per loaded epoch; clicking a point shows that epoch; closes", async () => {
    if (await p.isHidden("#curve")) await p.click("#curveBtn");
    assert(await p.isVisible("#curve") && (await p.getAttribute("#curveBtn", "aria-pressed")) === "true");
    const n = await p.evaluate(() => ex.frames.filter((f) => f.cut).length);
    assert((await p.locator("#curveSvg .cvpt").count()) === n, "points");
    assert(/^TARGET BRIGHTNESS|^SATURATED/.test(await p.textContent("#curveTitle")));
    assert(/mJy/.test(await p.getAttribute("#curveSvg", "aria-label")));
    await p.locator('#curveSvg .cvpt[data-i="1"] circle').first().click();
    assert((await p.textContent("#frameNo")).startsWith("2/"), await p.textContent("#frameNo"));
    assert((await p.locator('#curveSvg .cvpt[data-i="1"] circle[stroke="#E03C31"]').count()) === 1, "current point highlighted");
    await p.click("#curveClose"); assert(await p.isHidden("#curve"));
    await p.click("#curveBtn"); assert(await p.isVisible("#curve"));
  });
  await close(p);

  const rd = await open("#ra=248.167611&dec=66.754979&size=600&band=SPHEREx-D3&curve=1");
  await exploreReady(rd);
  await check("CURVE: a saturated star (R Draconis) is measured in its halo ring, and it changes", async () => {
    assert(/^SATURATED/.test(await rd.textContent("#curveTitle")) && /ring \d+–\d+″/.test(await rd.textContent("#curveNote")));
    const f = await rd.evaluate(() => ex.frames.map((x) => x.phot && x.phot.flux));
    assert(f.length >= 2 && f.every((v) => v > 0) && Math.max(...f) / Math.min(...f) > 1.5, JSON.stringify(f));
  });
  await close(rd);

  // WISE overlay: click the WISE source nearest a sky position (at the date on screen); return the pop-up text.
  const clickWise = async (q, ra, dec) => {
    const pt = await q.evaluate(([ra, dec]) => {
      const f = ex.frames[ex.current]; let best = null, bd = 1e9;
      wise.data.sources.forEach((s, i) => { const a = wiseAt(s, f.mjd, i), d = sepArcsec(a, { ra, dec }); if (d < bd) { bd = d; best = a; } });
      const p = skyToPix(exView.field, best.ra, best.dec), sc = exView.toScreen(p.ix, p.iy), r = exView.rect();
      return { x: r.left + sc.x, y: r.top + sc.y, bd };
    }, [ra, dec]);
    await q.mouse.click(pt.x, pt.y);
    return { sep: pt.bd, text: await q.textContent("#popRows") };
  };
  const w855 = await open("#ra=133.795129&dec=-7.245147&size=300&band=SPHEREx-D6&wise=1&gaia=1");
  await w855.waitForFunction(() => ex.lists.stacks && ex.lists.stacks.finished && wise.data && gaia.data, null, { timeout: 400000 });
  await check("WISE: toggle, squares and label; WISE 0855 is matched with no Gaia star and flagged as a brown-dwarf candidate", async () => {
    assert((await w855.getAttribute("#wiseBtn", "aria-pressed")) === "true" && /wise=1/.test(await w855.evaluate(() => location.hash)));
    assert(/^CATWISE2020 · W2 < 17 · \d+ sources · \d+ brown-dwarf candidates? \(red\)/.test(await w855.textContent("#gaiaLabel .ln-wise")), await w855.textContent("#gaiaLabel"));
    await w855.locator(".fr").last().click();
    const r = await clickWise(w855, 133.759765, -7.242182);       // WISE 0855's 2026 position
    assert(r.sep < 6, "WISE source within 6″ of WISE 0855: " + r.sep);
    assert(/W1 − W2[\d.]+ · red/.test(r.text) && /Proper motion8\d{3} mas\/yr/.test(r.text), r.text);
    assert(/Gaia matchnone within 3″/.test(r.text) && /Brown-dwarf candidate/.test(r.text) && /No Gaia DR3 star/.test(r.text), r.text);
    await w855.click("#popClose");
    await w855.click("#wiseBtn"); assert(await w855.evaluate(() => !wise.on) && !/wise=1/.test(await w855.evaluate(() => location.hash)));
  });
  await close(w855);
  const eib = await open("#ra=331.096669&dec=-56.800649&size=300&band=SPHEREx-D6&wise=1&gaia=1");
  await eib.waitForFunction(() => ex.lists.stacks && ex.lists.stacks.finished && wise.data && gaia.data, null, { timeout: 400000 });
  await check("WISE: Epsilon Indi B is matched (red in WISE) and follows Gaia's motion – Gaia DR3 does detect it", async () => {
    await eib.locator(".fr").last().click();
    const r = await clickWise(eib, 331.096669, -56.800649);
    assert(r.sep < 9, "WISE source near Epsilon Indi B: " + r.sep);
    assert(/W1 − W21\.\d+ · red/.test(r.text) && /\(Gaia\)/.test(r.text) && /Gaia matchyes/.test(r.text) && /6412596012146801152/.test(r.text), r.text);
  });
  await close(eib);
  const wdown = await open(BARNARD_STACKS + "&wise=1", { setup: routeJSON("**/api/wise*", 502, { error: "WISE query at IRSA failed: busy" }) });
  await check("FAIL WISE unavailable: the label and the pop-up say so", async () => {
    await wdown.waitForFunction(() => /WISE · unavailable/.test(document.getElementById("gaiaLabel").textContent), null, { timeout: 60000 });
    await exploreReady(wdown);
    const sky = await wdown.locator("#exSky").boundingBox(); await wdown.mouse.click(sky.x + sky.width / 3, sky.y + sky.height / 3);
    assert(/WISE unavailable: IRSA is busy or not answering right now/.test(await wdown.textContent("#popRows")), await wdown.textContent("#popRows"));
  });
  await close(wdown);

  const u = await open(BARNARD_STACKS + "&mode=diff&ref=first");
  await exploreReady(u);
  await check("URL: mode=diff&ref=first is restored", async () => {
    assert((await u.getAttribute('[data-mode="diff"]', "aria-pressed")) === "true" && (await u.inputValue("#refSel")) === "first");
    await u.locator(".fr").last().click();
    assert(/^DIFF · SURVEY \d − SURVEY 1$/.test(await u.textContent("#modeLabel")), await u.textContent("#modeLabel"));
  });
  await close(u);

  // Noise: an uncrowded field (WISE 0855), where pixel-to-pixel scatter is mostly noise.
  const w = await open("#ra=133.795129&dec=-7.245147&size=600&band=SPHEREx-D3");
  await exploreReady(w);
  await check("STACK noise is clearly lower than in a single frame (WISE 0855 field)", async () => {
    const k = await w.evaluate(() => ex.frames.reduce((b, s, i) => (s.n > ex.frames[b].n ? i : b), 0));   // the biggest epoch
    await w.locator(".fr").nth(k).click();
    const st = await w.evaluate(() => ex.frames[ex.current].cut);
    await w.click('[data-view="frames"]');
    await w.waitForFunction(() => ex.lists.frames.finished, null, { timeout: 400000 });
    const one = await w.evaluate(() => ex.frames[ex.current].cut);
    const a = await pixelNoise(w, st), b = await pixelNoise(w, one);
    assert(a < 0.6 * b, `stack ${a.toFixed(4)} vs single ${b.toFixed(4)}`);
  });
  await close(w);

  const q = await open(BARNARD_STACKS, { setup: routeJSON("**/api/stack*", 502, { error: "IRSA busy" }) });
  await check("FAIL stacks unavailable: faded epochs and a plain message", async () => {
    await q.waitForFunction(() => ex.lists.stacks && ex.lists.stacks.finished, null, { timeout: 120000 });
    assert((await q.locator(".fr.bad").count()) === (await q.locator(".fr").count()));
    assert(/Could not load/.test(await q.textContent("#noObsTitle")) && await q.isVisible("#noObs"));
    await q.click('[data-view="frames"]');      // single frames still work
    assert(await q.isHidden("#noObs"));
  });
  await close(q);
}

// ================================================================== page 2: explore
async function page2() {
  const p = await open(BARNARD);
  await check("P2 a link with #ra=…&dec=… opens page 2 directly and shows loading", async () => {
    assert(await p.isVisible("#explore"));
    await p.waitForFunction(() => !document.getElementById("exLoading").hidden || (ex.lists.frames && ex.lists.frames.finished), null, { timeout: 30000 });
  });
  await exploreReady(p);

  await check("P2 date strip: one button per image, oldest first, current highlighted", async () => {
    const n = await p.evaluate(() => ex.frames.length);
    assert(n >= 10 && (await p.locator(".fr").count()) === n, "strip " + n);
    const mjds = await p.evaluate(() => ex.frames.map((f) => f.mjd));
    assert(mjds.every((m, i) => !i || m >= mjds[i - 1]), "not in time order");
    assert((await p.locator('.fr[aria-current="true"]').count()) === 1);
  });
  await check("P2 picture drawn; label shows date, wavelength and band; counter 1/N", async () => {
    assert((await litPixels(p, "#exSky canvas")) > 500);
    assert(/^\d{1,2} \w{3} 20\d\d · \d\d:\d\d UTC$/.test(await p.textContent("#shownDate")));
    assert(/^λ [12]\.\d{3} µm · D3 · (DR1|QR3) · 6\.15″\/px$/.test(await p.textContent("#chanShort")), await p.textContent("#chanShort"));
    assert(/^1\/\d+$/.test(await p.textContent("#frameNo")));
  });
  await check("P2 credit links to the original FITS file at IRSA", async () => {
    const url = await newTab(p, () => p.click("#exCredit a"));
    assert(url && /\.fits$/.test(url), String(url));
    assert(await p.isHidden("#pop"), "the link click also picked a position");
  });
  await check("P2 red dots mark exactly the images with quality flags at the target", async () => {
    const flagged = await p.evaluate(() => ex.frames.filter((f) => f.cut && f.cut.quality.length).length);
    assert((await p.locator(".fr .dotf:not([hidden])").count()) === flagged);
  });
  await check("P2 header has only Back; control bar has VIEW, counter, MODE and GAIA", async () => {
    assert((await p.locator(".extop").innerText()).trim() === "Back");
    const groups = await p.$$eval(".cbar .tgroup", (gs) => gs.map((g) => [g.querySelector(".glbl") ? g.querySelector(".glbl").textContent : g.getAttribute("aria-label"),
      [...g.querySelectorAll("button")].map((b) => b.textContent.trim() || b.getAttribute("aria-label")).join("/")].join(":")));
    assert(groups.join(" | ") === "VIEW:STACKS/FRAMES/LOCK | MODE:NORMAL/BLINK/DIFF | SHOW:GAIA/WISE/CURVE | Playback:Previous image/Play/Pause/Next image | SPEED:+/−", groups.join(" | "));
    assert((await p.locator("#regionInfo, #flagChip, #diffBtn, #fsBtn, #exZoom [data-zoom=reset]").count()) === 0);
  });
  await check("P2 clicking a date shows that image", async () => {
    await p.locator(".fr").nth(3).click();
    assert((await p.textContent("#frameNo")).startsWith("4/"));
    assert((await p.locator(".fr").nth(3).getAttribute("aria-current")) === "true");
  });
  await check("P2 Prev / Next step; messages at the first and last image", async () => {
    await p.click("#next"); assert((await p.textContent("#frameNo")).startsWith("5/"));
    await p.click("#prev"); assert((await p.textContent("#frameNo")).startsWith("4/"));
    // At the ends Prev / Next are marked unavailable (aria-disabled, drawn faded) but still answer
    // a click with a message, so click them as a user would (force skips Playwright's check).
    await p.locator(".fr").first().click();
    assert((await p.getAttribute("#prev", "aria-disabled")) === "true");
    await p.click("#prev", { force: true });
    assert(/first observation/.test(await p.textContent("#toast")));
    await p.locator(".fr").last().click();
    assert((await p.getAttribute("#next", "aria-disabled")) === "true");
    await p.click("#next", { force: true });
    assert(/last observation/.test(await p.textContent("#toast")));
  });
  await check("P2 Play runs at the chosen speed and stops with a message at the end", async () => {
    await p.locator(".fr").first().click();
    await p.selectOption("#speedSel", "5");                       // 3.0x = 167 ms per frame
    assert((await p.inputValue("#speedSel")) === "5");
    await p.click("#play"); assert((await p.getAttribute("#play", "aria-pressed")) === "true");
    await p.waitForTimeout(1100);
    const k = await p.evaluate(() => ex.current);
    assert(k >= 4 && k <= 9, "advanced " + k + " frames in 1.1 s at 3x");
    await p.waitForFunction(() => !ex.playing, null, { timeout: 60000 });
    assert(/Reached the last observation/.test(await p.textContent("#toast")));
    await p.click("#play"); await p.waitForTimeout(100);
    assert((await p.evaluate(() => ex.current)) <= 1, "Play at the end should start again");
    await p.click("#pause"); assert((await p.getAttribute("#play", "aria-pressed")) === "false");
  });
  await check("P2 speed + / − step through 0.25x … 3.0x and go into the link", async () => {
    await p.click("#slower"); assert((await p.inputValue("#speedSel")) === "4");
    for (let i = 0; i < 6; i++) await p.click("#slower");
    assert((await p.inputValue("#speedSel")) === "0");
    for (let i = 0; i < 2; i++) await p.click("#faster");
    assert((await p.inputValue("#speedSel")) === "2" && /speed=1(&|$)/.test(p.url()));
  });
  await check("P2 keys: → / ← step, Space plays and pauses", async () => {
    await p.locator(".fr").nth(2).click(); await p.locator("body").click({ position: { x: 5, y: 5 } });
    await p.keyboard.press("ArrowRight"); assert((await p.textContent("#frameNo")).startsWith("4/"));
    await p.keyboard.press("ArrowLeft"); assert((await p.textContent("#frameNo")).startsWith("3/"));
    await p.keyboard.press(" "); assert(await p.evaluate(() => ex.playing));
    await p.keyboard.press(" "); assert(!(await p.evaluate(() => ex.playing)));
  });
  await check("P2 BLINK alternates with the previous image and labels it", async () => {
    await p.locator(".fr").nth(5).click();
    await p.click('[data-mode="blink"]'); assert((await p.getAttribute('[data-mode="blink"]', "aria-pressed")) === "true");
    assert(/^BLINK · .+ ↔ .+ · NOW /.test(await p.textContent("#modeLabel")));
    const seen = new Set(); for (let i = 0; i < 10; i++) { seen.add(await p.textContent("#frameNo")); await p.waitForTimeout(120); }
    assert(seen.has("5/" + (await p.evaluate(() => ex.frames.length))) && seen.size === 2, [...seen].join());
    await p.click('[data-mode="normal"]'); assert(await p.isHidden("#modeLabel"));
  });
  // Colourful pixels in the picture: a difference image is drawn in yellow / blue, a normal one in grays.
  const colourful = (p) => p.$eval("#exSky canvas", (c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[i + 2]) > 40) n++;
    return n;
  });
  await check("P2 DIFF shows current − previous in colour, with a legend and the VS choice", async () => {
    await p.locator(".fr").nth(5).click();
    assert(await p.isHidden("#refSel"), "VS only appears in Blink / Diff");
    await p.click('[data-mode="diff"]');
    assert(/^DIFF · .+ − .+/.test(await p.textContent("#modeLabel")), await p.textContent("#modeLabel"));
    assert(await p.isVisible("#diffLegend") && /5σ/.test(await p.textContent("#diffScale")));
    assert(await p.isVisible("#refSel") && (await p.inputValue("#refSel")) === "prev");
    assert((await colourful(p)) > 1000, "colour");
    assert(/mode=diff/.test(await p.evaluate(() => location.hash)));
  });
  await check("P2 DIFF reference: first image, a chosen image, and 'this is the reference'", async () => {
    await p.selectOption("#refSel", "first");
    const first = await p.evaluate(() => itemName(ex.frames[0]).toUpperCase());
    assert((await p.textContent("#modeLabel")).endsWith("− " + first), await p.textContent("#modeLabel"));
    assert(/ref=first/.test(await p.evaluate(() => location.hash)));
    await p.selectOption("#refSel", "2");
    assert(await p.evaluate(() => refIndex() === 2));
    await p.locator(".fr").nth(2).click();
    assert(/THIS IS THE REFERENCE/.test(await p.textContent("#modeLabel")) && await p.isHidden("#diffLegend"));
    await p.locator(".fr").nth(5).click();
  });
  await check("P2 DIFF pop-up shows the change at the clicked point", async () => {
    const sky = await p.locator("#exSky").boundingBox(); await p.mouse.click(sky.x + sky.width / 2, sky.y + sky.height / 2);
    assert(/Change vs \d{1,2} \w{3} 20\d\d(no data|[+-][\d.e-]+ MJy\/sr · [+-]\d+\.\dσ)/.test(await p.textContent("#popRows")), await p.textContent("#popRows"));
    await p.click("#popClose");
    await p.selectOption("#refSel", "prev");
    await p.click('[data-mode="normal"]');
    assert(await p.isHidden("#diffLegend") && await p.isHidden("#refSel") && (await colourful(p)) < 50);
  });
  await check("P2 zoom in / out on the image", async () => {
    await p.click('#exZoom [data-zoom="in"]'); assert((await p.evaluate(() => exView.z)) === 1.5);
    await p.click('#exZoom [data-zoom="out"]'); assert((await p.evaluate(() => exView.z)) === 1);
  });

  // ---- GAIA
  await check("P2 GAIA: rings drawn, label counts stars, link remembers it", async () => {
    await p.click("#gaiaBtn");
    await p.waitForFunction(() => /stars/.test(document.getElementById("gaiaLabel").textContent), null, { timeout: 60000 });
    assert(/^GAIA DR3 · G < 19 · \d+ stars · at .+ · arrows: 10-yr motion$/.test(await p.textContent("#gaiaLabel .ln-gaia .lg")), await p.textContent("#gaiaLabel"));
    assert(/^GAIA · \d+ stars$/.test(await p.textContent("#gaiaLabel .ln-gaia .sh")));
    const blue = await p.$eval("#gaiaCanvas", (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 120 && d[i + 3] > 0) n++; return n; });
    assert(blue > 200, "no rings drawn");
    assert(/gaia=1/.test(p.url()));
  });
  await check("P2 GAIA: Barnard's Star's ring moves north with the date (proper motion)", async () => {
    const pos = () => p.evaluate(() => { const st = gaia.data.stars.find((s) => s[0] === "4472832130942575872");
      const f = ex.frames[ex.current], a = gaiaAt(st, f.mjd), q = skyToPix(exView.field, a.ra, a.dec); return q.iy; });
    await p.locator(".fr").first().click(); const y0 = await pos();
    await p.locator(".fr").last().click(); const y1 = await pos();
    assert(y0 - y1 > 1.3 && y0 - y1 < 2.1, `moved ${(y0 - y1).toFixed(2)} px north (expect ~1.7)`);
  });
  await check("P2 About pop-up on Barnard's Star: SPHEREx values and the Gaia match", async () => {
    const pt = await p.evaluate(() => { const st = gaia.data.stars.find((s) => s[0] === "4472832130942575872"), f = ex.frames[ex.current];
      const a = gaiaAt(st, f.mjd), q = skyToPix(exView.field, a.ra, a.dec), s = exView.toScreen(q.ix, q.iy), r = exView.rect(); return { x: r.left + s.x, y: r.top + s.y }; });
    await p.mouse.click(pt.x, pt.y);
    const t = await p.locator("#popRows").innerText();
    for (const k of ["RA", "DEC", "BRIGHTNESS", "OBSERVED", "WAVELENGTH", "BAND", "FROM TARGET", "SOURCE FILE", "GAIA DR3 SOURCE", "PARALLAX", "PROPER MOTION"])
      assert(t.includes(k), "missing row " + k);
    assert(t.includes("4472832130942575872") && /546\.98 ± 0\.04 mas/.test(t) && /1\.8 pc/.test(t), "Gaia values");
    assert(await p.isVisible(".selring"));
  });
  await check("P2 About pop-up stays inside the image area; its FITS link opens", async () => {
    const pop = await p.locator("#pop").boundingBox(), sky = await p.locator("#exSky").boundingBox();
    assert(pop.y >= sky.y - 1 && pop.y + pop.height <= sky.y + sky.height + 1 && pop.x >= sky.x - 1 && pop.x + pop.width <= sky.x + sky.width + 1);
    const url = await newTab(p, () => p.click("#popRows a")); assert(url && /\.fits$/.test(url));
    assert(await p.isVisible("#pop"), "pop-up closed by its own link");
  });
  await check("P2 About pop-up: empty sky says there is no Gaia star; × and Esc close it", async () => {
    await p.click("#popClose"); assert(await p.isHidden("#pop"));
    const sky = await p.locator("#exSky").boundingBox();
    const spot = await p.evaluate(() => {   // a point at least 15″ from every Gaia star
      const f = ex.frames[ex.current], r = exView.rect();
      for (let y = 60; y < r.height - 60; y += 9) for (let x = 60; x < r.width - 60; x += 9) {
        const q = exView.toImage(x, y), c = pixToSky(exView.field, q.ix, q.iy), cd = Math.cos(c.dec * Math.PI / 180);
        if (gaia.data.stars.every((s) => { const a = gaiaAt(s, f.mjd); return Math.hypot((a.ra - c.ra) * cd, a.dec - c.dec) * 3600 > 15; })) return { x, y };
      } return null; });
    assert(spot, "no empty spot found");
    await p.mouse.click(sky.x + spot.x, sky.y + spot.y);
    assert(/No Gaia DR3 star brighter than G 19 within 6\.2″/.test(await p.textContent("#popRows")));
    await p.keyboard.press("Escape"); assert(await p.isHidden("#pop"));
  });
  await check("P2 GAIA off hides the rings and its label", async () => {
    await p.click("#gaiaBtn"); assert(await p.isHidden("#gaiaLabel") && !/gaia=1/.test(p.url()));
  });
  await check("P2 Back returns to page 1 with the searched position selected", async () => {
    await p.click("#back"); await previewReady(p);
    assert(await p.isVisible("#pick") && (await p.inputValue("#ra")) === "269.44626");
    assert((await p.textContent("#pvName")) === "Barnard's Star");
    assert(!/ra=/.test(new URL(p.url()).hash), "hash kept after Back");
  });
  if (p.errors.length) await check("P2 no script errors", async () => assert(false, p.errors.join(" | ")));
  await close(p);

  const big = await open("#ra=269.446259&dec=4.768324&size=1800&band=SPHEREx-D3");
  await check("URL: size=1800 restores a 30′ field and loads it", async () => {
    await exploreReady(big);
    const s = await big.evaluate(() => ({ h: ex.h, w: ex.w, nx: exView.field.nx, ny: exView.field.ny, slider: $("size").value, loaded: ex.frames.filter((f) => f.cut).length, n: ex.frames.length }));
    assert(s.h === 1800 && s.w === 1800 && s.nx === 293 && s.ny === 293 && s.slider === "30" && s.loaded >= 2 && s.loaded === s.n, JSON.stringify(s));
    assert(/size=1800/.test(big.url()));
  });
  await close(big);

  const q = await open("#ra=269.446259&dec=4.768324&size=240&band=SPHEREx-D5&speed=250&gaia=1");
  await check("URL: band, size, old millisecond speed and gaia=1 are restored", async () => {
    await q.waitForFunction(() => ex.frames.length, null, { timeout: 120000 });
    const s = await q.evaluate(() => ({ band: ex.band, h: ex.h, speed: ex.speedIdx, gaia: gaia.on }));
    assert(s.band === "SPHEREx-D5" && s.h === 240 && s.speed === 4 && s.gaia === true, JSON.stringify(s));   // 250 ms = 2.0x
  });
  await close(q);
}

// ================================================================== Task 6: toolbar, metadata, guide, shared links
async function ux() {
  const p = await open(BARNARD_STACKS);
  await exploreReady(p);
  await check("UX every toolbar control has a label, a tooltip and is reachable by keyboard", async () => {
    const bad = await p.$$eval(".cbar button, .cbar select", (els) => els.filter((e) => !e.hidden).filter((e) =>
      !(e.getAttribute("aria-label") || e.textContent.trim() || (e.id && document.querySelector(`label[for="${e.id}"]`))) ||
      !(e.title || e.closest("[title]")) || e.tabIndex < 0).map((e) => e.id || e.textContent));
    assert(!bad.length, "missing label/tooltip: " + bad.join());
  });
  await check("UX metadata panel: epoch dates, frames, wavelength range, release and plain-language flags with descriptions", async () => {
    assert(/^Survey 1 · /.test(await p.textContent("#shownDate")));
    assert(/^λ \d\.\d\d–\d\.\d\d µm · \d+ frames stacked · D3 · (DR1|QR3)/.test(await p.textContent("#chanShort")), await p.textContent("#chanShort"));
    const flags = await p.textContent("#metaFlags");
    if (/No quality flags/.test(flags)) return;
    const chip = p.locator("#metaFlags .qf").first();
    assert(!/[A-Z_]{4,}/.test(await chip.textContent()), "plain words, not FITS names: " + await chip.textContent());
    assert(/^[A-Z_]+: /.test(await chip.getAttribute("title")) && (await chip.getAttribute("tabindex")) === "0");
  });
  await check("UX a shared link restores the exact state (view, item, mode, reference, overlays, lock, curve, zoom)", async () => {
    await p.click('[data-view="frames"]'); await p.waitForFunction(() => ex.lists.frames.finished, null, { timeout: 400000 });
    await p.locator(".fr").nth(6).click();
    await p.click('[data-mode="diff"]'); await p.selectOption("#refSel", "2");
    await p.click("#gaiaBtn"); await p.click("#wiseBtn"); await p.click("#lockBtn");
    if ((await p.getAttribute("#curveBtn", "aria-pressed")) !== "true") await p.click("#curveBtn");
    await p.click('#exZoom [data-zoom="in"]'); await p.click('#exZoom [data-zoom="in"]');
    await p.waitForTimeout(500);
    const url = p.url(), state = () => ({ view: ex.view, i: ex.current, mode: ex.mode, ref: ex.ref, gaia: gaia.on, wise: wise.on,
      lock: ex.lock[ex.view], curve: ex.curve, z: +exView.z.toFixed(2), size: ex.h, band: ex.band });
    const before = await p.evaluate(state);
    assert(/view=frames/.test(url) && /i=6/.test(url) && /mode=diff/.test(url) && /ref=2/.test(url) && /z=2\.25/.test(url) && /at=/.test(url), url);
    const q = await open(url.slice(url.indexOf("#")));
    await exploreReady(q); await q.waitForTimeout(500);
    const after = await q.evaluate(state);
    assert(JSON.stringify(after) === JSON.stringify(before), JSON.stringify(before) + " vs " + JSON.stringify(after));
    const centre = (x) => x.evaluate(() => { const r = exView.rect(), c = exView.toImage(r.width / 2, r.height / 2); return [c.ix, c.iy]; });
    const [a, b] = [await centre(p), await centre(q)];
    assert(Math.abs(a[0] - b[0]) < 0.6 && Math.abs(a[1] - b[1]) < 0.6, `view centre ${a} vs ${b}`);
    await close(q);
  });
  await close(p);

  const hp = await open("", { viewport: { width: 1366, height: 768 } });
  await check("HELP the i button on page 1 opens one screen explaining every field; Esc closes it", async () => {
    assert(await hp.evaluate(() => [...document.querySelectorAll(".infobtn")].every((b) => b.classList.contains("attn"))), "pulses before first use");
    await hp.click('[data-help="helpPick"]');
    assert(await hp.evaluate(() => ![...document.querySelectorAll(".infobtn")].some((b) => b.classList.contains("attn"))), "stops after first use");
    const d = hp.locator("#helpPick");
    assert(await d.isVisible());
    const t = await d.textContent();
    for (const w of ["Right Ascension", "Declination", "Field height", "Band", "Search", "Presets", "Releases"]) assert(t.includes(w), "missing " + w);
    assert(await d.evaluate((x) => x.scrollHeight <= x.clientHeight), "should fit one screen at 1366×768");
    await hp.keyboard.press("Escape"); assert(await d.isHidden());
  });
  await hp.goto("about:blank"); await hp.goto(BASE + "/" + BARNARD_STACKS);
  await check("HELP the i button next to Back explains every control; × closes it; keys don't reach the player", async () => {
    await hp.click('[data-help="helpExplore"]');
    const d = hp.locator("#helpExplore"), t = await d.textContent();
    for (const w of ["Stacks", "Frames", "Lock", "Normal", "Blink", "Diff", "VS", "Gaia", "WISE", "Curve", "W1 − W2", "parallax", "proper motion", "Speed"]) assert(t.includes(w), "missing " + w);
    assert(await d.evaluate((x) => x.scrollHeight <= x.clientHeight), "should fit one screen at 1366×768");
    const n0 = await hp.textContent("#frameNo");
    await hp.keyboard.press("ArrowRight"); assert((await hp.textContent("#frameNo")) === n0);
    await hp.click("#helpExplore [data-close]"); assert(await d.isHidden());
  });
  await close(hp);

  const h = await open();
  await check("UX first-time guide: shown once, dismissible, stays dismissed", async () => {
    assert(await h.isVisible("#firstHint") && /Pick a target → Search → press Play or Diff/.test(await h.textContent("#firstHint")));
    await h.click("#firstHintClose"); assert(await h.isHidden("#firstHint"));
    await h.reload(); await h.waitForTimeout(300);
    assert(await h.isHidden("#firstHint"), "came back after a reload");
  });
  await close(h);
}

// ================================================================== failures (simulated)
async function failures() {

  let p = await open(BARNARD, { setup: routeJSON("**/api/frames*", 502, { error: "IRSA SIA query failed: busy" }) });
  await check("FAIL IRSA search down: page 2 explains and offers Back", async () => {
    await p.waitForSelector("#noObs:not([hidden])", { timeout: 20000 });
    assert(/Could not search IRSA/.test(await p.textContent("#noObsTitle")));
    assert(/busy or not answering right now\. Please try again/.test(await p.textContent("#noObsText")), await p.textContent("#noObsText"));
  });
  await close(p);

  p = await open(BARNARD, { setup: routeJSON("**/api/frames*", 200, { frames: [] }) });
  await check("FAIL no observations: page 2 says none were found", async () => {
    await p.waitForSelector("#noObs:not([hidden])", { timeout: 20000 });
    assert(/No SPHEREx observations found/.test(await p.textContent("#noObsTitle")));
    await p.keyboard.press("ArrowRight"); assert(await p.isHidden("#toast"), "no step message with no frames");
  });
  await close(p);

  p = await open("", { setup: routeJSON("**/api/frames*", 502, { error: "busy" }) });
  await check("FAIL preview can't load: page 1 explains, the rest still works", async () => {
    await p.fill("#ra", "269.44626"); await p.fill("#dec", "+4.76832"); await p.press("#dec", "Tab");
    await p.waitForFunction(() => /Could not load/.test(document.getElementById("pvLoadingText").textContent), null, { timeout: 20000 });
    assert((await p.locator(".pr").count()) === 5);
  });
  await close(p);

  // Frames 2 and 3 fail (both download tries): faded dates, a message, and playback skips them.
  p = await open(BARNARD, { setup: async (page) => {
    let urls = null;
    await page.route("**/api/frames*", async (r) => { const res = await r.fetch(); const j = await res.json(); urls = new Set(j.frames.slice(1, 3).map((f) => f.url)); await r.fulfill({ response: res, json: j }); });
    await page.route("**/api/cutouts*", async (r) => {
      const asked = JSON.parse(r.request().postData()).urls, res = await r.fetch();
      const body = (await res.text()).split("\n").filter(Boolean).map((l) => { const m = JSON.parse(l); return urls.has(asked[m.i]) ? JSON.stringify({ i: m.i, error: "simulated" }) : l; }).join("\n") + "\n";
      await r.fulfill({ status: 200, contentType: "application/x-ndjson", body });
    });
  } });
  await exploreReady(p);
  await check("FAIL failed images: faded dates, a message, and Next / BLINK skip them", async () => {
    assert((await p.locator(".fr.bad").count()) === 2, "faded dates");
    await p.locator(".fr").nth(1).click(); assert(/could not be loaded/.test(await p.textContent("#toast")));
    await p.locator(".fr").first().click(); await p.click("#next");
    assert((await p.textContent("#frameNo")).startsWith("4/"), "Next should skip 2 and 3");
    await p.click('[data-mode="blink"]'); assert(/1 SKIPPED|2 NOT LOADED, SKIPPED/.test(await p.textContent("#modeLabel")), await p.textContent("#modeLabel"));
    await p.click('[data-mode="normal"]');
  });
  await close(p);

  p = await open(BARNARD + "&gaia=1", { setup: routeJSON("**/api/gaia*", 502, { error: "Gaia query at MAST failed: busy" }) });
  await exploreReady(p);
  await check("FAIL Gaia unavailable: the label and the pop-up say so", async () => {
    await p.waitForFunction(() => /unavailable/.test(document.getElementById("gaiaLabel").textContent), null, { timeout: 20000 });
    const sky = await p.locator("#exSky").boundingBox(); await p.mouse.click(sky.x + sky.width / 2, sky.y + sky.height / 2);
    assert(/Gaia unavailable: MAST is busy or not answering/.test(await p.textContent("#popRows")));
  });
  await close(p);
}

// ================================================================== layout
// Both pages must fit the screen with no page scrolling at the four required sizes (only the
// date strip, the preset row on phones and the pop-up may scroll inside themselves).
async function layout() {
  const sizes = [["1366×768", { viewport: { width: 1366, height: 768 } }], ["1440×900", { viewport: { width: 1440, height: 900 } }],
                 ["1920×1080", { viewport: { width: 1920, height: 1080 } }], ["390×844 phone", { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } }]];
  const overflow = (p) => p.evaluate(() => ({ v: document.documentElement.scrollHeight - innerHeight, h: document.documentElement.scrollWidth - innerWidth,
    side: document.querySelector(".side").scrollHeight - document.querySelector(".side").clientHeight }));
  for (const [name, opts] of sizes) {
    const p = await open("", opts);
    await check(`LAYOUT ${name}: page 1 fits (no page or sidebar scrolling)`, async () => {
      const m = await overflow(p); assert(m.v <= 0 && m.h <= 0 && m.side <= 1, JSON.stringify(m));
    });
    await check(`LAYOUT ${name}: page 1 guide doesn't cover the form, presets or zoom buttons`, async () => {
      assert(await p.isVisible("#firstHint"));
      const hits = await p.evaluate(() => {
        const g = document.getElementById("firstHint").getBoundingClientRect();
        return [...document.querySelectorAll("#pick button, #pick input, #pick select, #pick .lblt")].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width && g.left < r.right && r.left < g.right && g.top < r.bottom && r.top < g.bottom;
        }).map((e) => e.id || e.className || e.textContent);
      });
      assert(!hits.length, hits.join());
    });
    await pickBarnard(p);
    await check(`LAYOUT ${name}: page 1 with a picture fits too`, async () => {
      const m = await overflow(p); assert(m.v <= 0 && m.h <= 0 && m.side <= 1, JSON.stringify(m));
    });
    await check(`LAYOUT ${name}: Search works`, async () => { await search(p); assert(await p.isVisible("#explore")); });
    await exploreReady(p);
    await check(`LAYOUT ${name}: page 2 fits (no page scrolling)`, async () => {
      const m = await overflow(p); assert(m.v <= 0 && m.h <= 0, JSON.stringify(m));
    });
    await check(`LAYOUT ${name}: with every layer on, no labels, panels or controls overlap`, async () => {
      for (const sel of ["#gaiaBtn", "#wiseBtn", '[data-mode="diff"]']) await p.click(sel);
      if ((await p.getAttribute("#curveBtn", "aria-pressed")) !== "true") await p.click("#curveBtn");
      await p.locator(".fr").last().click();
      await p.waitForFunction(() => wise.data || wise.error, null, { timeout: 120000 });
      await p.waitForTimeout(300);
      const hits = await p.evaluate(() => {
        const sels = ["#meta", "#modeLabel", "#gaiaLabel", "#exCredit", "#curve", "#diffLegend", "#exZoom", ".cbar", "#strip", "#firstHint", "#back"];
        // (getClientRects: also counts the fixed-position guide, which has no offsetParent)
        const boxes = sels.map((s) => [s, document.querySelector(s)]).filter(([, e]) => e && !e.hidden && e.getClientRects().length && getComputedStyle(e).display !== "none")
          .map(([s, e]) => [s, e.getBoundingClientRect()]);
        const out = [];
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const [a, A] = boxes[i], [b, B] = boxes[j];
          if (A.left < B.right - 1 && B.left < A.right - 1 && A.top < B.bottom - 1 && B.top < A.bottom - 1) out.push(`${a} × ${b}`);
        }
        return out;
      });
      assert(!hits.length, hits.join(", "));
      const m = await overflow(p); assert(m.v <= 0 && m.h <= 0, JSON.stringify(m));
    });
    await close(p);
  }
}

// ================================================================== run
browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const t0 = Date.now();
for (const part of [page1, page2, stacks, ux, failures, layout]) {
  try { await part(); } catch (e) { results.push([false, `${part.name} crashed: ${e.message}`]); console.log("FAIL", part.name, "crashed:", e.message); }
}
await browser.close();
const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const [, name] of failed) console.log("  failed:", name);
process.exit(failed.length);
