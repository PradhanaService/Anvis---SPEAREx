"use strict";

const MAX_FRAMES = 300;   // if more images exist, show this many spread evenly in time
const PARALLEL = 4;       // simultaneous cutout requests

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
    `${wl}${wl ? " · " : ""}${f.obs_id} · ${f.collection}`;

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

  const img = new ImageData(w, h);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    let g;
    if (v === null) { img.data.set([150, 120, 120, 255], i * 4); continue; } // no data
    g = Math.round(255 * Math.min(1, Math.max(0, (v - lo) / (hi - lo))));
    if (invert) g = 255 - g;
    img.data.set([g, g, g, 255], i * 4);
  }
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  off.getContext("2d").putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
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
