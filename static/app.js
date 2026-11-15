"use strict";

// ======================================================================
// Anvis – SPHEREx Sky Explorer (frontend).
// 01 PICK: pick a position on a real SPHEREx image (or type it, or use a preset).
// 02 EXPLORE: every SPHEREx image of that position in time order, with blink and difference.
// All pixels come from IRSA through this app's backend (/api/frames, /api/cutout, /api/cutouts).
// ======================================================================

const MAX_FRAMES = 300;          // if more images exist, show this many spread evenly in time
const MAX_WIDTH = 1800;           // arcsec: widest field the backend serves (30')
const PREVIEW_W = 1800;          // 01 PICK preview width, arcsec (30'); height follows the viewer's shape
const BASE_FRAME_MS = 500;       // 1.0x playback speed
const BLINK_MS = 450;
const DISPLAY = { minb: 1, maxb: 99.5, invert: false };   // brightness limits (percentiles of each frame)
const BANDS = {
  "SPHEREx-D1": "0.75–1.09 µm", "SPHEREx-D2": "1.10–1.62 µm", "SPHEREx-D3": "1.63–2.41 µm",
  "SPHEREx-D4": "2.42–3.82 µm", "SPHEREx-D5": "3.83–4.41 µm", "SPHEREx-D6": "4.42–5.00 µm",
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- coordinates
function nums(s) { return (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number); }
function parseRA(s) {
  s = String(s).trim(); if (!s) return null;
  const n = nums(s); if (!n.length) return null;
  const v = (n.length >= 2 || /h/i.test(s)) ? (n[0] + (n[1] || 0) / 60 + (n[2] || 0) / 3600) * 15 : n[0];
  return v >= 0 && v < 360 ? v : null;
}
function parseDec(s) {
  s = String(s).trim(); if (!s) return null;
  const neg = /^[-−]/.test(s); const n = nums(s); if (!n.length) return null;
  let v = n.length >= 2 ? n[0] + n[1] / 60 + (n[2] || 0) / 3600 : n[0];
  if (neg) v = -v;
  return v >= -90 && v <= 90 ? v : null;
}
const p2 = (n) => String(n).padStart(2, "0");
function fmtRA(ra) {
  const t = Math.round((((ra % 360) + 360) % 360) / 15 * 36000) % 864000;
  return `${p2(Math.floor(t / 36000))}h ${p2(Math.floor((t % 36000) / 600))}m ${((t % 600) / 10).toFixed(1).padStart(4, "0")}s`;
}
function fmtDec(d) {
  const t = Math.round(Math.abs(d) * 3600);
  return `${d < 0 ? "−" : "+"}${p2(Math.floor(t / 3600))}° ${p2(Math.floor((t % 3600) / 60))}′ ${p2(t % 60)}″`;
}
const degRA = (ra) => ra.toFixed(5) + "°";
const degDec = (d) => (d >= 0 ? "+" : "") + d.toFixed(5) + "°";
const fmtArc = (a) => a >= 60 ? `${+(a / 60).toFixed(1)}′` : `${Math.round(a)}″`;

// Field pixel (continuous, 0..nx / 0..ny, north up, east left) <-> sky, for a north-up
// tangent-plane grid centred on (ra0, dec0). Accurate to well under a pixel for these small fields.
function pixToSky(f, ix, iy) {
  const s = f.scale / 3600;
  const dec = f.dec + (f.ny / 2 - iy) * s;
  const ra = f.ra - (ix - f.nx / 2) * s / Math.cos(dec * Math.PI / 180);
  return { ra: ((ra % 360) + 360) % 360, dec };
}
function skyToPix(f, ra, dec) {
  const s = f.scale / 3600;
  let dra = ra - f.ra; if (dra > 180) dra -= 360; if (dra < -180) dra += 360;
  return { ix: f.nx / 2 - dra * Math.cos(dec * Math.PI / 180) / s, iy: f.ny / 2 - (dec - f.dec) / s };
}

// ---------------------------------------------------------------- picture rendering
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];
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
function cubicTaps(n, S) {
  const idx = new Int32Array(S * 4), wts = new Float32Array(S * 4);
  for (let o = 0; o < S; o++) {
    const u = ((o + 0.5) * n) / S - 0.5, i0 = Math.floor(u), wt = cubicWeights(u - i0);
    for (let k = 0; k < 4; k++) { idx[o * 4 + k] = Math.min(n - 1, Math.max(0, i0 - 1 + k)); wts[o * 4 + k] = wt[k]; }
  }
  return { idx, wts };
}

// Upsample a w x h frame to OW x OH (bicubic, clamped so stars get no halos) with the stretch applied.
function drawFrame(w, h, data, lo, hi, invert, OW, OH) {
  // No-data pixels borrow their nearest valid neighbour for interpolation only; they are still
  // drawn as "no data" below.
  const vals = new Float32Array(w * h), valid = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) { valid[i] = data[i] !== null ? 1 : 0; vals[i] = valid[i] ? data[i] : lo; }
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (valid[i]) continue;
      const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].find(([a, b]) => a >= 0 && b >= 0 && a < w && b < h && valid[b * w + a]);
      if (nb) vals[i] = vals[nb[1] * w + nb[0]];
    }
  }
  const tx = cubicTaps(w, OW), ty = cubicTaps(h, OH);
  const rows = new Float32Array(h * OW);
  for (let y = 0; y < h; y++) for (let o = 0; o < OW; o++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += vals[y * w + tx.idx[o * 4 + k]] * tx.wts[o * 4 + k];
    const a = vals[y * w + tx.idx[o * 4 + 1]], b = vals[y * w + tx.idx[o * 4 + 2]];
    rows[y * OW + o] = Math.min(Math.max(s, Math.min(a, b)), Math.max(a, b));
  }
  const img = new ImageData(OW, OH), range = hi - lo;
  for (let oy = 0; oy < OH; oy++) {
    const y1 = ty.idx[oy * 4 + 1], y2 = ty.idx[oy * 4 + 2];
    const fy = Math.min(1, Math.max(0, ((oy + 0.5) * h) / OH - 0.5 - y1));
    for (let ox = 0; ox < OW; ox++) {
      const p = (oy * OW + ox) * 4;
      const x1 = tx.idx[ox * 4 + 1], x2 = tx.idx[ox * 4 + 2];
      const fx = Math.min(1, Math.max(0, ((ox + 0.5) * w) / OW - 0.5 - x1));
      const cover = (valid[y1 * w + x1] * (1 - fx) + valid[y1 * w + x2] * fx) * (1 - fy) +
                    (valid[y2 * w + x1] * (1 - fx) + valid[y2 * w + x2] * fx) * fy;
      if (cover < 0.5) { img.data[p] = 70; img.data[p + 1] = 40; img.data[p + 2] = 40; img.data[p + 3] = 255; continue; } // no data
      let v = 0;
      for (let k = 0; k < 4; k++) v += rows[ty.idx[oy * 4 + k] * OW + ox] * ty.wts[oy * 4 + k];
      const a = rows[y1 * OW + ox], b = rows[y2 * OW + ox];
      v = Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
      const t = Math.min(1, Math.max(0, (v - lo) / range));
      let g = Math.round((255 * Math.asinh(STRETCH * t)) / STRETCH_NORM);
      if (invert) g = 255 - g;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = g; img.data[p + 3] = 255;
    }
  }
  return img;
}

// ---------------------------------------------------------------- sky viewer (zoom, pan, hover, click)
class SkyView {
  constructor(box, zoomScope, { onHover, onPick, onChange }) {
    this.box = box; this.canvas = box.querySelector("canvas"); this.ctx = this.canvas.getContext("2d");
    this.zoomScope = zoomScope; this.onHover = onHover; this.onPick = onPick; this.onChange = onChange;
    this.field = null;     // { nx, ny, scale, ra, dec } – geometry of the current image
    this.off = null;       // rendered picture (offscreen canvas)
    this.z = 1; this.tx = 0; this.ty = 0; this.drag = null;
    zoomScope.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
      const r = this.rect();
      this.zoomAt(r.width / 2, r.height / 2, this.z * (b.dataset.zoom === "in" ? 1.5 : 1 / 1.5));
    }));
    box.addEventListener("pointerdown", (e) => this.down(e));
    box.addEventListener("pointermove", (e) => this.move(e));
    box.addEventListener("pointerup", (e) => this.up(e));
    box.addEventListener("pointerleave", () => { this.drag = null; box.classList.remove("dragging"); this.onHover && this.onHover(null); });
    box.addEventListener("wheel", (e) => {
      if (!this.field) return;
      e.preventDefault();
      const p = this.local(e); this.zoomAt(p.x, p.y, this.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
    }, { passive: false });
    new ResizeObserver(() => { this.fitClamp(); this.draw(); }).observe(box);
  }
  rect() { return this.box.getBoundingClientRect(); }
  local(e) { const r = this.rect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  base() { const r = this.rect(); return this.field ? Math.min(r.width / this.field.nx, r.height / this.field.ny) : 1; }
  k() { return this.base() * this.z; }    // screen px per image pixel
  toScreen(ix, iy) { const k = this.k(); return { x: this.tx + ix * k, y: this.ty + iy * k }; }
  toImage(x, y) { const k = this.k(); return { ix: (x - this.tx) / k, iy: (y - this.ty) / k }; }
  inside(ix, iy) { return this.field && ix >= 0 && iy >= 0 && ix <= this.field.nx && iy <= this.field.ny; }

  clampAxis(t, img, box) { return img <= box ? (box - img) / 2 : Math.min(0, Math.max(box - img, t)); }
  fitClamp() {
    if (!this.field) return;
    const r = this.rect(), k = this.k();
    this.tx = this.clampAxis(this.tx, this.field.nx * k, r.width);
    this.ty = this.clampAxis(this.ty, this.field.ny * k, r.height);
  }
  zoomAt(x, y, nz) {
    if (!this.field) return;
    nz = Math.max(1, Math.min(8, nz));
    const p = this.toImage(x, y); this.z = nz;
    const k = this.k(); this.tx = x - p.ix * k; this.ty = y - p.iy * k;
    this.fitClamp(); this.draw();
  }

  down(e) {
    // Presses on links or buttons over the image belong to them, not to pan / pick.
    if (e.button !== 0 || !this.field || e.target.closest("a, button, .pop")) return;
    this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false };
    this.box.setPointerCapture(e.pointerId);
  }
  move(e) {
    const d = this.drag;
    if (d) {
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) { d.moved = true; this.box.classList.add("dragging"); }
      if (d.moved) { this.tx = d.tx + e.clientX - d.x; this.ty = d.ty + e.clientY - d.y; this.fitClamp(); this.draw(); }
    }
    if (this.onHover && this.field) {
      const p = this.local(e), q = this.toImage(p.x, p.y);
      this.onHover(this.inside(q.ix, q.iy) && !(d && d.moved) ? { ...q, x: p.x, y: p.y } : null);
    }
  }
  up(e) {
    const d = this.drag; this.drag = null; this.box.classList.remove("dragging");
    if (!d || d.moved || !this.field) return;
    const p = this.local(e), q = this.toImage(p.x, p.y);
    if (this.inside(q.ix, q.iy) && this.onPick) this.onPick(q);
  }

  // Show a frame: { width, height, data, pixel_scale_arcsec } at sky centre (ra, dec).
  setImage(cut, ra, dec, display) {
    const newGeom = !this.field || this.field.nx !== cut.width || this.field.ny !== cut.height;
    this.field = { nx: cut.width, ny: cut.height, scale: cut.pixel_scale_arcsec || 6.15, ra, dec };
    if (newGeom) { this.z = 1; this.tx = 0; this.ty = 0; }
    const finite = cut.data.filter((v) => v !== null).sort((a, b) => a - b);
    const lo = percentile(finite, display.minb);
    let hi = percentile(finite, display.maxb); if (hi <= lo) hi = lo + 1e-6;
    // Render at about the box's device resolution (capped for speed); zoom scales this picture.
    const r = this.rect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    let f = Math.max(1, Math.min(r.width * dpr / cut.width, r.height * dpr / cut.height) || 1);
    f = Math.min(f, Math.sqrt(1.2e6 / (cut.width * cut.height)));
    const OW = Math.max(cut.width, Math.round(cut.width * f)), OH = Math.max(cut.height, Math.round(cut.height * f));
    if (!this.off) this.off = document.createElement("canvas");
    this.off.width = OW; this.off.height = OH;
    this.off.getContext("2d").putImageData(drawFrame(cut.width, cut.height, cut.data, lo, hi, display.invert, OW, OH), 0, 0);
    this.hasImage = true;
    this.fitClamp(); this.draw();
  }
  clearImage() { this.hasImage = false; this.draw(); }

  draw() {
    const r = this.rect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = "#050505"; c.fillRect(0, 0, W, H);
    if (this.field && this.hasImage) {
      const k = this.k();
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
      c.drawImage(this.off, this.tx, this.ty, this.field.nx * k, this.field.ny * k);
    }
    const zp = this.zoomScope.querySelector(".zpct");
    if (zp) zp.textContent = Math.round(this.z * 100) + "%";
    this.drawScale();
    this.onChange && this.onChange();
  }
  // Scale bar: the largest "nice" angle that fits in ~20% of the box width.
  drawScale() {
    const bar = this.box.querySelector(".scalebar"), lbl = this.box.querySelector(".scalelbl");
    if (!this.field) { bar.style.width = "0"; lbl.textContent = ""; return; }
    const pxPerArcsec = this.k() / this.field.scale, maxPx = this.rect().width * 0.2;
    const nice = [3600, 1800, 1200, 600, 300, 120, 60, 30, 20, 10, 5, 2, 1];
    const a = nice.find((x) => x * pxPerArcsec <= maxPx) || 1;
    bar.style.width = (a * pxPerArcsec).toFixed(1) + "px";
    lbl.textContent = a >= 3600 ? `${a / 3600}°` : a >= 60 ? `${a / 60}′` : `${a}″`;
  }
  // Position an overlay element (absolutely positioned, zero-size anchor) at a sky position.
  place(el, ix, iy) {
    const p = this.toScreen(ix, iy), r = this.rect();
    const vis = this.hasImage && p.x >= 0 && p.y >= 0 && p.x <= r.width && p.y <= r.height;
    el.hidden = !vis;
    if (vis) { el.style.left = p.x + "px"; el.style.top = p.y + "px"; }
    return p;
  }
}

// ---------------------------------------------------------------- API
async function getJSON(url) {
  const r = await fetch(url);
  let j; try { j = await r.json(); } catch { throw new Error(r.statusText || "Bad response"); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const framesURL = (ra, dec, band) => `api/frames?ra=${ra}&dec=${dec}&band=${encodeURIComponent(band)}`;
const cutoutURL = (f, ra, dec, h, w) =>
  `api/cutout?ra=${ra}&dec=${dec}&size=${h}&width=${w}&url=${encodeURIComponent(f.url)}`;
// POST a list of frames to /api/cutouts and call onLine for each streamed result line.
async function streamCutouts(list, c, id, onLine) {
  const r = await fetch(`api/cutouts?ra=${c.ra}&dec=${c.dec}&size=${ex.h}&width=${ex.w}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: list.map((f) => f.url) }),
  });
  if (!r.ok || !r.body) throw new Error(r.statusText);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (id !== ex.searchId) { reader.cancel(); return; }   // a newer search started
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, k); buf = buf.slice(k + 1);
      if (line) onLine(JSON.parse(line));
    }
  }
}
const shortDate = (d) => {   // "2025-05-10 17:04:37" -> { day: "10 May", year: "2025", time: "17:04" }
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(d) || [];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(+m[2] || 1) - 1];
  return { day: `${+m[3]} ${mon}`, year: m[1], time: m[4] };
};

// ======================================================================
// Presets
// ======================================================================
// Preset targets. Coordinates are ICRS, in degrees.
// Source: SIMBAD (basic table), queried 2026-11-14 via its official mirror
// simbad.cfa.harvard.edu, because simbad.cds.unistra.fr was unavailable.
// WISE 0855 uses the coordinates given in the project brief.
// Barnard's Star and Epsilon Indi B move fast, so their J2000 positions were moved to epoch
// 2026.0 using SIMBAD's proper motion, parallax and radial velocity (none listed for eps Ind B;
// 0 used). RW Aur and R Dra are SIMBAD J2000 positions (slow movers).
const PRESETS = [
  { name: "WISE 0855",      kind: "Y dwarf",            ra: 133.795129, dec: -7.245147 },
  { name: "Barnard's Star", kind: "Red dwarf",          ra: 269.446259, dec: 4.768324 },   // SIMBAD "NAME Barnard's star"; J2000 269.452077, +4.693365
  { name: "Epsilon Indi B", kind: "Brown dwarf binary", ra: 331.096669, dec: -56.800649 }, // SIMBAD "* eps Ind B"; J2000 331.044147, -56.782844
  { name: "RW Aurigae",     kind: "T Tauri star",       ra: 76.956526,  dec: 30.401438 },  // SIMBAD "V* RW Aur"
  { name: "R Draconis",     kind: "Mira variable",      ra: 248.167611, dec: 66.754979 },  // SIMBAD "V* R Dra"
];
const PRESET_SIZE_ARCMIN = 10, PRESET_BAND = "SPHEREx-D3";
const START_PRESET = "Barnard's Star";   // shown on 01 PICK when the page opens

const bandShort = (b) => b.slice(-2);
const sameSky = (a, b) => a && b && Math.abs(a.ra - b.ra) < 1e-5 && Math.abs(a.dec - b.dec) < 1e-5;
const presetAt = (c) => PRESETS.find((p) => sameSky(p, c));

// Field height (arcsec) from the HEIGHT box (arcmin, 1–10).
function heightArcsec() {
  const m = Number($("size").value);
  return m >= 1 && m <= 10 ? Math.round(m * 60) : null;
}
// Explore field width: the explore viewer's shape (pixels stay square), within backend limits.
function exploreWidth(h) {
  const narrow = window.innerWidth <= 760;
  const vw = Math.max(200, window.innerWidth - 22);
  const vh = narrow ? window.innerHeight * 0.56 : Math.max(160, Math.max(window.innerHeight, 480) - 172);
  return Math.round(Math.min(MAX_WIDTH, Math.max(h, h * vw / vh)));
}

// ======================================================================
// 01 PICK
// ======================================================================
const pk = { center: null, pick: null, band: "", loadId: 0, shownFrame: null };
const pvBox = $("pvSky");
const pvView = new SkyView(pvBox, $("pvZoom"), {
  onHover: (h) => pvHover(h),
  onPick: (q) => setPick(pixToSky(pvView.field, q.ix, q.iy), true),
  onChange: () => placePickMarks(),
});

function pvLoading(text, spinner = true) {
  $("pvLoading").hidden = !text;
  if (text) $("pvLoadingText").textContent = text;
  pvBox.querySelector(".spin").hidden = !spinner;
}

async function loadPreview(center) {
  const id = ++pk.loadId, band = $("band").value;
  pk.center = { ...center }; pk.band = band;
  const r = pvView.rect();
  const w = PREVIEW_W, h = Math.round(Math.min(1800, Math.max(300, w * (r.height / Math.max(1, r.width)))));
  pvLoading("Loading SPHEREx image…");
  $("pvCredit").textContent = "SPHEREx image from IRSA";
  updatePickLabel();
  try {
    const list = await getJSON(framesURL(center.ra, center.dec, band));
    if (id !== pk.loadId) return;
    if (!list.frames.length) throw new Error(`no SPHEREx ${bandShort(band)} image covers this position yet`);
    const f = list.frames[list.frames.length - 1];      // the most recent image
    const cut = await getJSON(cutoutURL(f, center.ra, center.dec, h, w));
    if (id !== pk.loadId) return;
    pvView.setImage(cut, center.ra, center.dec, DISPLAY);
    pk.shownFrame = f;
    pvLoading("");
    $("pvCredit").innerHTML = `SPHEREx ${esc(bandShort(band))} · ${esc(f.date.slice(0, 10))} · ` +
      `<a href="${encodeURI(f.url)}" target="_blank" rel="noopener">image file at IRSA</a>`;
    placePickMarks();
  } catch (e) {
    if (id !== pk.loadId) return;
    pvView.clearImage();
    pvLoading("Could not load a SPHEREx image here: " + e.message, false);
  }
}

function updatePickLabel() {
  const p = presetAt(pk.pick);
  $("pvName").textContent = p ? p.name : "Custom field";
  $("pvSubl").textContent = `${bandShort($("band").value)} · ${BANDS[$("band").value]} · 6.15″/px`;
  $("presets").querySelectorAll(".pr").forEach((b) => {
    const on = !!p && b.dataset.name === p.name;
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
  });
}

function pvHover(h) {
  const show = !!h;
  pvBox.querySelector(".cross-h").hidden = !show;
  pvBox.querySelector(".cross-v").hidden = !show;
  const tag = pvBox.querySelector(".hovertag"); tag.hidden = !show;
  if (!show) return;
  const r = pvView.rect(), c = pixToSky(pvView.field, h.ix, h.iy);
  pvBox.querySelector(".cross-h").style.top = h.y + "px";
  pvBox.querySelector(".cross-v").style.left = h.x + "px";
  tag.innerHTML = `<b>RA </b> ${esc(fmtRA(c.ra))}\n<b>DEC</b> ${esc(fmtDec(c.dec))}`;
  tag.style.left = h.x + "px"; tag.style.top = h.y + "px";
  tag.style.transform = (h.x > r.width * 0.7 ? "translate(calc(-100% - 14px), " : "translate(14px, ") +
                        (h.y > r.height * 0.8 ? "calc(-100% - 14px))" : "14px)");
}

// Selection ring, and the dashed box of the field Search will fetch.
function placePickMarks() {
  const m = pvBox.querySelector(".selmark"), reg = pvBox.querySelector(".region");
  const tgt = pk.pick || pk.center;
  if (!tgt || !pvView.field || !pvView.hasImage) { m.hidden = reg.hidden = true; return; }
  const p = skyToPix(pvView.field, tgt.ra, tgt.dec);
  if (pk.pick && pvView.inside(p.ix, p.iy)) pvView.place(m, p.ix, p.iy); else m.hidden = true;
  const h = heightArcsec();
  if (!h || !pvView.inside(p.ix, p.iy)) { reg.hidden = true; return; }
  const w = exploreWidth(h), s = pvView.field.scale;
  const a = pvView.toScreen(p.ix - w / s / 2, p.iy - h / s / 2), b = pvView.toScreen(p.ix + w / s / 2, p.iy + h / s / 2);
  reg.hidden = false;
  Object.assign(reg.style, { left: a.x + "px", top: a.y + "px", width: (b.x - a.x) + "px", height: (b.y - a.y) + "px" });
  reg.querySelector(".rtag").textContent = `${fmtArc(h)} × ${fmtArc(w)} FIELD`;
}

function setPick(c, fillInputs) {
  pk.pick = c;
  if (fillInputs) {
    $("ra").value = c.ra.toFixed(5); $("dec").value = (c.dec >= 0 ? "+" : "") + c.dec.toFixed(5);
    $("err").hidden = true;
  }
  updateHints(); updatePickLabel(); placePickMarks();
}

function updateHints() {
  const ra = parseRA($("ra").value), dec = parseDec($("dec").value);
  $("raHint").textContent = ra !== null ? `= ${fmtRA(ra)}` : "Degrees, or hh mm ss";
  $("decHint").textContent = dec !== null ? `= ${fmtDec(dec)}` : "Degrees, or ±dd mm ss";
}

function typedPosition(report) {
  const rs = $("ra").value, ds = $("dec").value, ra = parseRA(rs), dec = parseDec(ds);
  let err = "";
  if (rs.trim() && ra === null) err = "RA should be 0–360° or hh mm ss.";
  else if (ds.trim() && dec === null) err = "Dec should be −90° to +90° or ±dd mm ss.";
  else if (report && (ra === null || dec === null)) err = "Enter both a Right Ascension and a Declination.";
  $("err").hidden = !err; $("err").textContent = err;
  return ra !== null && dec !== null ? { ra, dec } : null;
}

function onTyped() {
  updateHints();
  const c = typedPosition(false);
  if (!c) return;
  setPick(c, false);
  // Re-centre the preview when the typed position is outside it.
  const p = pvView.field && skyToPix(pvView.field, c.ra, c.dec);
  if (!p || !pvView.inside(p.ix, p.iy)) loadPreview(c);
}

function runSearch() {      // returns true when the search starts
  const c = typedPosition(true);
  if (!c) return false;
  if (!heightArcsec()) { $("err").hidden = false; $("err").textContent = "Height should be 1–10 arcmin."; return false; }
  pk.pick = c;
  writeHash(c);
  openExplore(c);
  return true;
}

// ---- slide to search: drag the red handle to the right end; letting go early springs it back.
const goBtn = $("goSlide"), goKnob = goBtn.querySelector(".gocirc"), goFill = goBtn.querySelector(".gofill"), goLbl = goBtn.querySelector(".golbl");
const GO_DONE = 0.85;    // fraction of the track that counts as "slid"
let goDrag = null;
const goMax = () => Math.max(1, goBtn.clientWidth - goKnob.offsetWidth - 2 * goKnob.offsetLeft);
function goSet(x) {
  goKnob.style.transform = `translateX(${x}px)`;
  goFill.style.width = x > 0 ? `${x + goKnob.offsetWidth + goKnob.offsetLeft}px` : "0";
  goLbl.style.opacity = String(Math.max(0, 1 - (x / goMax()) * 1.6));   // the label fades as the handle moves
}
function goReset() {
  goBtn.classList.add("snap"); goSet(0);
  setTimeout(() => goBtn.classList.remove("snap"), 260);
}
goBtn.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  goDrag = { x0: e.clientX, x: 0, moved: false };
  goBtn.setPointerCapture(e.pointerId); goBtn.classList.add("sliding"); goBtn.classList.remove("snap", "nudge");
});
goBtn.addEventListener("pointermove", (e) => {
  if (!goDrag) return;
  goDrag.x = Math.max(0, Math.min(goMax(), e.clientX - goDrag.x0));
  if (goDrag.x > 3) goDrag.moved = true;
  goSet(goDrag.x);
});
function goEnd() {
  if (!goDrag) return;
  const d = goDrag; goDrag = null; goBtn.classList.remove("sliding");
  if (d.x >= goMax() * GO_DONE) {
    goSet(goMax());
    if (runSearch()) setTimeout(goReset, 400); else goReset();
  } else {
    goReset();
    if (!d.moved) { void goBtn.offsetWidth; goBtn.classList.add("nudge"); setTimeout(() => goBtn.classList.remove("nudge"), 700); }
  }
}
goBtn.addEventListener("pointerup", goEnd);
goBtn.addEventListener("pointercancel", goEnd);
// Keyboard: Enter or Space on the control searches (a click without sliding only nudges).
goBtn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); runSearch(); } });
// Enter in the RA / Dec / Height fields still searches.
["ra", "dec", "size"].forEach((id) => $(id).addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $(id).dispatchEvent(new Event("change")); runSearch(); }
}));

$("ra").addEventListener("input", updateHints);
$("dec").addEventListener("input", updateHints);
$("ra").addEventListener("change", onTyped);
$("dec").addEventListener("change", onTyped);
$("band").addEventListener("change", () => loadPreview(pk.center));
$("size").addEventListener("input", () => {
  const h = heightArcsec();
  $("sizeHint").textContent = h ? `Field ${fmtArc(h)} × ${fmtArc(exploreWidth(h))}` : "1–10 arcmin";
  placePickMarks();
});
$("search").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });

PRESETS.forEach((t) => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "pr"; b.textContent = t.name; b.dataset.name = t.name;
  b.title = `${t.name} · ${t.kind} · RA ${t.ra.toFixed(5)}°, Dec ${t.dec >= 0 ? "+" : ""}${t.dec.toFixed(5)}°`;
  b.setAttribute("aria-pressed", "false");
  // Fills RA/Dec, sets height 10′ and band D3, and runs the search.
  b.addEventListener("click", () => {
    $("ra").value = t.ra.toFixed(6);
    $("dec").value = (t.dec >= 0 ? "+" : "") + t.dec.toFixed(6);
    $("size").value = PRESET_SIZE_ARCMIN; $("band").value = PRESET_BAND;
    $("size").dispatchEvent(new Event("input"));
    updateHints();
    pk.pick = { ra: t.ra, dec: t.dec }; updatePickLabel();
    runSearch();
  });
  $("presets").appendChild(b);
});

// ======================================================================
// 02 EXPLORE
// ======================================================================
const ex = {
  target: null, name: "", band: "", h: 0, w: 0,
  frames: [], current: 0, timer: null, playing: false, speedIdx: 2,
  blink: false, blinkAlt: false, blinkTimer: null,
  pick: null, popAt: null,          // clicked field pixel, and where the click was on screen
  searchId: 0, listTotal: 0, done: 0, failed: 0, finished: false,
};
const exBox = $("exSky");
const exView = new SkyView(exBox, $("exZoom"), {
  onPick: (q) => { ex.pick = q; renderPop(); placeExMarks(); },
  onChange: () => placeExMarks(),
});

function exLoading(text) { $("exLoading").hidden = !text; if (text) $("exLoadingText").textContent = text; }
let toastTimer = null;
function toast(msg) {
  clearTimeout(toastTimer);
  $("toast").textContent = msg; $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2200);
}

async function openExplore(c) {
  stop(); stopBlink();
  $("pick").hidden = true; $("explore").hidden = false;
  window.scrollTo(0, 0);

  const id = ++ex.searchId, p = presetAt(c);
  Object.assign(ex, { target: c, name: p ? p.name : "Custom field", band: $("band").value, h: heightArcsec(),
                      frames: [], current: 0, pick: null, listTotal: 0, done: 0, failed: 0, finished: false });
  ex.w = exploreWidth(ex.h);
  loadGaia(c);
  $("strip").innerHTML = ""; $("exCredit").textContent = "";
  $("pop").hidden = true; $("noObs").hidden = true;
  exView.field = null; exView.clearImage();
  exLoading("Retrieving SPHEREx observations…");
  renderBar();

  let list;
  try { list = await getJSON(framesURL(c.ra, c.dec, ex.band)); }
  catch (e) {
    if (id !== ex.searchId) return;
    exLoading("");
    $("noObsTitle").textContent = "Could not search IRSA";
    $("noObsText").textContent = e.message + ". Go back and try again.";
    $("noObs").hidden = false; return;
  }
  if (id !== ex.searchId) return;

  let all = list.frames;
  ex.listTotal = all.length;
  if (!all.length) {
    exLoading("");
    $("noObsTitle").textContent = "No SPHEREx observations found";
    $("noObsText").textContent = "Nothing is available for these coordinates in the selected band. Go back and try another position or band.";
    $("noObs").hidden = false; return;
  }
  if (all.length > MAX_FRAMES) {
    const step = all.length / MAX_FRAMES;
    all = Array.from({ length: MAX_FRAMES }, (_, i) => all[Math.floor(i * step)]);
  }
  ex.frames = all.map((f) => ({ ...f, cut: null, failed: false }));
  exLoading(`Retrieving SPHEREx observations… 0 of ${ex.frames.length}`);
  buildStrip(); renderBar();

  // All cutouts in one streamed request (the server fetches several from IRSA at once);
  // failed frames get one more try.
  const received = (f, frame) => {
    if (frame) { f.cut = frame; if (f.failed) { f.failed = false; ex.failed--; } ex.done++; }
    else if (!f.failed) { f.failed = true; ex.failed++; }
    const i = ex.frames.indexOf(f);
    updateChip(i);
    if (!exView.hasImage && frame && i === ex.current) exLoading("");
    else if (!exView.hasImage) exLoading(`Retrieving SPHEREx observations… ${ex.done} of ${ex.frames.length}`);
    // An earlier frame arriving can change what BLINK compares against.
    if (i === ex.current || (ex.blink && i < ex.current)) showFrame();
  };
  for (let pass = 0; pass < 2 && id === ex.searchId; pass++) {
    const batch = pass === 0 ? ex.frames.slice() : ex.frames.filter((f) => f.failed);
    if (!batch.length) break;
    const got = new Set();
    try {
      await streamCutouts(batch, c, id, (msg) => { got.add(msg.i); received(batch[msg.i], msg.frame); });
    } catch { /* connection lost: anything not received counts as failed below */ }
    if (id !== ex.searchId) return;
    batch.forEach((f, i) => { if (!got.has(i)) received(f, null); });
  }
  if (id !== ex.searchId) return;
  ex.finished = true;
  if (!ex.frames[ex.current].cut) { const first = ex.frames.findIndex((f) => f.cut); if (first >= 0) go(first); }
  if (!ex.frames.some((f) => f.cut)) {
    exLoading("");
    $("noObsTitle").textContent = "Could not load the observations";
    $("noObsText").textContent = "IRSA did not return any of the images. It may be busy; go back and try again.";
    $("noObs").hidden = false;
  }
}

// ---- date strip
const qualityText = (f) => f.cut && f.cut.quality && f.cut.quality.length ? f.cut.quality.map((q) => q.name).join(", ") : "";
function buildStrip() {
  const strip = $("strip"); strip.innerHTML = "";
  ex.frames.forEach((f, i) => {
    const d = shortDate(f.date), b = document.createElement("button");
    b.type = "button"; b.className = "fr";
    b.innerHTML = `<span class="d">${esc(d.day)}</span><span class="t">${esc(d.year)} · ${esc(d.time)} UTC<span class="dotf" hidden></span></span>`;
    b.addEventListener("click", () => go(i));
    strip.appendChild(b);
    updateChip(i);
  });
  updateStrip();
}
function updateChip(i) {
  const b = $("strip").children[i]; if (!b) return;
  const f = ex.frames[i], d = shortDate(f.date), q = qualityText(f);
  b.classList.toggle("on", i === ex.current);
  b.classList.toggle("bad", f.failed);
  b.setAttribute("aria-current", String(i === ex.current));
  b.querySelector(".dotf").hidden = !q;
  b.setAttribute("aria-label", `${d.day} ${d.year}, ${d.time} UTC${q ? ", flagged: " + q : ""}${f.failed ? ", could not be loaded" : ""}`);
  b.title = q ? `Quality flags at the target: ${q}` : "";
}
function updateStrip() {
  const strip = $("strip");
  for (let i = 0; i < strip.children.length; i++) updateChip(i);
  const b = strip.children[ex.current];
  if (b) {   // keep the current date in view without scrolling the page
    const l = b.offsetLeft - strip.offsetLeft, r = l + b.offsetWidth;
    if (l < strip.scrollLeft) strip.scrollLeft = l - 6;
    else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r - strip.clientWidth + 6;
  }
}

// ---- the picture: normal, blink, or difference
// BLINK and DIFF compare with the nearest earlier observation that loaded (-1 if none).
function refIndex() {
  for (let i = ex.current - 1; i >= 0; i--) if (ex.frames[i].cut) return i;
  return -1;
}
function shownIndex() {
  const r = refIndex();
  return ex.blink && ex.blinkAlt && r >= 0 ? r : ex.current;
}
function showFrame() {
  const k = ex.current, f = ex.frames[k]; if (!f) return;
  const di = shownIndex(), shown = ex.frames[di], d = shortDate(shown.date);
  $("shownDate").textContent = `${d.day} ${d.year} · ${d.time} UTC`;
  $("chanShort").textContent = (shown.cut && shown.cut.wavelength_um ? `λ ${shown.cut.wavelength_um.toFixed(3)} µm · ` : "") +
    `${bandShort(ex.band)} · 6.15″/px`;
  $("exCredit").innerHTML = `SPHEREx ${esc(shown.collection.replace("spherex_", "").toUpperCase())} · ${esc(shown.obs_id)} · ` +
    `<a href="${encodeURI(shown.url)}" target="_blank" rel="noopener">Original image file at IRSA (FITS)</a>`;

  if (shown.cut) {
    exView.setImage(shown.cut, ex.target.ra, ex.target.dec, DISPLAY);
  } else {
    exView.clearImage();
    if (!$("explore").hidden && ex.frames.length) exLoading(shown.failed ? "" : "Retrieving this observation…");
  }
  if (exView.hasImage) exLoading("");
  renderMode(); renderBar(); updateStrip(); renderPop(); placeExMarks();
}

function renderMode() {
  const lbl = $("modeLabel"), k = ex.current, f = ex.frames[k], ri = refIndex(), p = ex.frames[ri];
  lbl.hidden = !ex.blink;
  if (!f) return;
  const day = (x) => shortDate(x.date).day;
  const skipped = ri >= 0 && ri < k - 1 ? ` · ${k - 1 - ri} NOT LOADED, SKIPPED` : "";
  if (ex.blink) {
    lbl.textContent = !f.cut ? "BLINK · THIS OBSERVATION IS NOT LOADED"
      : p ? `BLINK · ${day(p)} ↔ ${day(f)} · NOW ${day(ex.frames[shownIndex()])}${skipped}`
      : "BLINK · NO EARLIER LOADED OBSERVATION";
  }
}

function placeExMarks() {
  const edge = exBox.querySelector(".frameedge"), ring = exBox.querySelector(".selring");
  if (!exView.field || !exView.hasImage) { edge.hidden = ring.hidden = true; return; }
  const a = exView.toScreen(0, 0), b = exView.toScreen(exView.field.nx, exView.field.ny);
  edge.hidden = a.y < 24;   // only when there is room above the image for the tag
  ring.hidden = true;
  Object.assign(edge.style, { left: a.x + "px", top: a.y + "px", width: (b.x - a.x) + "px", height: (b.y - a.y) + "px" });
  $("regionTag").textContent = `YOUR REGION · ${fmtArc(ex.h)} × ${fmtArc(ex.w)}`;
  if (ex.pick) exView.place(ring, ex.pick.ix, ex.pick.iy); else ring.hidden = true;
  if (!$("pop").hidden) positionPop();
  drawGaia();
}

// ---- "About" pop-up for a clicked position (values read from the image shown)
function prow(k, v, warn) { return `<div class="prow"><div class="k">${esc(k)}</div><div class="v${warn ? " warn" : ""}">${v}</div></div>`; }
function renderPop() {
  const pop = $("pop");
  if (!ex.pick || !exView.field || !ex.frames.length) { pop.hidden = true; return; }
  const fld = exView.field, c = pixToSky(fld, ex.pick.ix, ex.pick.iy);
  const di = shownIndex(), f = ex.frames[di], d = shortDate(f.date);
  const px = Math.min(fld.nx - 1, Math.floor(ex.pick.ix)), py = Math.min(fld.ny - 1, Math.floor(ex.pick.iy));
  const val = f.cut ? f.cut.data[py * f.cut.width + px] : undefined;
  const de = -(ex.pick.ix - fld.nx / 2) * fld.scale, dn = (fld.ny / 2 - ex.pick.iy) * fld.scale;
  const off = Math.hypot(de, dn), pa = ((Math.atan2(de, dn) * 180 / Math.PI) + 360) % 360;
  $("popId").textContent = `${fmtRA(c.ra)} ${fmtDec(c.dec)}`;
  const rows = [
    prow("RA", esc(fmtRA(c.ra))),
    prow("Dec", esc(fmtDec(c.dec))),
    prow("Brightness", val === undefined ? "—" : val === null ? "no data" : `${val.toFixed(3)} MJy/sr`, val === null),
    prow("Observed", esc(`${d.day} ${d.year} · ${d.time} UTC`)),
    prow("Wavelength", f.cut && f.cut.wavelength_um ? `${f.cut.wavelength_um.toFixed(3)} µm` : "—"),
    prow("Band", esc(`${bandShort(ex.band)} · ${BANDS[ex.band]}`)),
    prow("From target", off < 0.05 ? "0″" : esc(`${off.toFixed(1)}″ · PA ${pa.toFixed(0)}°`)),
    prow("Source file", `<a href="${encodeURI(f.url)}" target="_blank" rel="noopener">FITS at IRSA</a>`),
  ];
  $("popRows").innerHTML = rows.join("") + gaiaPopRows(c, f.mjd);
  $("popNoData").hidden = val !== null;
  pop.hidden = false;
  positionPop();
}
function positionPop() {
  const pop = $("pop"), r = exView.rect();
  // The pop-up is capped at the image area's height (it scrolls inside if taller), so it always fits.
  const p = exView.toScreen(ex.pick.ix, ex.pick.iy), pw = pop.offsetWidth || 280;
  const ph = Math.min(pop.offsetHeight || 220, r.height - 16);
  let left = p.x < r.width * 0.6 ? p.x + 28 : p.x - pw - 28;
  left = Math.max(8, Math.min(r.width - pw - 8, left));
  const top = Math.max(8, Math.min(r.height - ph - 8, p.y - 60));
  pop.style.left = left + "px"; pop.style.top = top + "px";
}
$("popClose").addEventListener("click", () => { ex.pick = null; $("pop").hidden = true; placeExMarks(); });
["pointerdown", "pointerup", "wheel"].forEach((t) => $("pop").addEventListener(t, (e) => e.stopPropagation()));
exBox.querySelectorAll(".zb").forEach((b) => b.addEventListener("pointerdown", (e) => e.stopPropagation()));

// ---- playback (stops at the ends, like the design)
const SPEED_LIST = [0.25, 0.5, 1, 1.5, 2, 3];
const speedLabel = (s) => s.toFixed(s < 1 ? 2 : 1) + "x";
function frameMs() { return BASE_FRAME_MS / SPEED_LIST[ex.speedIdx]; }
function nextLoadable(from, dir) {
  for (let i = from + dir; i >= 0 && i < ex.frames.length; i += dir) if (!ex.frames[i].failed) return i;
  return -1;
}
function go(i) {
  if (!ex.frames.length) return;
  ex.current = Math.max(0, Math.min(ex.frames.length - 1, i));
  if (ex.frames[ex.current].failed) toast("This observation could not be loaded from IRSA");
  showFrame();
  if (ex.playing) schedule();
}
function schedule() {
  clearTimeout(ex.timer);
  if (!ex.playing) return;
  ex.timer = setTimeout(() => {
    const n = nextLoadable(ex.current, 1);
    if (n < 0) { stop(); toast(`Reached the last observation (${shortDate(ex.frames[ex.current].date).day})`); return; }
    go(n);
  }, frameMs());
}
function play() {
  if (ex.playing || !ex.frames.length) return;
  if (nextLoadable(ex.current, 1) < 0) ex.current = 0;   // at the end: start again
  ex.playing = true; showFrame(); schedule();
}
function stop() { ex.playing = false; clearTimeout(ex.timer); renderBar(); }
function stepFrame(dir) {
  const n = nextLoadable(ex.current, dir);
  if (n < 0) { toast(dir < 0 ? "This is the first observation" : "This is the last observation"); return; }
  go(n);
}
function renderBar() {
  const n = ex.frames.length, k = ex.current;
  $("frameNo").textContent = n ? `${shownIndex() + 1}/${n}` : "0/0";
  $("prev").setAttribute("aria-disabled", String(!n || nextLoadable(k, -1) < 0));
  $("next").setAttribute("aria-disabled", String(!n || nextLoadable(k, 1) < 0));
  $("play").classList.toggle("on", ex.playing); $("play").setAttribute("aria-pressed", String(ex.playing));
  $("pause").setAttribute("aria-pressed", String(!ex.playing));
  $("blinkBtn").setAttribute("aria-pressed", String(ex.blink));
  $("speedSel").value = String(ex.speedIdx);
}
SPEED_LIST.forEach((s, i) => { const o = document.createElement("option"); o.value = i; o.textContent = speedLabel(s); $("speedSel").appendChild(o); });
function setSpeed(i) { ex.speedIdx = Math.max(0, Math.min(SPEED_LIST.length - 1, i)); renderBar(); schedule(); writeHash(ex.target); }
$("speedSel").addEventListener("change", (e) => setSpeed(Number(e.target.value)));
$("faster").addEventListener("click", () => setSpeed(ex.speedIdx + 1));
$("slower").addEventListener("click", () => setSpeed(ex.speedIdx - 1));
$("prev").addEventListener("click", () => { stop(); stepFrame(-1); });
$("next").addEventListener("click", () => { stop(); stepFrame(1); });
$("play").addEventListener("click", play);
$("pause").addEventListener("click", stop);

// ---- blink & difference
function stopBlink() { clearInterval(ex.blinkTimer); ex.blink = false; ex.blinkAlt = false; }
$("blinkBtn").addEventListener("click", () => {
  if (ex.blink) { stopBlink(); showFrame(); return; }
  ex.blink = true; ex.blinkAlt = false;
  ex.blinkTimer = setInterval(() => { ex.blinkAlt = !ex.blinkAlt; showFrame(); }, BLINK_MS);
  showFrame();
});

// ---- GAIA: Gaia DR3 stars from MAST, moved to each frame's date
// Gaia positions are for epoch 2016.0; each star is moved by its proper motion to the date of the
// frame on screen (parallax shifts, at most ~0.8″, are ignored: well under one 6.15″ pixel).
const GAIA_GMAX = 19, GAIA_MATCH_ARCSEC = 6.2, GAIA_HIGH_PM = 100, GAIA_ARROW_YEARS = 10;
const MJD_J2016 = 57388.5;   // Julian epoch 2016.0
const GAIA_COLOR = "#38bdf8";
const gaia = { on: false, data: null, error: null, loading: false, id: 0 };

async function loadGaia(c) {
  const id = ++gaia.id;
  Object.assign(gaia, { data: null, error: null, loading: true });
  drawGaia();
  const radius = Math.min(0.3, Math.hypot(ex.w, ex.h) / 2 / 3600 + 0.01);
  try {
    const d = await getJSON(`api/gaia?ra=${c.ra}&dec=${c.dec}&radius=${radius.toFixed(4)}&gmax=${GAIA_GMAX}`);
    if (id !== gaia.id) return;
    gaia.data = d;
  } catch (e) {
    if (id !== gaia.id) return;
    gaia.error = e.message;
  }
  gaia.loading = false;
  drawGaia(); if (!$("pop").hidden) renderPop();
}
// Star [id, ra, dec, pmra, pmdec, plx, plx_err, G, bp_rp] -> {ra, dec} at the given MJD.
function gaiaAt(st, mjd) {
  const yrs = (mjd - MJD_J2016) / 365.25, dec = st[2] + ((st[4] || 0) * yrs) / 3.6e6;
  return { ra: st[1] + ((st[3] || 0) * yrs) / 3.6e6 / Math.cos((st[2] * Math.PI) / 180), dec };
}
function drawGaia() {
  const cv = $("gaiaCanvas"), lbl = $("gaiaLabel"), r = exView.rect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
  $("gaiaBtn").setAttribute("aria-pressed", String(gaia.on));
  lbl.hidden = !gaia.on;
  if (!gaia.on) return;
  if (gaia.loading) { lbl.textContent = "GAIA DR3 · loading from MAST…"; return; }
  if (gaia.error) { lbl.textContent = "GAIA DR3 · unavailable: " + gaia.error; return; }
  const f = ex.frames[shownIndex()];
  if (!gaia.data || !exView.field || !exView.hasImage || !f) { lbl.textContent = "GAIA DR3"; return; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const fld = exView.field, k = exView.k(), zs = Math.min(1.6, Math.sqrt(exView.z));
  let shown = 0;
  for (const st of gaia.data.stars) {
    const pos = gaiaAt(st, f.mjd), q = skyToPix(fld, pos.ra, pos.dec), p = exView.toScreen(q.ix, q.iy);
    if (p.x < -20 || p.y < -20 || p.x > r.width + 20 || p.y > r.height + 20) continue;
    shown++;
    const rad = Math.max(3.5, Math.min(9, 9 - ((st[7] || 19) - 10) * 0.55)) * zs;
    const pm = Math.hypot(st[3] || 0, st[4] || 0);
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 2 * Math.PI); ctx.stroke();
    ctx.lineWidth = pm >= GAIA_HIGH_PM ? 2 : 1.25; ctx.strokeStyle = GAIA_COLOR;
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 2 * Math.PI); ctx.stroke();
    if (pm >= GAIA_HIGH_PM) {   // arrow: where proper motion carries the star in GAIA_ARROW_YEARS
      const len = ((pm / 1000) * GAIA_ARROW_YEARS / fld.scale) * k;   // screen px
      const ux = -(st[3] || 0) / pm, uy = -(st[4] || 0) / pm;          // east is left, north is up
      const x0 = p.x + ux * rad, y0 = p.y + uy * rad, x1 = p.x + ux * (rad + len), y1 = p.y + uy * (rad + len);
      for (const [w, col] of [[3.5, "rgba(0,0,0,0.6)"], [1.5, GAIA_COLOR]]) {
        ctx.lineWidth = w; ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        const a = Math.atan2(y1 - y0, x1 - x0);
        ctx.moveTo(x1, y1); ctx.lineTo(x1 - 7 * Math.cos(a - 0.45), y1 - 7 * Math.sin(a - 0.45));
        ctx.moveTo(x1, y1); ctx.lineTo(x1 - 7 * Math.cos(a + 0.45), y1 - 7 * Math.sin(a + 0.45));
        ctx.stroke();
      }
    }
  }
  const d = shortDate(f.date);
  lbl.textContent = `GAIA DR3 · G < ${GAIA_GMAX} · ${shown} stars · at ${d.day} ${d.year}` +
    (gaia.data.truncated ? ` · brightest ${gaia.data.stars.length} only` : "") + ` · arrows: ${GAIA_ARROW_YEARS}-yr motion`;
}
// Pop-up rows for the nearest Gaia star to sky position c at the given date.
function gaiaPopRows(c, mjd) {
  const head = `<div class="popsec">GAIA DR3 · MAST</div>`;
  if (gaia.loading) return head + `<div class="popnote">Loading Gaia stars…</div>`;
  if (gaia.error) return head + `<div class="popnote">Gaia unavailable: ${esc(gaia.error)}</div>`;
  if (!gaia.data) return "";
  let best = null, bd = Infinity, n = 0;
  const cosd = Math.cos((c.dec * Math.PI) / 180);
  for (const st of gaia.data.stars) {
    const p = gaiaAt(st, mjd);
    let dra = p.ra - c.ra; if (dra > 180) dra -= 360; if (dra < -180) dra += 360;
    const sep = Math.hypot(dra * cosd, p.dec - c.dec) * 3600;
    if (sep <= GAIA_MATCH_ARCSEC) n++;
    if (sep < bd) { bd = sep; best = st; }
  }
  if (!best || bd > GAIA_MATCH_ARCSEC) {
    return head + `<div class="popnote">No Gaia DR3 star brighter than G ${GAIA_GMAX} within ${GAIA_MATCH_ARCSEC}″ at this date.</div>`;
  }
  const [id, , , pmra, pmdec, plx, plxErr, g, bprp] = best;
  const pm = Math.hypot(pmra || 0, pmdec || 0), pa = ((Math.atan2(pmra || 0, pmdec || 0) * 180) / Math.PI + 360) % 360;
  const good = plx && plxErr && plx / plxErr >= 5 && plx > 0;
  return head + [
    `<div class="prow wide"><div class="k">Gaia DR3 source</div><div class="v">${esc(id)}</div></div>`,
    prow("G magnitude", g != null ? g.toFixed(2) : "—"),
    prow("BP − RP colour", bprp != null ? bprp.toFixed(2) : "—"),
    prow("Parallax", plx != null ? `${plx.toFixed(2)} ± ${(plxErr || 0).toFixed(2)} mas` : "—"),
    prow("Distance", good ? `${(1000 / plx).toFixed(plx > 10 ? 1 : 0)} pc · ${(3261.56 / plx).toFixed(plx > 10 ? 1 : 0)} ly` : "uncertain"),
    prow("Proper motion", pmra != null ? `${pm.toFixed(1)} mas/yr · PA ${pa.toFixed(0)}°` : "—"),
    prow("Offset", `${bd.toFixed(1)}″` + (n > 1 ? ` · ${n} stars within ${GAIA_MATCH_ARCSEC}″` : "")),
  ].join("");
}
$("gaiaBtn").addEventListener("click", () => { gaia.on = !gaia.on; drawGaia(); if (ex.target) writeHash(ex.target); });

document.addEventListener("keydown", (e) => {
  if ($("explore").hidden) return;
  if (e.key === "Escape") { if (!$("pop").hidden) $("popClose").click(); return; }
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === " " && e.target.tagName === "BUTTON") return;
  if (e.key === "ArrowLeft") { stop(); stepFrame(-1); }
  else if (e.key === "ArrowRight") { stop(); stepFrame(1); }
  else if (e.key === " ") { e.preventDefault(); ex.playing ? stop() : play(); }
});

$("back").addEventListener("click", (e) => {
  e.preventDefault();
  stop(); stopBlink(); ex.searchId++; gaia.id++;
  history.replaceState(null, "", location.pathname + location.search);
  $("explore").hidden = true; $("pick").hidden = false;
  const c = ex.target;
  requestAnimationFrame(() => {
    if (c) {
      setPick(c, true);
      const p = pvView.field && skyToPix(pvView.field, c.ra, c.dec);
      if (!p || !pvView.inside(p.ix, p.iy) || $("band").value !== pk.band) loadPreview(c);
    }
    pvView.draw();
  });
});

// ======================================================================
// Shareable URL (like WiseView's #ra=...&dec=...)
// ======================================================================
function writeHash(c) {
  if (!c) return;
  const p = new URLSearchParams();
  p.set("ra", +c.ra.toFixed(6)); p.set("dec", +c.dec.toFixed(6));
  p.set("size", heightArcsec() || 240); p.set("band", $("band").value);
  p.set("speed", SPEED_LIST[ex.speedIdx]);
  if (gaia.on) p.set("gaia", 1);
  history.replaceState(null, "", "#" + p.toString());
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has("band") && BANDS[p.get("band")]) $("band").value = p.get("band");
  if (p.has("size")) {   // stored in arcsec
    const m = Math.round(Number(p.get("size")) / 60);
    if (m >= 1) $("size").value = Math.min(10, m);
  }
  if (p.has("speed")) {
    let s = Number(p.get("speed"));
    if (s > 10) s = BASE_FRAME_MS / s;     // older links stored milliseconds per frame
    let best = 2; SPEED_LIST.forEach((x, i) => { if (Math.abs(x - s) < Math.abs(SPEED_LIST[best] - s)) best = i; });
    ex.speedIdx = best;
  }
  gaia.on = p.get("gaia") === "1";
  const ra = p.has("ra") ? parseRA(p.get("ra")) : null, dec = p.has("dec") ? parseDec(p.get("dec")) : null;
  return ra !== null && dec !== null ? { ra, dec } : null;
}

// ======================================================================
// Start
// ======================================================================
(function start() {
  const c = readHash();
  $("size").dispatchEvent(new Event("input"));
  renderBar();
  if (c) {
    $("ra").value = c.ra.toFixed(5); $("dec").value = (c.dec >= 0 ? "+" : "") + c.dec.toFixed(5);
    pk.pick = c; pk.center = { ...c }; updateHints(); updatePickLabel();
    openExplore(c);
  } else {
    const s = PRESETS.find((p) => p.name === START_PRESET);
    setPick({ ra: s.ra, dec: s.dec }, true);
    loadPreview(s);
  }
})();
