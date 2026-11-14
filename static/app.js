"use strict";

// ======================================================================
// Anvis – SPHEREx time viewer (frontend).
// Page 1: pick a position on a real SPHEREx image (or type it).
// Page 2: flip through every SPHEREx image of that position in time order.
// All pixels come from IRSA through this app's backend (/api/frames, /api/cutout).
// ======================================================================

const MAX_FRAMES = 300;          // if more images exist, show this many spread evenly in time
const PARALLEL = 6;              // simultaneous cutout requests
const WIDTH_RATIO = 2.5;         // explore field: width = 2.5 x height
const PREVIEW = { h: 630, w: 1800 };   // page-1 sky preview, arcsec (10.5' x 30')
const DEFAULT_POS = { ra: 270.0, dec: 66.560708 };  // North Ecliptic Pole: a SPHEREx deep field
const BASE_FRAME_MS = 500;       // 1.0x playback speed
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3];
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
      if (b.dataset.zoom === "reset") this.resetView();
      else this.zoomAt(r.width / 2, r.height / 2, this.z * (b.dataset.zoom === "in" ? 1.5 : 1 / 1.5));
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
  resetView() { this.z = 1; this.tx = 0; this.ty = 0; this.fitClamp(); this.draw(); }
  zoomAt(x, y, nz) {
    if (!this.field) return;
    nz = Math.max(1, Math.min(8, nz));
    const p = this.toImage(x, y); this.z = nz;
    const k = this.k(); this.tx = x - p.ix * k; this.ty = y - p.iy * k;
    this.fitClamp(); this.draw();
  }

  down(e) {
    if (e.button !== 0 || !this.field) return;
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
    this.zoomScope.querySelector(".zpct").textContent = Math.round(this.z * 100) + "%";
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
const shortDate = (d) => {   // "2025-05-10 17:04:37" -> { day: "10 May", year: "2025", time: "17:04" }
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(d) || [];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(+m[2] || 1) - 1];
  return { day: `${+m[3]} ${mon}`, year: m[1], time: m[4] };
};

// ======================================================================
// Page 1 – select coordinates
// ======================================================================
const sel = {
  center: { ...DEFAULT_POS },   // preview centre
  pick: null,                   // selected { ra, dec }
  loadId: 0,
};
const pvBox = $("pvSky");
const pvView = new SkyView(pvBox, $("select"), {
  onHover: (h) => pvHover(h),
  onPick: (q) => { const c = pixToSky(pvView.field, q.ix, q.iy); setPick(c, true); },
  onChange: () => placePick(),
});

async function loadPreview(center) {
  const id = ++sel.loadId, band = $("band").value;
  sel.center = { ...center }; sel.band = band;
  $("pvTitle").textContent = "Sky preview";
  $("pvSub").textContent = `Centre RA ${fmtRA(center.ra)} · Dec ${fmtDec(center.dec)} · 6.15″ per pixel · North up, East left`;
  $("pvMsg").hidden = false; $("pvMsg").textContent = "Loading a SPHEREx image from IRSA…";
  $("pvCredit").textContent = "";
  try {
    const list = await getJSON(framesURL(center.ra, center.dec, band));
    if (id !== sel.loadId) return;
    if (!list.frames.length) throw new Error(`No SPHEREx ${band.slice(-2)} image covers this position yet.`);
    const f = list.frames[list.frames.length - 1];      // the most recent image
    const cut = await getJSON(cutoutURL(f, center.ra, center.dec, PREVIEW.h, PREVIEW.w));
    if (id !== sel.loadId) return;
    pvView.setImage(cut, center.ra, center.dec, { minb: 1, maxb: 99.5, invert: false });
    $("pvMsg").hidden = true;
    $("pvCredit").innerHTML = `SPHEREx ${esc(band.slice(-2))} · ${esc(f.obs_id)} · ${esc(f.date.slice(0, 10))} · ` +
      `<a href="${encodeURI(f.url)}" target="_blank" rel="noopener">original file at IRSA</a>`;
    placePick(); refreshSelInfo();
  } catch (e) {
    if (id !== sel.loadId) return;
    pvView.clearImage();
    $("pvMsg").hidden = false; $("pvMsg").textContent = "Could not load a preview image: " + e.message;
  }
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
  tag.innerHTML = `<b>N</b>  Dec ${esc(fmtDec(c.dec))}  ${esc(degDec(c.dec))}\n<b>E</b>  RA  ${esc(fmtRA(c.ra))}  ${esc(degRA(c.ra))}\n<i>px ${Math.floor(h.ix)}, ${Math.floor(h.iy)}</i>`;
  tag.style.left = h.x + "px"; tag.style.top = h.y + "px";
  tag.style.transform = (h.x > r.width * 0.7 ? "translate(calc(-100% - 14px), " : "translate(14px, ") +
                        (h.y > r.height * 0.62 ? "calc(-100% - 14px))" : "14px)");
}

function placePick() {
  const m = pvBox.querySelector(".selmark");
  if (!sel.pick || !pvView.field) { m.hidden = true; return; }
  const p = skyToPix(pvView.field, sel.pick.ra, sel.pick.dec);
  if (pvView.inside(p.ix, p.iy)) pvView.place(m, p.ix, p.iy); else m.hidden = true;
}

function refreshSelInfo() {
  $("selNone").hidden = !!sel.pick; $("selSome").hidden = !sel.pick;
  if (!sel.pick) return;
  $("sRa").textContent = fmtRA(sel.pick.ra); $("sDec").textContent = fmtDec(sel.pick.dec);
  const p = pvView.field ? skyToPix(pvView.field, sel.pick.ra, sel.pick.dec) : null;
  const inside = p && pvView.inside(p.ix, p.iy);
  $("sPx").textContent = inside ? `${Math.floor(p.ix)}, ${Math.floor(p.iy)}` : "outside image";
  $("selNote").textContent = inside
    ? "Search finds every SPHEREx observation covering this position, in time order."
    : "Outside this preview — Search will still query SPHEREx at these coordinates.";
}

function setPick(c, fillInputs) {
  sel.pick = c;
  if (fillInputs) {
    $("ra").value = c.ra.toFixed(5); $("dec").value = (c.dec >= 0 ? "+" : "") + c.dec.toFixed(5);
    $("err").hidden = true;
  }
  updateHints(); placePick(); refreshSelInfo();
}

function updateHints() {
  const ra = parseRA($("ra").value), dec = parseDec($("dec").value);
  $("raHint").textContent = ra !== null ? `= ${fmtRA(ra)}` : "Degrees, or hours: hh mm ss";
  $("decHint").textContent = dec !== null ? `= ${fmtDec(dec)}` : "Degrees, or ±dd mm ss";
}

function typedPosition(report) {
  const rs = $("ra").value, ds = $("dec").value, ra = parseRA(rs), dec = parseDec(ds);
  let err = "";
  if (rs.trim() && ra === null) err = "RA must be 0–360° or hh mm ss.";
  else if (ds.trim() && dec === null) err = "Dec must be −90° to +90° or ±dd mm ss.";
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
$("ra").addEventListener("input", updateHints);
$("dec").addEventListener("input", updateHints);
$("ra").addEventListener("change", onTyped);
$("dec").addEventListener("change", onTyped);
$("band").addEventListener("change", () => loadPreview(sel.center));
$("size").addEventListener("input", () => {
  const h = Number($("size").value);
  $("sizeHint").textContent = h >= 60 && h <= 600
    ? `Field ${fmtArc(h * WIDTH_RATIO)} × ${fmtArc(h)} · 60–600 arcsec`
    : "60–600 arcsec · width is 2.5 × height";
});
$("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const c = typedPosition(true);
  if (!c) return;
  const size = Number($("size").value);
  if (!(size >= 60 && size <= 600)) { $("err").hidden = false; $("err").textContent = "Field height must be 60–600 arcsec."; return; }
  ex.speed = ex.speed || 1;
  writeHash(c);
  openExplore(c);
});

// Preset targets. Coordinates are ICRS, in degrees.
// Source: SIMBAD (basic table), queried 2026-11-14 via its official mirror
// simbad.cfa.harvard.edu, because simbad.cds.unistra.fr was unavailable.
// WISE 0855 uses the coordinates given in the project brief.
// Barnard's Star and Epsilon Indi B move fast, so their J2000 positions were moved to epoch
// 2026.0 using SIMBAD's proper motion, parallax and radial velocity (none listed for eps Ind B;
// 0 used). RW Aur and R Dra are SIMBAD J2000 positions (slow movers).
const PRESETS = [
  { name: "WISE 0855",      ra: 133.795129, dec: -7.245147 },
  { name: "Barnard's Star", ra: 269.446259, dec: 4.768324 },   // SIMBAD "NAME Barnard's star"; J2000 269.452077, +4.693365
  { name: "Epsilon Indi B", ra: 331.096669, dec: -56.800649 }, // SIMBAD "* eps Ind B"; J2000 331.044147, -56.782844
  { name: "RW Aurigae",     ra: 76.956526,  dec: 30.401438 },  // SIMBAD "V* RW Aur"
  { name: "R Draconis",     ra: 248.167611, dec: 66.754979 },  // SIMBAD "V* R Dra"
];
PRESETS.forEach((t) => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "tb reset"; b.textContent = t.name;
  b.addEventListener("click", () => {
    $("ra").value = t.ra.toFixed(6);
    $("dec").value = (t.dec >= 0 ? "+" : "") + t.dec.toFixed(6);
    $("size").value = 600; $("band").value = "SPHEREx-D3";
    $("size").dispatchEvent(new Event("input"));   // refresh the size hint
    updateHints();
    $("search").requestSubmit();                    // same path as clicking Search
  });
  $("presets").appendChild(b);
});

// ======================================================================
// Page 2 – explore observations
// ======================================================================
const ex = {
  target: null, band: "", h: 0, w: 0,
  frames: [], current: 0, timer: null, playing: false, speed: 1,
  pick: null,          // { ix, iy } field pixel the user clicked
  searchId: 0, listTotal: 0, done: 0, failed: 0, finished: false,
};
const exBox = $("exSky");
const exView = new SkyView(exBox, $("explore"), {
  onPick: (q) => { ex.pick = q; renderAbout(); placeExMarks(); },
  onChange: () => placeExMarks(),
});

function display() {
  return { minb: Number($("minb").value), maxb: Number($("maxb").value), invert: $("invert").checked };
}

async function openExplore(c) {
  stop();
  $("select").hidden = true; $("explore").hidden = false;
  $("step1").classList.remove("on"); $("step2").classList.add("on");
  window.scrollTo(0, 0);

  const id = ++ex.searchId;
  Object.assign(ex, { target: c, band: $("band").value, h: Number($("size").value), frames: [], current: 0,
                      pick: null, listTotal: 0, done: 0, failed: 0, finished: false });
  ex.w = Math.min(1800, Math.round(ex.h * WIDTH_RATIO));
  $("exTitle").textContent = `RA ${fmtRA(c.ra)} · Dec ${fmtDec(c.dec)}`;
  $("strip").innerHTML = ""; $("exCredit").textContent = ""; $("fiObs").textContent = ""; $("fiLam").textContent = "";
  exView.field = null; exView.clearImage();
  exMsg("Searching IRSA for SPHEREx images…");
  setStatus("Searching IRSA for SPHEREx images…");
  renderAbout(); renderPlayback();

  let list;
  try { list = await getJSON(framesURL(c.ra, c.dec, ex.band)); }
  catch (e) { if (id === ex.searchId) { exMsg("Search failed: " + e.message); setStatus("Search failed: " + e.message); } return; }
  if (id !== ex.searchId) return;

  let all = list.frames;
  ex.listTotal = all.length;
  if (!all.length) { exMsg(`No SPHEREx ${ex.band.slice(-2)} images cover this position yet.`); setStatus("No observations found."); return; }
  if (all.length > MAX_FRAMES) {
    const step = all.length / MAX_FRAMES;
    all = Array.from({ length: MAX_FRAMES }, (_, i) => all[Math.floor(i * step)]);
  }
  ex.frames = all.map((f) => ({ ...f, cut: null, failed: false }));
  buildStrip(); exMsg("Loading images…"); progress(); renderPlayback();

  // Download cutouts in time order, a few at a time; give failed ones one more try at the end.
  let queue = ex.frames.slice();
  async function worker() {
    while (queue.length && id === ex.searchId) {
      const f = queue.shift();
      try {
        f.cut = await getJSON(cutoutURL(f, c.ra, c.dec, ex.h, ex.w));
        if (f.failed) { f.failed = false; ex.failed--; }
        ex.done++;
      } catch {
        if (!f.failed) { f.failed = true; ex.failed++; }
      }
      if (id !== ex.searchId) return;
      progress(); updateChip(ex.frames.indexOf(f));
      if (ex.frames[ex.current] === f) showFrame();
    }
  }
  for (let pass = 0; pass < 2 && id === ex.searchId; pass++) {
    if (pass === 1) queue = ex.frames.filter((f) => f.failed);
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }
  if (id !== ex.searchId) return;
  ex.finished = true; progress();
  if (!ex.frames[ex.current].cut) { const first = ex.frames.findIndex((f) => f.cut); if (first >= 0) go(first); }
}

function setStatus(t) { $("status").textContent = t; }
function exMsg(t) { $("exMsg").hidden = !t; $("exMsg").textContent = t || ""; }
function progress() {
  const fr = ex.frames, a = shortDate(fr[0].date), b = shortDate(fr[fr.length - 1].date);
  const range = a.year === b.year ? `${a.day} – ${b.day} ${b.year}` : `${a.day} ${a.year} – ${b.day} ${b.year}`;
  const shown = ex.listTotal > fr.length ? ` (showing ${fr.length}, spread evenly in time)` : "";
  const load = ex.finished ? (ex.failed ? ` · ${ex.failed} could not be loaded` : "")
                           : ` · loading ${ex.done} of ${fr.length}…`;
  setStatus(`${ex.listTotal} SPHEREx observations found${shown} · ${range} · Band ${ex.band.slice(-2)} (${BANDS[ex.band]}) · field ${fmtArc(ex.w)} × ${fmtArc(ex.h)}${load}`);
}

// ---- frame strip
function buildStrip() {
  const strip = $("strip"); strip.innerHTML = "";
  ex.frames.forEach((f, i) => {
    const d = shortDate(f.date), b = document.createElement("button");
    b.type = "button"; b.className = "fr";
    b.setAttribute("aria-label", `Show observation ${i + 1}, ${d.day} ${d.year} ${d.time} UTC`);
    b.innerHTML = `<b>${i + 1}</b><span>${esc(d.day)} ${esc(d.year)}</span><span>${esc(d.time)} UTC</span>`;
    b.addEventListener("click", () => { go(i); });
    strip.appendChild(b);
  });
  updateStrip();
}
function updateChip(i) {
  const b = $("strip").children[i]; if (!b) return;
  b.classList.toggle("on", i === ex.current);
  b.classList.toggle("past", i < ex.current);
  b.classList.toggle("bad", ex.frames[i].failed);
}
function updateStrip() {
  const strip = $("strip");
  for (let i = 0; i < strip.children.length; i++) updateChip(i);
  const b = strip.children[ex.current];
  if (b) {   // keep the current chip in view without scrolling the page
    const l = b.offsetLeft - strip.offsetLeft, r = l + b.offsetWidth;
    if (l < strip.scrollLeft) strip.scrollLeft = l - 6;
    else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r - strip.clientWidth + 6;
  }
}

// ---- current frame
function showFrame() {
  const f = ex.frames[ex.current]; if (!f) return;
  const d = shortDate(f.date);
  $("fiObs").textContent = `Obs ${ex.current + 1} of ${ex.frames.length} · ${d.day} ${d.year} · ${d.time} UTC`;
  $("fiLam").textContent = f.cut && f.cut.wavelength_um
    ? `λ ${f.cut.wavelength_um.toFixed(3)} µm · Band ${ex.band.slice(-2)}` : `Band ${ex.band.slice(-2)}`;
  $("exCredit").innerHTML = `SPHEREx ${esc(f.collection.replace("spherex_", "").toUpperCase())} · ${esc(f.obs_id)} · ` +
    `<a href="${encodeURI(f.url)}" target="_blank" rel="noopener">Original image file at IRSA (FITS)</a>`;
  if (f.cut) { exView.setImage(f.cut, ex.target.ra, ex.target.dec, display()); exMsg(""); }
  else { exView.clearImage(); exMsg(f.failed ? "This observation could not be loaded from IRSA." : "Loading this observation…"); }
  updateStrip(); renderAbout(); renderPlayback(); placeExMarks();
}
function placeExMarks() {
  const t = exBox.querySelector(".target"), pk = exBox.querySelector(".pick");
  if (!exView.field) { t.hidden = pk.hidden = true; return; }
  exView.place(t, exView.field.nx / 2, exView.field.ny / 2);
  if (ex.pick) {
    const p = exView.place(pk, ex.pick.ix, ex.pick.iy);
    pk.classList.toggle("flip", p.x > exView.rect().width * 0.75);
    pk.querySelector(".tag").textContent = "Selected";
  } else pk.hidden = true;
}

// ---- "About this position"
function row(k, v, s) {
  return `<div class="row"><div class="k">${esc(k)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
}
function renderAbout() {
  const has = !!(ex.pick && exView.field);
  $("abEmpty").hidden = has; $("abSel").hidden = !has;
  if (!has) return;
  const fld = exView.field, c = pixToSky(fld, ex.pick.ix, ex.pick.iy);
  $("abId").textContent = `RA ${fmtRA(c.ra)} · Dec ${fmtDec(c.dec)}`;
  const f = ex.frames[ex.current], d = shortDate(f.date);
  const px = Math.min(fld.nx - 1, Math.floor(ex.pick.ix)), py = Math.min(fld.ny - 1, Math.floor(ex.pick.iy));
  const val = f.cut ? f.cut.data[py * f.cut.width + px] : undefined;
  // Offset from the searched position, and position angle (east of north).
  const de = -(ex.pick.ix - fld.nx / 2) * fld.scale, dn = (fld.ny / 2 - ex.pick.iy) * fld.scale;
  const off = Math.hypot(de, dn), pa = ((Math.atan2(de, dn) * 180 / Math.PI) + 360) % 360;
  const rows = [
    row("Right Ascension", esc(fmtRA(c.ra)), esc(degRA(c.ra))),
    row("Declination", esc(fmtDec(c.dec)), esc(degDec(c.dec))),
    row("Surface brightness", val === undefined ? "—" : val === null ? "no data" : `${val.toFixed(3)} MJy/sr`,
        `Zodi-subtracted · observation ${ex.current + 1}`),
    row("Observation", `${ex.current + 1} of ${ex.frames.length}`, esc(`${d.day} ${d.year} · ${d.time} UTC · MJD ${f.mjd.toFixed(4)}`)),
    row("Wavelength", f.cut && f.cut.wavelength_um ? `${f.cut.wavelength_um.toFixed(3)} µm` : "—",
        esc(`Band ${ex.band.slice(-2)} (${BANDS[ex.band]})`)),
    row("Image pixel", `${px}, ${py}`, `Field pixel (x, y) · ${fld.scale}″ each`),
    row("Offset from target", off < 0.05 ? "0″" : `${off.toFixed(1)}″`, off < 0.05 ? "At the searched position" : `Toward PA ${pa.toFixed(0)}°`),
    row("Observation ID", esc(f.obs_id), esc(`SPHEREx ${f.collection.replace("spherex_", "").toUpperCase()}`)),
    row("Source file", `<a href="${encodeURI(f.url)}" target="_blank" rel="noopener">FITS at IRSA</a>`, "Official NASA/IPAC archive"),
  ];
  $("abRows").innerHTML = rows.join("");
  $("abNoData").hidden = val !== null;
  $("abNoDataTitle").textContent = `No data in observation ${ex.current + 1} (${d.day} ${d.year} · ${d.time} UTC)`;
}
$("clearSel").addEventListener("click", () => { ex.pick = null; renderAbout(); placeExMarks(); });

// ---- playback
function go(i) {
  if (!ex.frames.length) return;
  ex.current = ((i % ex.frames.length) + ex.frames.length) % ex.frames.length;
  showFrame();
  if (ex.playing) schedule();
}
function step(dir) {   // skips frames that failed to load
  const n = ex.frames.length;
  for (let k = 1; k <= n; k++) {
    const i = (((ex.current + dir * k) % n) + n) % n;
    if (!ex.frames[i].failed) return go(i);
  }
}
function schedule() {
  clearTimeout(ex.timer);
  if (ex.playing) ex.timer = setTimeout(() => step(1), BASE_FRAME_MS / ex.speed);
}
function play() { if (!ex.frames.length) return; ex.playing = true; renderPlayback(); schedule(); }
function stop() { ex.playing = false; clearTimeout(ex.timer); renderPlayback(); }
function renderPlayback() {
  $("play").classList.toggle("on", ex.playing);
  $("play").setAttribute("aria-pressed", String(ex.playing));
  $("pause").setAttribute("aria-pressed", String(!ex.playing));
  const n = ex.frames.length;
  $("pbStatus").textContent = n
    ? `${ex.playing ? "Playing" : "Paused"} · frame ${ex.current + 1} / ${n} · ${(BASE_FRAME_MS / ex.speed / 1000).toFixed(2)} s per frame`
    : "No frames yet";
  $("speedLbl").textContent = ex.speed.toFixed(ex.speed % 1 && ex.speed < 1 ? 2 : 1) + "x";
  $("speeds").querySelectorAll(".sp").forEach((b) => {
    const on = Number(b.dataset.s) === ex.speed;
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
  });
}
SPEEDS.forEach((s) => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "sp"; b.dataset.s = s;
  b.textContent = s.toFixed(s % 1 && s < 1 ? 2 : 1) + "x";
  b.addEventListener("click", () => { ex.speed = s; renderPlayback(); schedule(); writeHash(ex.target); });
  $("speeds").appendChild(b);
});
$("prev").addEventListener("click", () => { stop(); step(-1); });
$("next").addEventListener("click", () => { stop(); step(1); });
$("play").addEventListener("click", play);
$("pause").addEventListener("click", stop);
["minb", "maxb", "invert"].forEach((id) => $(id).addEventListener("input", () => {
  const f = ex.frames[ex.current];
  if (f && f.cut) exView.setImage(f.cut, ex.target.ra, ex.target.dec, display());
  writeHash(ex.target);
}));
document.addEventListener("keydown", (e) => {
  if ($("explore").hidden || /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName) && e.key === " ") return;
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === "ArrowLeft") { stop(); step(-1); }
  else if (e.key === "ArrowRight") { stop(); step(1); }
  else if (e.key === " ") { e.preventDefault(); ex.playing ? stop() : play(); }
});

$("back").addEventListener("click", (e) => {
  e.preventDefault();
  stop(); ex.searchId++;
  history.replaceState(null, "", location.pathname + location.search);
  $("explore").hidden = true; $("select").hidden = false;
  $("step2").classList.remove("on"); $("step1").classList.add("on");
  const c = ex.target;
  if (c) {
    setPick(c, true);
    const p = pvView.field && skyToPix(pvView.field, c.ra, c.dec);
    if (!p || !pvView.inside(p.ix, p.iy) || $("band").value !== sel.band) loadPreview(c);
  }
  requestAnimationFrame(() => pvView.draw());
});

// ======================================================================
// Shareable URL (like WiseView's #ra=...&dec=...)
// ======================================================================
function writeHash(c) {
  const p = new URLSearchParams();
  p.set("ra", +c.ra.toFixed(6)); p.set("dec", +c.dec.toFixed(6));
  p.set("size", $("size").value); p.set("band", $("band").value);
  p.set("speed", ex.speed); p.set("minb", $("minb").value); p.set("maxb", $("maxb").value);
  p.set("invert", $("invert").checked ? 1 : 0);
  history.replaceState(null, "", "#" + p.toString());
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has("band") && BANDS[p.get("band")]) $("band").value = p.get("band");
  if (p.has("size")) $("size").value = p.get("size");
  ["minb", "maxb"].forEach((k) => { if (p.has(k)) $(k).value = p.get(k); });
  if (p.has("invert")) $("invert").checked = p.get("invert") === "1";
  if (p.has("speed")) {
    let s = Number(p.get("speed"));
    if (s > 10) s = BASE_FRAME_MS / s;     // older links stored milliseconds per frame
    ex.speed = SPEEDS.reduce((a, b) => Math.abs(b - s) < Math.abs(a - s) ? b : a, 1);
  }
  const ra = p.has("ra") ? parseRA(p.get("ra")) : null, dec = p.has("dec") ? parseDec(p.get("dec")) : null;
  return ra !== null && dec !== null ? { ra, dec } : null;
}

// ======================================================================
// Start
// ======================================================================
(function start() {
  const c = readHash();
  $("size").dispatchEvent(new Event("input"));
  renderPlayback();
  if (c) {
    sel.pick = c; sel.center = { ...c };
    $("ra").value = c.ra.toFixed(5); $("dec").value = (c.dec >= 0 ? "+" : "") + c.dec.toFixed(5);
    updateHints();
    openExplore(c);
  } else {
    loadPreview(DEFAULT_POS);
  }
})();
