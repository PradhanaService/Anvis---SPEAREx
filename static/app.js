"use strict";

const MAX_FRAMES = 300;   // if more images exist, show this many spread evenly in time
const PARALLEL = 6;       // simultaneous cutout requests

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");

let frames = [];      // {obs_id, date, mjd, collection, url, cut: null|object, failed: bool}
let current = 0;
let timer = null;
let searchId = 0;     // increments on every search so stale requests are ignored

// ---------- coordinate parsing (decimal degrees or sexagesimal) ----------
function parseSexagesimal(s) {
  const parts = s.trim().replace(/[hdms°'"]/g, " ").split(/[\s:]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return NaN;
  const sign = parts[0].trim().startsWith("-") ? -1 : 1;
  const [a, b, c = 0] = parts.map((p) => Math.abs(parseFloat(p)));
  return sign * (a + b / 60 + c / 3600);
}
function parseRA(s) {
  if (/^[+-]?\d+(\.\d+)?$/.test(s.trim())) return parseFloat(s);
  return parseSexagesimal(s) * 15;   // hours -> degrees
}
function parseDec(s) {
  if (/^[+-]?\d+(\.\d+)?$/.test(s.trim())) return parseFloat(s);
  return parseSexagesimal(s);
}

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").className = isError ? "error" : "";
}

// ---------- search ----------
async function search() {
  stop();
  const ra = parseRA($("ra").value);
  const dec = parseDec($("dec").value);
  const size = Number($("size").value);
  const band = $("band").value;
  if (!(ra >= 0 && ra < 360) || !(dec >= -90 && dec <= 90)) {
    setStatus("Please enter a valid RA (0–360° or hh:mm:ss) and Dec (−90…+90° or ±dd:mm:ss).", true);
    return;
  }
  if (!(size >= 30 && size <= 600)) {
    setStatus("Size must be between 30 and 600 arcsec.", true);
    return;
  }
  writeHash();
  const id = ++searchId;
  frames = [];
  current = 0;
  $("viewer").hidden = true;
  setStatus("Searching IRSA for SPHEREx images…");

  let list;
  try {
    const r = await fetch(`api/frames?ra=${ra}&dec=${dec}&band=${encodeURIComponent(band)}`);
    list = await r.json();
    if (!r.ok) throw new Error(list.error || r.statusText);
  } catch (e) {
    if (id === searchId) setStatus("Search failed: " + e.message, true);
    return;
  }
  if (id !== searchId) return;

  let all = list.frames;
  if (all.length === 0) {
    setStatus(`No SPHEREx ${band} images cover this position yet.`);
    return;
  }
  let note = "";
  if (all.length > MAX_FRAMES) {
    const step = all.length / MAX_FRAMES;
    all = Array.from({ length: MAX_FRAMES }, (_, i) => all[Math.floor(i * step)]);
    note = ` (showing ${MAX_FRAMES} of ${list.frames.length}, spread evenly in time)`;
  }
  frames = all.map((f) => ({ ...f, cut: null, failed: false }));
  $("slider").max = frames.length - 1;
  $("slider").value = 0;
  $("viewer").hidden = false;
  render();

  // Download cutouts in time order, a few at a time; give failed ones one more try at the end.
  let queue = frames.slice(), done = 0, failed = 0, finished = false;
  const progress = () => setStatus(
    `Found ${list.frames.length} images${note}. Loaded ${done} of ${frames.length}` +
    (failed ? `, ${failed} failed` : "") + (finished ? "." : "…"));
  progress();
  async function worker() {
    while (queue.length && id === searchId) {
      const f = queue.shift();
      try {
        const r = await fetch(`api/cutout?ra=${ra}&dec=${dec}&size=${size}&url=${encodeURIComponent(f.url)}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
        f.cut = j;
        if (f.failed) { f.failed = false; failed--; }
        done++;
      } catch (e) {
        if (!f.failed) { f.failed = true; failed++; }
      }
      if (id !== searchId) return;
      progress();
      if (frames[current] === f) render();
    }
  }
  for (let pass = 0; pass < 2 && id === searchId; pass++) {
    if (pass === 1) queue = frames.filter((f) => f.failed);
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }
  finished = true;
  if (id === searchId) progress();
  if (id === searchId && !frames[current].cut) {
    const first = frames.findIndex((f) => f.cut);
    if (first >= 0) show(first);
  }
}

// ---------- drawing ----------
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

function render() {
  const f = frames[current];
  const zoom = Number($("zoom").value);
  canvas.style.width = zoom + "px";
  $("slider").value = current;
  if (!f) return;

  const where = `${current + 1} / ${frames.length}`;
  const wl = f.cut && f.cut.wavelength_um ? `λ ≈ ${f.cut.wavelength_um.toFixed(3)} µm` : "";
  $("info").innerHTML =
    `Frame ${where} · ${f.date} UTC · MJD ${f.mjd.toFixed(4)}<br>` +
    `${wl}${wl ? " · " : ""}${f.obs_id} · ${f.collection}<br>` +
    `<a href="${encodeURI(f.url)}" target="_blank" rel="noopener">Original image file at IRSA (FITS)</a>`;

  if (!f.cut) {
    ctx.fillStyle = "#888";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "20px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(f.failed ? "Could not load this frame" : "Loading…", canvas.width / 2, canvas.height / 2);
    return;
  }

  const { width: w, height: h, data } = f.cut;
  const finite = data.filter((v) => v !== null).sort((a, b) => a - b);
  const lo = percentile(finite, Number($("minb").value));
  let hi = percentile(finite, Number($("maxb").value));
  if (hi <= lo) hi = lo + 1e-6;
  const invert = $("invert").checked;

  // Draw at the canvas's real on-screen resolution so the picture stays sharp.
  const S = Math.min(1024, Math.round(zoom * (window.devicePixelRatio || 1)));
  if (canvas.width !== S) { canvas.width = S; canvas.height = S; }
  ctx.putImageData(drawFrame(w, h, data, lo, hi, invert, S), 0, 0);
}

// Display stretch: an asinh curve between the min and max brightness levels. Compared with a
// straight line it lifts faint structure out of the background without saturating bright cores.
const STRETCH = 8;
const STRETCH_NORM = Math.asinh(STRETCH);

// Catmull-Rom (bicubic) weights for a sample at fraction t between pixels 0 and 1.
function cubicWeights(t) {
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}

// For each output position along one axis: the 4 source indices and their weights.
function cubicTaps(n, S) {
  const idx = new Int32Array(S * 4), wts = new Float32Array(S * 4);
  for (let o = 0; o < S; o++) {
    const u = ((o + 0.5) * n) / S - 0.5;
    const i0 = Math.floor(u);
    const wt = cubicWeights(u - i0);
    for (let k = 0; k < 4; k++) {
      idx[o * 4 + k] = Math.min(n - 1, Math.max(0, i0 - 1 + k));
      wts[o * 4 + k] = wt[k];
    }
  }
  return { idx, wts };
}

// Smoothly upsample the w x h frame to S x S (bicubic), then apply the display stretch.
function drawFrame(w, h, data, lo, hi, invert, S) {
  // Pixels with no data take the value of their nearest valid neighbour, so they don't
  // smear dark rings into the interpolation; they are still drawn as "no data" below.
  const vals = new Float32Array(w * h);
  const valid = data.map((v) => v !== null);
  for (let i = 0; i < data.length; i++) vals[i] = valid[i] ? data[i] : lo;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (valid[i]) continue;
      const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].find(
        ([a, b]) => a >= 0 && b >= 0 && a < w && b < h && valid[b * w + a]);
      if (nb) vals[i] = vals[nb[1] * w + nb[0]];
    }
  }

  // Separable bicubic: rows first (h x S), then columns (S x S).
  const tx = cubicTaps(w, S), ty = cubicTaps(h, S);
  const rows = new Float32Array(h * S);
  for (let y = 0; y < h; y++) for (let o = 0; o < S; o++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += vals[y * w + tx.idx[o * 4 + k]] * tx.wts[o * 4 + k];
    // Keep within the two nearest pixels' values: no bright/dark halos around stars.
    const a = vals[y * w + tx.idx[o * 4 + 1]], b = vals[y * w + tx.idx[o * 4 + 2]];
    rows[y * S + o] = Math.min(Math.max(s, Math.min(a, b)), Math.max(a, b));
  }

  const img = new ImageData(S, S);
  const range = hi - lo;
  for (let oy = 0; oy < S; oy++) {
    const y1 = ty.idx[oy * 4 + 1], y2 = ty.idx[oy * 4 + 2];
    const fy = Math.min(1, Math.max(0, ((oy + 0.5) * h) / S - 0.5 - y1));
    for (let ox = 0; ox < S; ox++) {
      const p = (oy * S + ox) * 4;
      // No-data areas: threshold a bilinear blend of the valid-pixel mask, for rounded edges.
      const x1 = tx.idx[ox * 4 + 1], x2 = tx.idx[ox * 4 + 2];
      const fx = Math.min(1, Math.max(0, ((ox + 0.5) * w) / S - 0.5 - x1));
      const cover = (valid[y1 * w + x1] * (1 - fx) + valid[y1 * w + x2] * fx) * (1 - fy) +
                    (valid[y2 * w + x1] * (1 - fx) + valid[y2 * w + x2] * fx) * fy;
      if (cover < 0.5) { img.data[p] = 150; img.data[p + 1] = 120; img.data[p + 2] = 120; img.data[p + 3] = 255; continue; } // no data
      let v = 0;
      for (let k = 0; k < 4; k++) v += rows[ty.idx[oy * 4 + k] * S + ox] * ty.wts[oy * 4 + k];
      const a = rows[y1 * S + ox], b = rows[y2 * S + ox];
      v = Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
      const t = Math.min(1, Math.max(0, (v - lo) / range));
      let g = Math.round((255 * Math.asinh(STRETCH * t)) / STRETCH_NORM);
      if (invert) g = 255 - g;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = g;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

// ---------- player ----------
function show(i) {
  if (!frames.length) return;
  current = (i + frames.length) % frames.length;
  render();
}
function step(dir) {
  // Skip frames that failed to load.
  for (let k = 1; k <= frames.length; k++) {
    const i = (current + dir * k + frames.length * k) % frames.length;
    if (!frames[i].failed) return show(i);
  }
}
function play() {
  stop();
  $("play").textContent = "Pause";
  const tick = () => {
    step(1);
    timer = setTimeout(tick, Math.max(50, Number($("speed").value) || 500));
  };
  timer = setTimeout(tick, Math.max(50, Number($("speed").value) || 500));
}
function stop() {
  clearTimeout(timer);
  timer = null;
  $("play").textContent = "Play";
}

// ---------- shareable URL (like WiseView's #ra=...&dec=...) ----------
const HASH_FIELDS = ["ra", "dec", "size", "band", "speed", "minb", "maxb", "zoom"];
function writeHash() {
  const p = new URLSearchParams();
  HASH_FIELDS.forEach((k) => p.set(k, $(k).value.trim()));
  p.set("invert", $("invert").checked ? 1 : 0);
  history.replaceState(null, "", "#" + p.toString());
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  HASH_FIELDS.forEach((k) => { if (p.has(k)) $(k).value = p.get(k); });
  if (p.has("invert")) $("invert").checked = p.get("invert") === "1";
  return p.has("ra") && p.has("dec");
}

// ---------- events ----------
$("search").addEventListener("submit", (e) => { e.preventDefault(); search(); });
$("prev").addEventListener("click", () => { stop(); step(-1); });
$("next").addEventListener("click", () => { stop(); step(1); });
$("play").addEventListener("click", () => (timer ? stop() : play()));
$("slider").addEventListener("input", (e) => { stop(); show(Number(e.target.value)); });
["minb", "maxb", "invert", "zoom"].forEach((id) =>
  $(id).addEventListener("input", () => { render(); writeHash(); }));
$("speed").addEventListener("change", () => { writeHash(); if (timer) play(); });
document.addEventListener("keydown", (e) => {
  if ($("viewer").hidden || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === "ArrowLeft") { stop(); step(-1); }
  else if (e.key === "ArrowRight") { stop(); step(1); }
  else if (e.key === " ") { e.preventDefault(); timer ? stop() : play(); }
});

if (readHash()) search();
