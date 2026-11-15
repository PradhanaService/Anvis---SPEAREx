"use strict";

// ======================================================================
// Anvis – SPHEREx Sky Explorer (frontend).
// Page 1 (#pick):    choose a position on a whole-sky grid, type it, or use a preset; Search.
// Page 2 (#explore): every SPHEREx image of that position in time order: playback, BLINK,
//                    a Gaia DR3 overlay and an "About" pop-up for any clicked point.
// All pixels come from IRSA through this app's backend (/api/frames, /api/cutout, /api/cutouts);
// Gaia stars come from MAST through /api/gaia.
//
// File layout: constants · coordinates · picture rendering · SkyView (zoom/pan/click viewer)
// · API helpers · presets · page 1 · page 2 (loading, date strip, picture, pop-up, playback,
// BLINK, GAIA, keys, Back) · shareable URL · start-up.
// ======================================================================

const MAX_FRAMES = 300;          // if more images exist, show this many spread evenly in time
const MAX_WIDTH = 1800;           // arcsec: widest field the backend serves (30')
const BASE_FRAME_MS = 500;       // 1.0x playback speed
const BLINK_MS = 450;            // BLINK alternates frames this often
const DISPLAY = { minb: 1, maxb: 99.5, invert: false };   // brightness limits (percentiles of each frame)
const BANDS = {
  "SPHEREx-D1": "0.75–1.09 µm", "SPHEREx-D2": "1.10–1.62 µm", "SPHEREx-D3": "1.63–2.41 µm",
  "SPHEREx-D4": "2.42–3.82 µm", "SPHEREx-D5": "3.83–4.41 µm", "SPHEREx-D6": "4.42–5.00 µm",
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- coordinates
// parseRA / parseDec (typed coordinates -> degrees) are in anvis-math.js, where they are tested.
const p2 = (n) => String(n).padStart(2, "0");
function fmtRA(ra) {
  const t = Math.round((((ra % 360) + 360) % 360) / 15 * 36000) % 864000;
  return `${p2(Math.floor(t / 36000))}h ${p2(Math.floor((t % 36000) / 600))}m ${((t % 600) / 10).toFixed(1).padStart(4, "0")}s`;
}
function fmtDec(d) {
  const t = Math.round(Math.abs(d) * 3600);
  return `${d < 0 ? "−" : "+"}${p2(Math.floor(t / 3600))}° ${p2(Math.floor((t % 3600) / 60))}′ ${p2(t % 60)}″`;
}
// Arcseconds as "4′" (60″ or more) or "30″".
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

// Diverging colour map for difference images (DIFF): zero is the neutral background gray,
// positive (brighter now) runs to yellow, negative (fainter now) to blue. Colours are from the
// palette; yellow / blue stay distinct for colour-blind viewers. Values are scaled by asinh like
// the normal stretch, so small changes are still visible.
const DIVERGING = { neg: [56, 189, 248], mid: [38, 38, 38], pos: [255, 210, 63], stretch: 3 };

// A no-data pixel whose borrowed neighbour is at least this far up the brightness range (0–1)
// is taken to be a saturated star core.
const SATURATED_LEVEL = 0.85;

// Upsample a w x h frame to OW x OH (bicubic, clamped so stars get no halos) with the stretch applied.
// cmap (optional): DIVERGING, drawn symmetric about the middle of lo..hi instead of in grays.
function drawFrame(w, h, data, lo, hi, invert, OW, OH, cmap) {
  // No-data pixels borrow their nearest valid neighbour (up to 8 pixels in) for interpolation.
  // They are drawn as "no data" below – except inside a bright star: a saturated star core has
  // no valid pixels (the detector overflowed), and is drawn bright like the rest of the star.
  const vals = new Float32Array(w * h), valid = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) { valid[i] = data[i] !== null ? 1 : 0; vals[i] = valid[i] ? data[i] : lo; }
  // Each pass fills the missing pixels next to a known one (measured or filled in an earlier
  // pass), so the fill grows one pixel inwards per pass.
  const known = valid.slice();
  for (let pass = 0; pass < 8; pass++) {
    const next = known.slice();
    let grew = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (known[i]) continue;
      const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].find(([a, b]) => a >= 0 && b >= 0 && a < w && b < h && known[b * w + a]);
      if (nb) { vals[i] = vals[nb[1] * w + nb[0]]; next[i] = 1; grew = true; }
    }
    known.set(next);
    if (!grew) break;
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
      let v = 0;
      for (let k = 0; k < 4; k++) v += rows[ty.idx[oy * 4 + k] * OW + ox] * ty.wts[oy * 4 + k];
      const a = rows[y1 * OW + ox], b = rows[y2 * OW + ox];
      v = Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
      // No data: dark brown, unless it is the saturated middle of a bright star (surrounded by
      // pixels at the top of the brightness range), which is drawn like the star around it.
      if (cover < 0.5 && (cmap || (v - lo) / range < SATURATED_LEVEL)) {
        img.data[p] = 70; img.data[p + 1] = 40; img.data[p + 2] = 40; img.data[p + 3] = 255; continue;
      }
      if (cmap) {
        const t = Math.min(1, Math.max(-1, (2 * (v - lo)) / range - 1)), end = t < 0 ? cmap.neg : cmap.pos;
        const a = Math.asinh(cmap.stretch * Math.abs(t)) / Math.asinh(cmap.stretch);
        for (let c = 0; c < 3; c++) img.data[p + c] = Math.round(cmap.mid[c] + (end[c] - cmap.mid[c]) * a);
        img.data[p + 3] = 255; continue;
      }
      const t = Math.min(1, Math.max(0, (v - lo) / range));
      let g = Math.round((255 * Math.asinh(STRETCH * t)) / STRETCH_NORM);
      if (invert) g = 255 - g;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = g; img.data[p + 3] = 255;
    }
  }
  return img;
}

// ---------------------------------------------------------------- sky viewer (zoom, pan, hover, click)
// One SkyView per page. It draws a frame (from setImage) into the box's canvas and handles zoom
// (buttons in zoomScope, mouse wheel), drag-to-pan, hover and click-to-pick.
// Coordinates: "image" pixels (ix, iy) run 0..nx / 0..ny over the frame, north up; "screen"
// pixels are CSS px in the box. screen = t + image * k, where k = base fit scale × zoom.
// Callbacks: onHover({ix, iy, x, y} | null), onPick({ix, iy}), onChange() after every redraw.
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
    if (e.button !== 0 || !this.field || e.target.closest("a, button, .pop, .curve")) return;
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
  // display: {minb, maxb} percentiles for the brightness range, or range: [lo, hi] to fix it;
  // invert; cmap (optional colour map, see drawFrame).
  setImage(cut, ra, dec, display) {
    const newGeom = !this.field || this.field.nx !== cut.width || this.field.ny !== cut.height;
    this.field = { nx: cut.width, ny: cut.height, scale: cut.pixel_scale_arcsec || 6.15, ra, dec };
    if (newGeom) { this.z = 1; this.tx = 0; this.ty = 0; }
    let lo, hi;
    if (display.range) [lo, hi] = display.range;
    else {
      const finite = cut.data.filter((v) => v !== null).sort((a, b) => a - b);
      lo = percentile(finite, display.minb); hi = percentile(finite, display.maxb);
    }
    if (hi <= lo) hi = lo + 1e-6;
    // Render at about the box's device resolution (capped for speed); zoom scales this picture.
    const r = this.rect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    let f = Math.max(1, Math.min(r.width * dpr / cut.width, r.height * dpr / cut.height) || 1);
    f = Math.min(f, Math.sqrt(1.2e6 / (cut.width * cut.height)));
    const OW = Math.max(cut.width, Math.round(cut.width * f)), OH = Math.max(cut.height, Math.round(cut.height * f));
    if (!this.off) this.off = document.createElement("canvas");
    this.off.width = OW; this.off.height = OH;
    this.off.getContext("2d").putImageData(drawFrame(cut.width, cut.height, cut.data, lo, hi, display.invert, OW, OH, display.cmap), 0, 0);
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
    this.onChange && this.onChange();
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
// An error message in plain words: IRSA / MAST being busy or down is said as such.
function plainError(e, who = "NASA's IRSA archive") {
  const m = String((e && e.message) || e || "");
  if (/busy|unavailable|timed? ?out|50[234]|proxy|failed to fetch|network/i.test(m)) return `${who} is busy or not answering right now. Please try again in a minute.`;
  return m;
}
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
// POST one survey epoch's image URLs to /api/stack; resolves to the co-added frame.
async function fetchStack(item, c) {
  const r = await fetch(`api/stack?ra=${c.ra}&dec=${c.dec}&size=${ex.h}&width=${ex.w}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: item.urls }),
  });
  let j; try { j = await r.json(); } catch { throw new Error(r.statusText || "Bad response"); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Months an epoch spans: "May 2025", "May–Jun 2025" or "Dec 2025–Jan 2026".
function monthRange(a, b) {
  const [ya, ma] = [a.slice(0, 4), MONTHS[+a.slice(5, 7) - 1]], [yb, mb] = [b.slice(0, 4), MONTHS[+b.slice(5, 7) - 1]];
  if (ya !== yb) return `${ma} ${ya}–${mb} ${yb}`;
  return ma === mb ? `${ma} ${ya}` : `${ma}–${mb} ${ya}`;
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

const bandShort = (b) => b.slice(-2);
const sameSky = (a, b) => a && b && Math.abs(a.ra - b.ra) < 1e-5 && Math.abs(a.dec - b.dec) < 1e-5;
const presetAt = (c) => PRESETS.find((p) => sameSky(p, c));

// Field height (arcsec) from the FIELD HEIGHT slider (arcmin, 1–30; the backend allows up to 1800″).
const MAX_HEIGHT_ARCMIN = 30;
function heightArcsec() {
  const m = Number($("size").value);
  return m >= 1 && m <= MAX_HEIGHT_ARCMIN ? Math.round(m * 60) : null;
}
// Explore field width: the explore viewer's shape (pixels stay square), within backend limits.
function exploreWidth(h) {
  // Approximate size of the explore image area (page 2 is hidden while page 1 asks): the window
  // minus the header, control bar and date strip (taller on phones, where the bar wraps).
  const narrow = window.innerWidth <= 760;
  const vw = Math.max(200, window.innerWidth - (narrow ? 18 : 22));
  const vh = Math.max(160, narrow ? window.innerHeight - 300 : Math.max(window.innerHeight, 480) - 172);
  return Math.round(Math.min(MAX_WIDTH, Math.max(h, h * vw / vh)));
}

// ======================================================================
// 01 PICK
// ======================================================================
// pk: page-1 state: pick = the chosen position {ra, dec}.
const pk = { pick: null };

// Highlight the preset button whose position is chosen (if any).
function updatePickLabel() {
  const p = presetAt(pk.pick);
  $("presets").querySelectorAll(".pr").forEach((b) => {
    const on = !!p && b.dataset.name === p.name;
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
  });
}

// Select a position (from a click or typing); optionally write it into the RA/Dec fields.
function setPick(c, fillInputs) {
  pk.pick = c;
  if (fillInputs) {
    $("ra").value = c.ra.toFixed(5); $("dec").value = (c.dec >= 0 ? "+" : "") + c.dec.toFixed(5);
    $("err").hidden = true;
  }
  updateHints(); updatePickLabel(); updateEstimate(); drawMap();
}

function updateHints() {
  const ra = parseRA($("ra").value), dec = parseDec($("dec").value);
  $("raHint").textContent = ra !== null ? `= ${fmtRA(ra)}` : "Degrees, or hh mm ss";
  $("decHint").textContent = dec !== null ? `= ${fmtDec(dec)}` : "Degrees, or ±dd mm ss";
}

// RA/Dec from the fields, or null. Shows an error for bad input (and for empty input if report).
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
  centreMap(c);        // show the typed position on the grid (nothing is downloaded until Search)
}

// ---- whole-sky map: page 1's picture. Nothing is downloaded here; Search fetches the frames.
// A plain black grid of the whole sky (lines only): RA 360° → 0° from left to right (east left,
// as on the images), Dec −90° → +90° from bottom to top. Hover reads RA / Dec; a click chooses
// that spot (fills RA / Dec, marked with a red ring); scroll zooms, drag moves.
const mapBox = $("pvMap"), mapCv = mapBox.querySelector("canvas");
const map = { z: 1, ra0: 180, dec0: 0, drag: null };
function mapSize() { const r = mapBox.getBoundingClientRect(); return { W: r.width, H: r.height, r }; }
function mapScale() { const { W, H } = mapSize(); return Math.min(W / 360, H / 180) * 0.97 * map.z; }   // px per degree
function mapClamp() {
  const { W, H } = mapSize(), s = mapScale(), hw = W / 2 / s, hh = H / 2 / s;
  map.ra0 = 2 * hw >= 360 ? 180 : Math.min(360 - hw, Math.max(hw, map.ra0));
  map.dec0 = 2 * hh >= 180 ? 0 : Math.min(90 - hh, Math.max(-90 + hh, map.dec0));
}
function mapXY(ra, dec) { const { W, H } = mapSize(), s = mapScale(); return { x: W / 2 + (map.ra0 - ra) * s, y: H / 2 - (dec - map.dec0) * s }; }
function mapSky(x, y) { const { W, H } = mapSize(), s = mapScale(); return { ra: map.ra0 - (x - W / 2) / s, dec: map.dec0 - (y - H / 2) / s }; }
const onSky = (c) => c.ra >= 0 && c.ra < 360 && c.dec >= -90 && c.dec <= 90;
function drawMap() {
  if (mapBox.hidden) return;
  mapClamp();
  const { W, H } = mapSize(), dpr = Math.min(2, window.devicePixelRatio || 1), s = mapScale();
  if (mapCv.width !== Math.round(W * dpr) || mapCv.height !== Math.round(H * dpr)) { mapCv.width = Math.round(W * dpr); mapCv.height = Math.round(H * dpr); }
  const c = mapCv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
  const a = mapXY(360, 90), b = mapXY(0, -90);
  c.lineWidth = 1;
  // A light, sparse grid (lines at least ~120 px apart) with small degree labels on the edges.
  const steps = [60, 30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1];
  const raStep = steps.filter((d) => d * s >= 120).pop() || 60, decStep = steps.filter((d) => d * s >= 120).pop() || 60;
  const top = Math.max(0, a.y), bottom = Math.min(H, b.y), left = Math.max(0, a.x), right = Math.min(W, b.x);
  const deg = (v) => `${+v.toFixed(2)}°`;
  c.strokeStyle = "rgba(255,255,255,.10)"; c.fillStyle = "rgba(255,255,255,.45)"; c.font = "10px 'DM Mono', monospace";
  c.textBaseline = "bottom"; c.textAlign = "center";
  for (let ra = 0; ra <= 360 + 1e-9; ra += raStep) {
    const x = mapXY(ra, 0).x; if (x < a.x - 1 || x > b.x + 1) continue;
    c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
    if (x > left + 30 && x < right - 20) c.fillText(deg(ra), x, bottom - 3);          // RA along the bottom edge
  }
  c.textBaseline = "middle"; c.textAlign = "left";
  for (let dec = Math.ceil(-90 / decStep) * decStep; dec <= 90 + 1e-9; dec += decStep) {   // round values, incl. 0°
    const y = mapXY(0, dec).y; if (y < a.y - 1 || y > b.y + 1) continue;
    c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke();
    if (y > top + 8 && y < bottom - 16) c.fillText((dec > 0 ? "+" : "") + deg(dec), left + 4, y - 7);   // Dec along the left edge
  }
  c.textAlign = "start"; c.textBaseline = "alphabetic";
  // While dragging: the area being selected.
  const sel = map.drag && map.drag.moved && map.drag.end;
  if (sel) {
    c.setLineDash([5, 4]); c.strokeStyle = "#ffd23f"; c.lineWidth = 1.5;
    c.strokeRect(sel.x0, sel.y0, sel.x1 - sel.x0, sel.y1 - sel.y0); c.setLineDash([]);
  }
  // The dashed field box: the area Search will fetch (field height × width) around the chosen spot.
  const fh = heightArcsec();
  if (pk.pick && fh && !sel) {
    const hd = fh / 3600 / 2, wd = exploreWidth(fh) / 3600 / 2 / Math.max(0.05, Math.cos((pk.pick.dec * Math.PI) / 180));
    const p0 = mapXY(pk.pick.ra + wd, pk.pick.dec + hd), p1 = mapXY(pk.pick.ra - wd, pk.pick.dec - hd);
    if (p1.x - p0.x >= 6) {
      c.setLineDash([5, 4]); c.strokeStyle = "#ffd23f"; c.lineWidth = 1.5;
      c.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y); c.setLineDash([]);
    }
  }
  if (pk.pick) {
    const p = mapXY(pk.pick.ra, pk.pick.dec);
    c.strokeStyle = "#E03C31"; c.lineWidth = 2; c.beginPath(); c.arc(p.x, p.y, 10, 0, 2 * Math.PI); c.stroke();
  }
}
function mapHover(x, y) {
  const show = x !== null && onSky(mapSky(x, y));
  mapBox.querySelector(".cross-h").hidden = mapBox.querySelector(".cross-v").hidden = !show;
  const tag = mapBox.querySelector(".hovertag"); tag.hidden = !show;
  if (!show) return;
  const { W, H } = mapSize(), q = mapSky(x, y);
  mapBox.querySelector(".cross-h").style.top = y + "px"; mapBox.querySelector(".cross-v").style.left = x + "px";
  tag.innerHTML = `<b>RA </b> ${esc(fmtRA(q.ra))}\n<b>DEC</b> ${esc(fmtDec(q.dec))}`;
  tag.style.left = x + "px"; tag.style.top = y + "px";
  tag.style.transform = (x > W * 0.7 ? "translate(calc(-100% - 14px), " : "translate(14px, ") + (y > H * 0.8 ? "calc(-100% - 14px))" : "14px)");
}
function mapZoomAt(x, y, z) {
  const before = mapSky(x, y);
  map.z = Math.max(1, Math.min(200, z));
  const after = mapSky(x, y);
  map.ra0 += before.ra - after.ra; map.dec0 += before.dec - after.dec;
  drawMap();
}
const mapLocal = (e) => { const r = mapSize().r; return { x: e.clientX - r.left, y: e.clientY - r.top }; };
mapBox.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest("button")) return;
  map.drag = { x: e.clientX, y: e.clientY, moved: false };
  mapBox.setPointerCapture(e.pointerId);
});
mapBox.addEventListener("pointermove", (e) => {
  const d = map.drag, p = mapLocal(e);
  if (d) {
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) { d.moved = true; mapBox.classList.add("dragging"); }
    if (d.moved) {   // dragging selects an area (the box drawn by drawMap)
      const a = mapLocal({ clientX: d.x, clientY: d.y });
      d.end = { x0: Math.min(a.x, p.x), y0: Math.min(a.y, p.y), x1: Math.max(a.x, p.x), y1: Math.max(a.y, p.y) };
      drawMap();
    }
  }
  mapHover(d && d.moved ? null : p.x, p.y);
});
mapBox.addEventListener("pointerup", (e) => {
  const d = map.drag; map.drag = null; mapBox.classList.remove("dragging");
  if (!d) return;
  mapHover(null);
  if (d.moved && d.end) {
    // An area: its centre is the position; its height sets the field height (1′–30′).
    const t = mapSky(d.end.x0, d.end.y0), b = mapSky(d.end.x1, d.end.y1);
    const q = { ra: (t.ra + b.ra) / 2, dec: Math.max(-90, Math.min(90, (t.dec + b.dec) / 2)) };
    if (!onSky(q)) { drawMap(); return; }
    const arcmin = Math.round(Math.abs(t.dec - b.dec) * 60);
    $("size").value = Math.max(1, Math.min(MAX_HEIGHT_ARCMIN, arcmin));
    $("size").dispatchEvent(new Event("input"));
    setPick(q, true);
    return;
  }
  const p = mapLocal(e), q = mapSky(p.x, p.y);
  if (!onSky(q)) return;
  setPick(q, true);        // only chooses the spot; Search fetches the frames
});
mapBox.addEventListener("pointerleave", () => { map.drag = null; mapBox.classList.remove("dragging"); mapHover(null); });
mapBox.addEventListener("wheel", (e) => { e.preventDefault(); const p = mapLocal(e); mapZoomAt(p.x, p.y, map.z * (e.deltaY < 0 ? 1.25 : 1 / 1.25)); }, { passive: false });
new ResizeObserver(() => drawMap()).observe(mapBox);
// Centre the grid on a position (kept within the sky).
function centreMap(c) { map.ra0 = c.ra; map.dec0 = c.dec; drawMap(); }

function runSearch() {      // returns true when the search starts
  const c = typedPosition(true);
  if (!c) return false;
  if (!heightArcsec()) { $("err").hidden = false; $("err").textContent = `Field height should be 1–${MAX_HEIGHT_ARCMIN} arcmin.`; return false; }
  pk.pick = c;
  writeHash(c);
  openExplore(c);
  return true;
}

// ---- Search: the Search button submits the form (see the "submit" listener below).
// Enter in the RA / Dec / Height fields still searches.
["ra", "dec", "size"].forEach((id) => $(id).addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $(id).dispatchEvent(new Event("change")); runSearch(); }
}));

$("ra").addEventListener("input", updateHints);
$("dec").addEventListener("input", updateHints);
$("ra").addEventListener("change", onTyped);
$("dec").addEventListener("change", onTyped);
$("band").addEventListener("change", () => { updatePickLabel(); updateEstimate(); });
$("size").addEventListener("input", () => {
  const h = heightArcsec();
  $("sizeVal").textContent = h ? fmtArc(h) : "";
  $("sizeHint").textContent = h ? `Field ${fmtArc(h)} × ${fmtArc(exploreWidth(h))}` : `1–${MAX_HEIGHT_ARCMIN} arcmin`;
  drawMap(); updateEstimate();
});

// ---- download estimate under the slider: "~59 frames · ~14 MB · larger = slower"
// Frame count: the (cached) IRSA search for the typed position and band. Size: what the server
// downloads from IRSA per frame – a square cutout covering the field's diagonal at any detector
// rotation (see make_frame), with 4 float layers (IMAGE, FLAGS, VARIANCE, ZODI) plus headers.
const estCache = new Map();
let estTimer = null, estId = 0;
function updateEstimate() {
  clearTimeout(estTimer);
  estTimer = setTimeout(async () => {
    const el = $("sizeEst"), h = heightArcsec(), band = $("band").value;
    const ra = parseRA($("ra").value), dec = parseDec($("dec").value);
    if (!h || ra === null || dec === null) { el.textContent = ""; return; }
    const id = ++estId, key = `${ra.toFixed(5)},${dec.toFixed(5)},${band}`;
    let n = estCache.get(key);
    if (n === undefined) {
      el.textContent = "Estimating download…";
      try { n = (await getJSON(framesURL(ra, dec, band))).frames.length; estCache.set(key, n); }
      catch { if (id === estId) el.textContent = ""; return; }
      if (id !== estId) return;
    }
    const shown = Math.min(n, MAX_FRAMES), coverPx = (Math.hypot(h, exploreWidth(h)) + 30) / 6.15;
    const mb = (shown * (16 * coverPx * coverPx + 60e3)) / 1e6;
    el.textContent = !n ? `No SPHEREx ${bandShort(band)} images here yet`
      : `~${shown}${n > shown ? ` of ${n}` : ""} frames · ~${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB · larger = slower`;
    el.title = "Roughly how much the server downloads from IRSA for this search. Bigger fields mean more data and a slower load.";
  }, 400);
}

// The releases (IRSA collections) the server searches, shown in the credit above the grid.
async function loadReleases() {
  try {
    const d = await getJSON("api/collections");
    const names = d.in_use.map((c) => c.label);
    $("pvReleases").textContent = ` · Releases ${names.join(" + ")}`;
    $("pvReleases").title = "SPHEREx data releases searched: " + d.in_use.map((c) => c.collection).join(", ");
  } catch { /* the credit simply leaves the releases out */ }
}
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
// ex: page-2 state.
//   target {ra, dec}, band, h/w = field height/width (arcsec)
//   view = "stacks" (one co-added image per survey epoch; the default, less noisy) or "frames"
//          (every single SPHEREx image)
//   lists.stacks / lists.frames = the two views' items, oldest first, with loading progress:
//          {items, started, done, failed, finished}. Each item has {date, mjd, url, ..., cut, failed};
//          cut = the processed image from the server once it has arrived. Stack items also carry
//          {stack: true, epoch, start, end, n, urls}.
//   frames = the items of the current view (lists[view].items); playback, BLINK, the strip and
//          the pop-up all work on it, so they behave the same in both views
//   current = index shown; timer/playing/speedIdx = playback
//   mode = "normal" | "blink" | "diff"; ref = what BLINK / DIFF compare with: "prev" (the nearest
//          earlier loaded item), "first" (the first loaded item) or an item index;
//          blinkAlt/blinkTimer = BLINK state; diff = the difference image on screen (for the pop-up)
//   lock = per view, whether every image uses one brightness scale (see lockRange)
//   curve = whether the light-curve panel is open
//   pick = clicked field pixel {ix, iy} for the About pop-up
//   searchId bumps on every search, so replies for an older search are ignored
const ex = {
  target: null, band: "", h: 0, w: 0, view: "stacks", lists: {},
  frames: [], current: 0, timer: null, playing: false, speedIdx: 2,
  mode: "normal", ref: "prev", blinkAlt: false, blinkTimer: null, diff: null,
  lock: { stacks: true, frames: false }, curve: window.innerWidth > 760,
  pick: null,
  searchId: 0,
  pending: {},   // from a shared link: item index (i), zoom (z) and image point at the centre (at), applied once
};
const VIEWS = ["stacks", "frames"];
const STACK_PARALLEL = 2;   // epochs co-added at once (each one already fetches its images in parallel on the server)
const newList = () => ({ items: [], started: false, done: 0, failed: 0, finished: false });
const exBox = $("exSky");
const exView = new SkyView(exBox, $("exZoom"), {
  onPick: (q) => { ex.pick = q; renderPop(); placeExMarks(); },
  onChange: () => { placeExMarks(); if (!ex.pending.z) scheduleHash(); },
});

// Loading overlay over the explore image (hidden when text is empty).
function exLoading(text) { $("exLoading").hidden = !text; if (text) $("exLoadingText").textContent = text; }
// Short message at the bottom of the explore image, hidden after 2.2 s.
let toastTimer = null;
function toast(msg) {
  clearTimeout(toastTimer);
  $("toast").textContent = msg; $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2200);
}

// Switch to page 2, list every SPHEREx image of the field around c (in time order), group them
// into survey epochs, and load the current view.
async function openExplore(c) {
  stop(); stopBlink();
  $("pick").hidden = true; $("explore").hidden = false;
  window.scrollTo(0, 0);

  const id = ++ex.searchId;
  Object.assign(ex, { target: c, band: $("band").value, h: heightArcsec(),
                      lists: { stacks: newList(), frames: newList() }, frames: [], current: 0, pick: null });
  ex.w = exploreWidth(ex.h);
  loadGaia(c); loadWise(c);
  $("strip").innerHTML = ""; $("exCredit").textContent = "";
  $("pop").hidden = true; $("noObs").hidden = true;
  exView.field = null; exView.clearImage();
  exLoading("Retrieving SPHEREx observations…");
  renderView(); renderBar();

  let list;
  try { list = await getJSON(framesURL(c.ra, c.dec, ex.band)); }
  catch (e) {
    if (id !== ex.searchId) return;
    exLoading("");
    showNoObs("Could not search IRSA", plainError(e) + " Go back and search again.");
    return;
  }
  if (id !== ex.searchId) return;

  const all = list.frames;
  if (!all.length) {
    exLoading("");
    showNoObs("No SPHEREx observations found",
      "Nothing is available for these coordinates in the selected band. Go back and try another position or band.");
    return;
  }
  // Stacks: one per survey epoch, from all of that epoch's images (the server groups them).
  ex.lists.stacks.items = (list.epochs || []).map((e) => {
    const members = all.slice(e.first, e.last + 1);
    return { stack: true, epoch: e.index, start: e.start, end: e.end, n: e.n, date: e.start,
             mjd: (e.start_mjd + e.end_mjd) / 2, urls: members.map((f) => f.url), url: members[0].url,
             collection: [...new Set(members.map((f) => f.collection))].join("+"), obs_id: `Survey ${e.index + 1}`,
             cut: null, failed: false };
  });
  // Single frames: if there are very many, show MAX_FRAMES spread evenly in time.
  let shown = all;
  if (all.length > MAX_FRAMES) {
    const step = all.length / MAX_FRAMES;
    shown = Array.from({ length: MAX_FRAMES }, (_, i) => all[Math.floor(i * step)]);
  }
  ex.lists.frames.items = shown.map((f) => ({ ...f, cut: null, failed: false }));
  if (!ex.lists.stacks.items.length) ex.view = "frames";   // (an older server without epochs)
  ex.frames = ex.lists[ex.view].items;
  if (typeof ex.ref === "number" && ex.ref >= ex.frames.length) ex.ref = "prev";
  if (ex.pending.i !== undefined) { ex.current = Math.min(ex.pending.i, ex.frames.length - 1); delete ex.pending.i; }
  buildStrip(); renderView(); setMode(ex.mode); writeHash(c);
  loadList(ex.view, id);
}

function showNoObs(title, text) {
  $("noObsTitle").textContent = title; $("noObsText").textContent = text; $("noObs").hidden = false;
}
// Loading message for a view's list while its first image is not on screen yet.
function loadingText(L) {
  return L === ex.lists.stacks
    ? `Co-adding survey epochs from IRSA… ${L.done} of ${L.items.length}`
    : `Retrieving SPHEREx observations… ${L.done} of ${L.items.length}`;
}

// Load every item of one view ("stacks" or "frames"); failed items get one more try.
async function loadList(view, id) {
  const L = ex.lists[view];
  if (L.started) return;
  L.started = true;
  const active = () => ex.frames === L.items;
  if (active() && !exView.hasImage) exLoading(loadingText(L));
  const received = (f, frame) => {
    if (id !== ex.searchId) return;
    if (frame) { f.cut = frame; if (f.failed) { f.failed = false; L.failed--; } L.done++; }
    else if (!f.failed) { f.failed = true; L.failed++; }
    if (!active()) return;   // the other view is on screen; this one keeps loading in the background
    const i = L.items.indexOf(f);
    updateChip(i); renderCurve();
    if (!exView.hasImage && frame && i === ex.current) exLoading("");
    else if (!exView.hasImage) exLoading(loadingText(L));
    // An item arriving can change what BLINK / DIFF compare with.
    if (i === ex.current || (ex.mode !== "normal" && (i < ex.current || ex.ref !== "prev"))) showFrame();
  };
  for (let pass = 0; pass < 2 && id === ex.searchId; pass++) {
    const batch = pass === 0 ? L.items.slice() : L.items.filter((f) => f.failed);
    if (!batch.length) break;
    if (view === "frames") {
      // All cutouts in one streamed request (the server fetches several from IRSA at once).
      const got = new Set();
      try {
        await streamCutouts(batch, ex.target, id, (msg) => { got.add(msg.i); received(batch[msg.i], msg.frame); });
      } catch { /* connection lost: anything not received counts as failed below */ }
      if (id !== ex.searchId) return;
      batch.forEach((f, i) => { if (!got.has(i)) received(f, null); });
    } else {
      // Stacks: a few epochs at a time, oldest first, so the first one appears quickly.
      const queue = batch.slice();
      const worker = async () => {
        while (queue.length && id === ex.searchId) {
          const s = queue.shift();
          try { received(s, await fetchStack(s, ex.target)); } catch { received(s, null); }
        }
      };
      await Promise.all(Array.from({ length: STACK_PARALLEL }, worker));
    }
  }
  if (id !== ex.searchId) return;
  L.finished = true;
  if (!active()) return;
  if (!ex.frames[ex.current].cut) { const first = ex.frames.findIndex((f) => f.cut); if (first >= 0) go(first); }
  if (!ex.frames.some((f) => f.cut)) {
    exLoading("");
    showNoObs("Could not load the observations", "IRSA did not return any of the images. It may be busy; go back and try again.");
  }
}

// ---- VIEW: epoch stacks or single frames. Switching keeps the same moment in time.
function setView(v) {
  if (!VIEWS.includes(v) || v === ex.view) return;
  ex.view = v;
  renderView();
  if (!ex.target || !ex.lists[v] || !ex.lists[v].items.length) { writeHash(ex.target); return; }
  const cur = ex.frames[ex.current];
  ex.frames = ex.lists[v].items;
  if (cur) {   // the epoch holding the current frame, or the first frame of the current epoch
    const k = v === "stacks" ? ex.frames.findIndex((s) => s.epoch === cur.epoch)
                             : ex.frames.findIndex((f) => f.epoch === cur.epoch);
    ex.current = Math.max(0, k);
  }
  if (typeof ex.ref === "number") {   // a chosen reference follows to the other view, like the current item
    const r = ex.lists[v === "stacks" ? "frames" : "stacks"].items[ex.ref];
    const k = r ? ex.frames.findIndex((x) => x.epoch === r.epoch) : -1;
    ex.ref = k >= 0 ? k : "prev";
  }
  $("noObs").hidden = true;
  buildStrip(); showFrame(); writeHash(ex.target);
  loadList(v, ex.searchId);
}
function renderView() {
  $("lockBtn").setAttribute("aria-pressed", String(!!ex.lock[ex.view]));
  document.querySelectorAll("#viewSeg [data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === ex.view)));
}
document.querySelectorAll("#viewSeg [data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

// ---- date strip: one button per image; red dot = SPHEREx quality flags at the target
const qualityText = (f) => f.cut && f.cut.quality && f.cut.quality.length ? f.cut.quality.map((q) => q.name).join(", ") : "";
function buildStrip() {
  const strip = $("strip"); strip.innerHTML = "";
  ex.frames.forEach((f, i) => {
    const d = shortDate(f.date), b = document.createElement("button");
    b.type = "button"; b.className = "fr";
    b.innerHTML = f.stack
      ? `<span class="d">Survey ${f.epoch + 1}</span><span class="t">${esc(monthRange(f.start, f.end))} · ${f.n} frames<span class="dotf" hidden></span></span>`
      : `<span class="d">${esc(d.day)}</span><span class="t">${esc(d.year)} · ${esc(d.time)} UTC<span class="dotf" hidden></span></span>`;
    b.addEventListener("click", () => go(i));
    strip.appendChild(b);
    updateChip(i);
  });
  buildRefOptions();
  updateStrip();
}
function updateChip(i) {
  const b = $("strip").children[i]; if (!b) return;
  const f = ex.frames[i], d = shortDate(f.date), q = qualityText(f);
  b.classList.toggle("on", i === ex.current);
  b.classList.toggle("bad", f.failed);
  b.setAttribute("aria-current", String(i === ex.current));
  b.querySelector(".dotf").hidden = !q;
  const what = f.stack ? `Survey epoch ${f.epoch + 1}, ${epochDays(f)}, ${f.n} frames stacked` : `${d.day} ${d.year}, ${d.time} UTC`;
  b.setAttribute("aria-label", `${what}${q ? ", flagged: " + q : ""}${f.failed ? ", could not be loaded" : ""}`);
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

// SPHEREx quality flags (FLAGS extension bit names) in plain words. Hovering or focusing a flag
// shows the description from the image's own FITS header.
const FLAG_WORDS = {
  OVERFLOW: "saturated", NONLINEAR: "nearly saturated", BLOOM: "bleed from a bright star", TRANSIENT: "cosmic ray / glitch",
  SNOWBALL: "cosmic-ray snowball", HOT: "hot pixel", COLD: "low-response pixel", NONFUNC: "dead pixel",
  SUR_ERROR: "readout fit problem", DICHROIC: "filter-edge artefact", MISSING_DATA: "missing data",
  CROSSTALK: "crosstalk", GHOST: "ghost of a bright star", GHOST_FPA: "ghost of a bright star", GHOST_EXT: "ghost of a bright star",
  STREAK: "streak", PERSIST: "afterglow of an earlier source", HALO: "halo of a bright star", SATELLITE_HALO: "halo of a bright star",
};
function renderFlags(f) {
  const el = $("metaFlags"), q = f && f.cut ? f.cut.quality || [] : null;
  if (!q) { el.textContent = ""; return; }
  if (!q.length) { el.textContent = "No quality flags at the target"; return; }
  const max = window.matchMedia("(max-width: 760px)").matches ? 1 : 3;   // phones: room for one chip
  const seen = new Set(), chips = q.filter((x) => { const w = FLAG_WORDS[x.name] || x.name; if (seen.has(w)) return false; seen.add(w); return true; });
  el.innerHTML = `<span>${f.stack ? "Flagged in some images (left out of the stack):" : "Quality at the target:"}</span>` +
    chips.slice(0, max).map((x) => {
      const w = FLAG_WORDS[x.name] || x.name.toLowerCase(), d = `${x.name}: ${x.desc || "SPHEREx quality flag"}`;
      return `<span class="qf" tabindex="0" title="${esc(d)}" aria-label="${esc(w + " – " + d)}">${esc(w)}</span>`;
    }).join("") + (chips.length > max   // the rest in one chip, listed on hover
      ? `<span class="qf" tabindex="0" title="${esc(chips.slice(max).map((x) => `${FLAG_WORDS[x.name] || x.name} (${x.name}): ${x.desc || ""}`).join("\n"))}">+${chips.length - max} more</span>` : "");
}

// "3 May – 12 Jun 2025": the first and last day of a survey epoch.
function epochDays(s) {
  const a = shortDate(s.start), b = shortDate(s.end);
  return a.day === b.day && a.year === b.year ? `${a.day} ${a.year}`
    : a.year === b.year ? `${a.day} – ${b.day} ${b.year}` : `${a.day} ${a.year} – ${b.day} ${b.year}`;
}

// ---- the picture (the current frame, its difference from the reference, or during BLINK the
// reference it is compared with)
// Index of the reference for BLINK / DIFF (see ex.ref), or -1 if there is none to compare with
// (not loaded yet, or the current item is the reference itself).
function refIndex() {
  let r = -1;
  if (ex.ref === "prev") { for (let i = ex.current - 1; i >= 0; i--) if (ex.frames[i].cut) { r = i; break; } }
  else if (ex.ref === "first") r = ex.frames.findIndex((f) => f.cut);
  else if (ex.frames[ex.ref] && ex.frames[ex.ref].cut) r = ex.ref;
  return r === ex.current ? -1 : r;
}
function shownIndex() {
  const r = refIndex();
  return ex.mode === "blink" && ex.blinkAlt && r >= 0 ? r : ex.current;
}
// Short name of an item for labels: "SURVEY 2" or "10 May 2025".
const itemName = (x) => x.stack ? `Survey ${x.epoch + 1}` : `${shortDate(x.date).day} ${shortDate(x.date).year}`;
// Draw the frame to show, and refresh its label, credit link, bar, strip, pop-up and marks.
function showFrame() {
  const k = ex.current, f = ex.frames[k]; if (!f) return;
  const di = shownIndex(), shown = ex.frames[di], d = shortDate(shown.date);
  const release = esc(shown.collection.replace(/spherex_/g, "").toUpperCase());
  if (shown.stack) {
    const cut = shown.cut, wr = cut && cut.wavelength_range_um;
    $("shownDate").textContent = `Survey ${shown.epoch + 1} · ${epochDays(shown)}`;
    $("chanShort").textContent = (wr ? `λ ${wr[0].toFixed(2)}–${wr[1].toFixed(2)} µm · ` : "") +
      `${cut ? cut.n_used : shown.n} frames stacked · ${bandShort(ex.band)} · ${release}`;
    $("exCredit").innerHTML = `SPHEREx ${release} · stack of ${shown.n} images from ` +
      `<a href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noopener">IRSA</a><span class="lg"> · each file: Single frames view</span>`;
  } else {
    $("shownDate").textContent = `${d.day} ${d.year} · ${d.time} UTC`;
    $("chanShort").textContent = (shown.cut && shown.cut.wavelength_um ? `λ ${shown.cut.wavelength_um.toFixed(3)} µm · ` : "") +
      `${bandShort(ex.band)} · ${release} · 6.15″/px`;
    $("exCredit").innerHTML = `SPHEREx ${release} · ${esc(shown.obs_id)} · ` +
      `<a href="${encodeURI(shown.url)}" target="_blank" rel="noopener">Original image file at IRSA (FITS)</a>`;
  }

  const ri = refIndex();
  ex.diff = ex.mode === "diff" && shown.cut && ri >= 0 ? diffImage(shown.cut, ex.frames[ri].cut) : null;
  if (ex.diff) {
    exView.setImage(ex.diff, ex.target.ra, ex.target.dec, { range: [-ex.diff.scale, ex.diff.scale], cmap: DIVERGING });
  } else if (shown.cut) {
    const range = ex.lock[ex.view] && lockRange();
    exView.setImage(shown.cut, ex.target.ra, ex.target.dec, range ? { ...DISPLAY, range } : DISPLAY);
  } else {
    exView.clearImage();
    if (!$("explore").hidden && ex.frames.length) {
      exLoading(shown.failed ? "" : shown.stack ? `Co-adding survey ${shown.epoch + 1} (${shown.n} images)…` : "Retrieving this observation…");
    }
  }
  if (exView.hasImage) { exLoading(""); applyPendingZoom(); }
  renderFlags(shown);
  renderMode(); renderBar(); updateStrip(); renderPop(); placeExMarks(); renderCurve();
}

// The label at the top of the image in BLINK / DIFF, and the DIFF colour legend.
function renderMode() {
  const lbl = $("modeLabel"), leg = $("diffLegend"), k = ex.current, f = ex.frames[k], ri = refIndex(), p = ex.frames[ri];
  lbl.hidden = ex.mode === "normal" || !f;
  leg.hidden = !ex.diff;
  if (!f || ex.mode === "normal") return;
  const up = (x) => itemName(x).toUpperCase();
  const skipped = ex.ref === "prev" && ri >= 0 && ri < k - 1 ? ` · ${k - 1 - ri} NOT LOADED, SKIPPED` : "";
  const why = !f.cut ? "THIS ONE IS NOT LOADED"
    : ri >= 0 ? ""
    : ex.ref === "prev" ? "NOTHING EARLIER TO COMPARE WITH"
    : "THIS IS THE REFERENCE · PICK ANOTHER";
  if (ex.mode === "blink") {
    lbl.textContent = why ? `BLINK · ${why}` : `BLINK · ${up(p)} ↔ ${up(f)} · NOW ${up(ex.frames[shownIndex()])}${skipped}`;
  } else {
    lbl.textContent = why ? `DIFF · ${why} · SHOWING THE IMAGE` : `DIFF · ${up(f)} − ${up(p)}${skipped}`;
  }
  if (ex.diff) {
    $("diffScale").textContent = `full colour ±${DIFF_SIGMAS}σ · noise ${fmtVal(ex.diff.sigma)} MJy/sr`;
  }
}
const fmtVal = (v) => Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2);

// ---- MODE: normal, BLINK (flip with the reference) or DIFF (minus the reference)
function setMode(m) {
  if (!["normal", "blink", "diff"].includes(m)) m = "normal";
  clearInterval(ex.blinkTimer); ex.blinkAlt = false;
  ex.mode = m;
  if (m === "blink") ex.blinkTimer = setInterval(() => { ex.blinkAlt = !ex.blinkAlt; showFrame(); }, BLINK_MS);
  document.querySelectorAll("#modeSeg [data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  $("refSel").hidden = $("refLbl").hidden = m === "normal";
  showFrame(); writeHash(ex.target);
}
function stopBlink() { clearInterval(ex.blinkTimer); ex.blinkAlt = false; }
document.querySelectorAll("#modeSeg [data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
// Reference choices: previous, first, or any item of the current view.
function buildRefOptions() {
  const sel = $("refSel");
  sel.innerHTML = `<option value="prev">Previous</option><option value="first">First</option>` +
    ex.frames.map((x, i) => `<option value="${i}">${esc(itemName(x))}${x.stack ? "" : " " + esc(shortDate(x.date).time)}</option>`).join("");
  sel.value = String(ex.ref);
}
$("refSel").addEventListener("change", (e) => {
  const v = e.target.value; ex.ref = v === "prev" || v === "first" ? v : Number(v);
  showFrame(); writeHash(ex.target);
});

// Overlays that follow the image: region outline, target ring, selection ring, pop-up position,
// Gaia rings. The target ring marks the position that was searched (the centre of the field).
function placeExMarks() {
  const edge = exBox.querySelector(".frameedge"), ring = exBox.querySelector(".selring"), tgt = $("targetRing");
  if (!exView.field || !exView.hasImage) { edge.hidden = ring.hidden = tgt.hidden = true; return; }
  exView.place(tgt, exView.field.nx / 2, exView.field.ny / 2);
  const a = exView.toScreen(0, 0), b = exView.toScreen(exView.field.nx, exView.field.ny);
  edge.hidden = a.y < 24;   // only when there is room above the image for the tag
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
  let bright = prow("Brightness", val === undefined ? "—" : val === null ? "no data" : `${val.toFixed(3)} MJy/sr`, val === null);
  if (ex.diff) {   // DIFF: the change since the reference at this pixel, also in units of the noise
    const k = py * ex.diff.width + px, dv = ex.diff.change[k], z = ex.diff.data[k], r = ex.frames[refIndex()];
    bright += prow(`Change vs ${itemName(r)}`, dv === null ? "no data"
      : `${dv >= 0 ? "+" : ""}${fmtVal(dv)} MJy/sr · ${z >= 0 ? "+" : ""}${z.toFixed(1)}σ`);
  }
  if (f.stack) {
    const cut = f.cut || {}, wr = cut.wavelength_range_um;
    const rows = [
      prow("RA", esc(fmtRA(c.ra))), prow("Dec", esc(fmtDec(c.dec))), bright,
      prow("Survey epoch", esc(`${f.epoch + 1} · ${epochDays(f)}`)),
      prow("Stacked", f.cut ? `${cut.n_used} of ${cut.n_frames} images` + (cut.n_failed ? ` (${cut.n_failed} failed)` : "") : `${f.n} images`),
      prow("Wavelengths", wr ? `${wr[0].toFixed(3)}–${wr[1].toFixed(3)} µm` : "—"),
      prow("Noise (1σ)", cut.noise_mjy_sr != null ? `${cut.noise_mjy_sr.toFixed(3)} MJy/sr` : "—"),
      prow("Band", esc(`${bandShort(ex.band)} · ${BANDS[ex.band]}`)),
      prow("From target", off < 0.05 ? "0″" : esc(`${off.toFixed(1)}″ · PA ${pa.toFixed(0)}°`)),
      prow("Source files", `${f.n} FITS files at IRSA · listed in Single frames`),
    ];
    $("popRows").innerHTML = rows.join("") + gaiaPopRows(c, f.mjd) + wisePopRows(c, f.mjd);
    $("popNoData").hidden = val !== null;
    pop.hidden = false; positionPop();
    return;
  }
  const rows = [
    prow("RA", esc(fmtRA(c.ra))),
    prow("Dec", esc(fmtDec(c.dec))),
    bright,
    prow("Observed", esc(`${d.day} ${d.year} · ${d.time} UTC`)),
    prow("Wavelength", f.cut && f.cut.wavelength_um ? `${f.cut.wavelength_um.toFixed(3)} µm` : "—"),
    prow("Band", esc(`${bandShort(ex.band)} · ${BANDS[ex.band]}`)),
    prow("From target", off < 0.05 ? "0″" : esc(`${off.toFixed(1)}″ · PA ${pa.toFixed(0)}°`)),
    prow("Source file", `<a href="${encodeURI(f.url)}" target="_blank" rel="noopener">FITS at IRSA</a>`),
  ];
  $("popRows").innerHTML = rows.join("") + gaiaPopRows(c, f.mjd) + wisePopRows(c, f.mjd);
  $("popNoData").hidden = val !== null;
  pop.hidden = false;
  positionPop();
}
// Place the pop-up beside the clicked point, inside the image area.
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
// Index of the next frame (dir = +1 / -1) that has not failed, or -1 at the end.
function nextLoadable(from, dir) {
  for (let i = from + dir; i >= 0 && i < ex.frames.length; i += dir) if (!ex.frames[i].failed) return i;
  return -1;
}
function go(i) {
  if (!ex.frames.length) return;
  ex.current = Math.max(0, Math.min(ex.frames.length - 1, i));
  if (ex.frames[ex.current].failed) toast(ex.view === "stacks" ? "IRSA did not send this survey visit's images. Try again later, or switch to Frames." : "This observation could not be loaded from IRSA");
  showFrame(); scheduleHash();
  if (ex.playing) schedule();
}
function schedule() {
  clearTimeout(ex.timer);
  if (!ex.playing) return;
  ex.timer = setTimeout(() => {
    const n = nextLoadable(ex.current, 1);
    if (n < 0) { stop(); toast(`Reached the last ${ex.view === "stacks" ? "survey epoch" : "observation"}`); return; }
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
  if (!ex.frames.length) return;
  const n = nextLoadable(ex.current, dir);
  if (n < 0) { toast(`This is the ${dir < 0 ? "first" : "last"} ${ex.view === "stacks" ? "survey epoch" : "observation"}`); return; }
  go(n);
}
// Frame counter and the pressed / disabled state of the control-bar buttons.
function renderBar() {
  const n = ex.frames.length, k = ex.current;
  $("frameNo").textContent = n ? `${shownIndex() + 1}/${n}` : "0/0";
  $("prev").setAttribute("aria-disabled", String(!n || nextLoadable(k, -1) < 0));
  $("next").setAttribute("aria-disabled", String(!n || nextLoadable(k, 1) < 0));
  $("play").classList.toggle("on", ex.playing); $("play").setAttribute("aria-pressed", String(ex.playing));
  $("pause").setAttribute("aria-pressed", String(!ex.playing));
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

// ---- LOCK: one brightness scale for every image, so brightness changes are real on screen.
// The scale is the reference's own (the VS choice if it is a chosen date, else the first loaded
// image), from the same percentiles as the normal display. Without it every image is stretched
// on its own, which hides a star getting brighter or fainter.
function lockRange() {
  const src = typeof ex.ref === "number" && ex.frames[ex.ref] && ex.frames[ex.ref].cut ? ex.frames[ex.ref] : ex.frames.find((f) => f.cut);
  if (!src) return null;
  if (!src.range) {
    const v = src.cut.data.filter((x) => x !== null).sort((a, b) => a - b);
    src.range = [percentile(v, DISPLAY.minb), percentile(v, DISPLAY.maxb)];
  }
  return src.range;
}
$("lockBtn").addEventListener("click", () => {
  ex.lock[ex.view] = !ex.lock[ex.view]; renderView(); showFrame(); writeHash(ex.target);
});

// ---- CURVE: light curve of the target (aperture photometry at the field centre, see
// aperturePhotometry in anvis-math.js) for every loaded image; click a point to show that image.
// In Single frames view points are shaded by wavelength (SPHEREx sees a different wavelength
// on every visit, which changes a star's brightness too). Hollow = treat with care: missing
// pixels in the aperture, or (single frames) quality flags at the target, e.g. saturation.
// Stacks already leave flagged pixels out, so their flags alone don't make a point hollow.
// Saturated stars (no data at their centre in most images) are measured in a ring outside the
// largest hole instead, the same ring for every date: a relative brightness, fine for comparing
// dates but not a total flux.
const CURVE_COLOR = "#38bdf8";
function curveAperture() {
  const loaded = ex.frames.filter((f) => f.cut);
  const holes = loaded.map((f) => (f.hole ??= coreHoleRadius(f.cut, f.cut.width / 2, f.cut.height / 2)));
  const saturated = holes.filter((h) => h > 0 && h <= APERTURE.r + 0.5).length + holes.filter((h) => h > APERTURE.r + 0.5).length;
  if (!loaded.length || saturated < 0.3 * loaded.length) return { ...APERTURE, r0: 0, ring: false };
  const sorted = holes.filter((h) => h > 0).sort((a, b) => a - b);
  const r0 = Math.ceil(sorted[Math.floor(0.9 * (sorted.length - 1))]) + 0.5;   // outside 90% of the holes
  return { r0, r: r0 + 3, rin: r0 + 5, rout: r0 + 9, ring: true };
}
function phot(f, ap) {
  if (!f.cut) return null;
  const key = `${ap.r0}/${ap.r}`;
  if (f.photKey !== key) { f.phot = aperturePhotometry(f.cut, f.cut.width / 2, f.cut.height / 2, ap); f.photKey = key; }
  return f.phot;
}
function renderCurve() {
  const panel = $("curve"), on = ex.curve && !!ex.frames.length;
  panel.hidden = !on; exBox.classList.toggle("curve-open", on);
  $("curveBtn").setAttribute("aria-pressed", String(ex.curve));
  if (!on) return;
  const svg = $("curveSvg"), W = Math.max(160, svg.clientWidth || 300), H = Math.max(60, svg.clientHeight || 96);
  const ap = curveAperture();
  const pts = ex.frames.map((f, i) => ({ f, i, p: phot(f, ap) })).filter((q) => q.p);
  const asec = (v) => (v * 6.15).toFixed(0);
  $("curveTitle").textContent = ap.ring ? "SATURATED · HALO · mJy" : "TARGET BRIGHTNESS · mJy";
  $("curveNote").textContent = `${pts.length} of ${ex.frames.length} · ` + (ap.ring ? `ring ${asec(ap.r0)}–${asec(ap.r)}″` : `r ${asec(ap.r)}″`);
  $("curveTitle").title = ap.ring
    ? `The target is saturated (no data at its centre), so this measures its halo in a ring ${asec(ap.r0)}–${asec(ap.r)}″ from the centre, the same ring on every date. It goes up and down with the star's brightness: compare dates, but it is not the star's total brightness.`
    : `Sum of the target's light within ${asec(ap.r)}″ of the field centre, minus the sky measured ${asec(ap.rin)}–${asec(ap.rout)}″ away. An aperture flux (about 90% of a point source's light), for comparing dates.`;
  if (pts.length < 1) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="cvempty">${ex.frames.some((f) => f.cut) ? "No measurement at the target" : "Waiting for images…"}</text>`;
    $("curveKey").textContent = ""; return;
  }
  const M = { l: 46, r: 8, t: 6, b: 16 };
  let lo = Math.min(...pts.map((q) => q.p.flux - q.p.err)), hi = Math.max(...pts.map((q) => q.p.flux + q.p.err));
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1; lo -= pad; hi += pad;
  const t0 = Math.min(...pts.map((q) => q.f.mjd)), t1 = Math.max(...pts.map((q) => q.f.mjd));
  const X = (m) => M.l + 12 + (t1 > t0 ? (m - t0) / (t1 - t0) : 0.5) * (W - M.l - M.r - 24);   // 12 px inside the axes
  const Y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);
  const waves = pts.map((q) => q.f.cut.wavelength_um).filter(Boolean), w0 = Math.min(...waves), w1 = Math.max(...waves);
  const shade = (f) => ex.view === "frames" && f.cut.wavelength_um && w1 > w0 ? 0.3 + (0.7 * (f.cut.wavelength_um - w0)) / (w1 - w0) : 1;
  const fmt = (v) => Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2);
  const day = (m) => { const d = shortDate(pts.find((q) => q.f.mjd === m).f.date); return `${d.day} ${d.year}`; };
  let out = `<line class="cvaxis" x1="${M.l}" y1="${M.t}" x2="${M.l}" y2="${H - M.b}"/><line class="cvaxis" x1="${M.l}" y1="${H - M.b}" x2="${W - M.r}" y2="${H - M.b}"/>` +
    `<text class="cvtick" x="${M.l - 4}" y="${Y(hi - pad) + 3}" text-anchor="end">${fmt(hi - pad)}</text>` +
    `<text class="cvtick" x="${M.l - 4}" y="${Y(lo + pad) + 3}" text-anchor="end">${fmt(lo + pad)}</text>` +
    `<text class="cvtick" x="${M.l}" y="${H - 3}">${esc(day(t0))}</text>` +
    `<text class="cvtick" x="${W - M.r}" y="${H - 3}" text-anchor="end">${esc(day(t1))}</text>`;
  let cur = "";
  for (const { f, i, p } of pts) {
    const x = X(f.mjd), y = Y(p.flux), flagged = p.nbad > 0 || (!f.stack && f.cut.quality && f.cut.quality.length > 0);
    const tip = `${itemName(f)}${f.stack ? "" : " " + shortDate(f.date).time + " UTC"}: ${fmt(p.flux)} ± ${fmt(p.err)} mJy` +
      (f.cut.wavelength_um ? ` at ${f.cut.wavelength_um.toFixed(3)} µm` : "") + (flagged ? " (flagged)" : "");
    const g = `<g class="cvpt" data-i="${i}"><title>${esc(tip)}</title>` +
      `<line x1="${x}" y1="${Y(p.flux - p.err)}" x2="${x}" y2="${Y(p.flux + p.err)}" stroke="${CURVE_COLOR}" stroke-opacity="${shade(f)}"/>` +
      `<circle cx="${x}" cy="${y}" r="${i === ex.current ? 5 : 3.5}" fill="${flagged ? "none" : CURVE_COLOR}" fill-opacity="${shade(f)}" stroke="${CURVE_COLOR}" stroke-opacity="${shade(f)}" stroke-width="1.5"/>` +
      (i === ex.current ? `<circle cx="${x}" cy="${y}" r="8" fill="none" stroke="#E03C31" stroke-width="2"/>` : "") + `</g>`;
    if (i === ex.current) cur = g; else out += g;
  }
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = out + cur;   // the current point last, on top
  const now = phot(ex.frames[ex.current], ap);
  svg.setAttribute("aria-label", `Light curve of the target: ${pts.length} measurements from ${fmt(lo + pad)} to ${fmt(hi - pad)} mJy` +
    (now ? `; this image ${fmt(now.flux)} mJy` : ""));
  $("curveKey").innerHTML = (ex.view === "frames" && w1 > w0
    ? `<span class="cvramp"></span> λ ${w0.toFixed(2)} → ${w1.toFixed(2)} µm · ` : "") +
    `<span class="cvhollow"></span> flagged · <span class="cvnow"></span> shown`;
}
$("curveSvg").addEventListener("click", (e) => {
  const g = e.target.closest(".cvpt"); if (!g) return;
  stop(); go(Number(g.dataset.i));
});
$("curveBtn").addEventListener("click", () => { ex.curve = !ex.curve; renderCurve(); writeHash(ex.target); });
$("curveClose").addEventListener("click", () => { ex.curve = false; renderCurve(); writeHash(ex.target); $("curveBtn").focus(); });
["pointerdown", "pointerup", "wheel"].forEach((t) => $("curve").addEventListener(t, (e) => e.stopPropagation()));
new ResizeObserver(() => renderCurve()).observe($("curveSvg"));

// ---- GAIA: Gaia DR3 stars from MAST, moved to each frame's date
// Gaia positions are for epoch 2016.0; each star is moved by its proper motion to the date of the
// frame on screen (parallax shifts, at most ~0.8″, are ignored: well under one 6.15″ pixel).
const GAIA_GMAX = 19, GAIA_MATCH_ARCSEC = 6.2, GAIA_HIGH_PM = 100, GAIA_ARROW_YEARS = 10;
const MJD_J2016 = 57388.5;   // Julian epoch 2016.0
const GAIA_COLOR = "#38bdf8";
const gaia = { on: false, data: null, error: null, loading: false, id: 0 };

// Fetch Gaia stars for the field once per search (in the background while the images load).
async function loadGaia(c) {
  const id = ++gaia.id;
  Object.assign(gaia, { data: null, error: null, loading: true });
  drawGaia();
  const radius = Math.min(0.4, Math.hypot(ex.w, ex.h) / 2 / 3600 + 0.01);   // covers the field's corners
  try {
    const d = await getJSON(`api/gaia?ra=${c.ra}&dec=${c.dec}&radius=${radius.toFixed(4)}&gmax=${GAIA_GMAX}`);
    if (id !== gaia.id) return;
    gaia.data = d;
  } catch (e) {
    if (id !== gaia.id) return;
    gaia.error = e.message;
  }
  gaia.loading = false; wise.cand = null;
  drawGaia(); if (!$("pop").hidden) renderPop();
}
// Star [id, ra, dec, pmra, pmdec, plx, plx_err, G, bp_rp] -> {ra, dec} at the given MJD.
function gaiaAt(st, mjd) {
  const yrs = (mjd - MJD_J2016) / 365.25, dec = st[2] + ((st[4] || 0) * yrs) / 3.6e6;
  return { ra: st[1] + ((st[3] || 0) * yrs) / 3.6e6 / Math.cos((st[2] * Math.PI) / 180), dec };
}
// Draw the overlays on their own canvas above the image: Gaia rings (and motion arrows), then
// WISE squares. The label lists what is shown, one line per catalogue.
function drawGaia() {
  const cv = $("gaiaCanvas"), lbl = $("gaiaLabel"), r = exView.rect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
  $("gaiaBtn").setAttribute("aria-pressed", String(gaia.on));
  $("wiseBtn").setAttribute("aria-pressed", String(wise.on));
  lbl.hidden = !gaia.on && !wise.on;
  const lines = [];
  if (gaia.on) lines.push(["gaia", drawGaiaLayer(ctx, r, dpr)]);
  if (wise.on) lines.push(["wise", drawWiseLayer(ctx, r, dpr)]);
  // Each line has a long form and a short one for phones ([long, short], or one text for both).
  lbl.innerHTML = lines.map(([k, t]) => {
    const [lg, sh] = Array.isArray(t) ? t : [t, t];
    return `<div class="ln-${k}"><span class="lg">${esc(lg)}</span><span class="sh">${esc(sh)}</span></div>`;
  }).join("");
}
// Gaia rings for the image on screen; returns the label line.
function drawGaiaLayer(ctx, r, dpr) {
  if (gaia.loading) return "GAIA DR3 · loading from MAST…";
  if (gaia.error) return "GAIA DR3 · unavailable: " + plainError(gaia.error, "MAST");
  const f = ex.frames[shownIndex()];
  if (!gaia.data || !exView.field || !exView.hasImage || !f) return "GAIA DR3";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const fld = exView.field, k = exView.k(), zs = Math.min(1.6, Math.sqrt(exView.z));
  let shown = 0;
  for (const st of gaia.data.stars) {
    const pos = gaiaAt(st, f.mjd), q = skyToPix(fld, pos.ra, pos.dec), p = exView.toScreen(q.ix, q.iy);
    if (!exView.inside(q.ix, q.iy)) continue;   // only over the image (not in the margin around a narrow field)
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
  const d = shortDate(f.date), when = f.stack ? `mid-survey ${f.epoch + 1}` : `${d.day} ${d.year}`;
  return [`GAIA DR3 · G < ${GAIA_GMAX} · ${shown} stars · at ${when}` +
    (gaia.data.truncated ? ` · brightest ${gaia.data.stars.length} only` : "") + ` · arrows: ${GAIA_ARROW_YEARS}-yr motion`,
    `GAIA · ${shown} stars`];
}
// Pop-up rows for the nearest Gaia star to sky position c at the given date.
function gaiaPopRows(c, mjd) {
  const head = `<div class="popsec">GAIA DR3 · MAST</div>`;
  if (gaia.loading) return head + `<div class="popnote">Loading Gaia stars…</div>`;
  if (gaia.error) return head + `<div class="popnote">Gaia unavailable: ${esc(plainError(gaia.error, "MAST"))}</div>`;
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

// ---- WISE: CatWISE2020 (or AllWISE) sources from IRSA, moved to each image's date like Gaia.
// Brown-dwarf candidates: bright in WISE (W2 ≤ 16), red (W1 − W2 ≥ 0.4, or no W1) and with no
// Gaia DR3 star (G < GAIA_GMAX) within WISE_GAIA_MATCH″. Cold brown dwarfs glow in the infrared
// but are too faint for Gaia's visible light. Other things can pass too (galaxies, blends, a
// Gaia star missing near a bright one), so they are candidates, not discoveries.
const WISE_W2MAX = 17, WISE_MATCH_ARCSEC = 6.2, WISE_GAIA_MATCH = 3;
const WISE_CAND = { w2max: 16, minColour: 0.4 };
const WISE_COLOR = "#ffd23f", CAND_COLOR = "#E03C31";
const wise = { on: false, data: null, error: null, loading: false, id: 0, cand: null, gaiaPm: null, matched: null };

async function loadWise(c) {
  const id = ++wise.id;
  Object.assign(wise, { data: null, error: null, loading: true, cand: null, gaiaPm: null });
  drawGaia();
  const radius = Math.min(0.4, Math.hypot(ex.w, ex.h) / 2 / 3600 + 0.01);
  try {
    const d = await getJSON(`api/wise?ra=${c.ra}&dec=${c.dec}&radius=${radius.toFixed(4)}&w2max=${WISE_W2MAX}`);
    if (id !== wise.id) return;
    wise.data = d;
  } catch (e) {
    if (id !== wise.id) return;
    wise.error = e.message;
  }
  wise.loading = false;
  drawGaia(); if (!$("pop").hidden) renderPop();
}
// Source i [name, ra, dec, pmra, pmdec (mas/yr), W1, W2] -> {ra, dec} at the given MJD.
// Sources matched to a Gaia star move with Gaia's proper motion, which is far more precise
// (CatWISE can split a bright fast mover into pieces with poor motions, e.g. Epsilon Indi B).
function wiseAt(s, mjd, i) {
  const g = i !== undefined && wise.gaiaPm && wise.gaiaPm[i];
  const pmra = g ? g[0] : s[3] || 0, pmdec = g ? g[1] : s[4] || 0;
  const yrs = (mjd - wise.data.epoch_mjd) / 365.25, dec = s[2] + (pmdec * yrs) / 3.6e6;
  return { ra: s[1] + (pmra * yrs) / 3.6e6 / Math.cos((s[2] * Math.PI) / 180), dec };
}
const sepArcsec = (a, b) => {
  let dra = a.ra - b.ra; if (dra > 180) dra -= 360; if (dra < -180) dra += 360;
  return Math.hypot(dra * Math.cos((b.dec * Math.PI) / 180), a.dec - b.dec) * 3600;
};
const isRed = (s) => s[6] != null && s[6] <= WISE_CAND.w2max && (s[5] == null || s[5] - s[6] >= WISE_CAND.minColour);
// Match WISE to Gaia once both catalogues are in (at Gaia's epoch, 2016.0, close to CatWISE's
// 2015.4): matched sources get Gaia's proper motion (wise.gaiaPm); red, bright sources with no
// Gaia match are brown-dwarf candidates (wise.cand, a set of source indices).
function wiseCandidates() {
  if (!wise.data || !gaia.data) return null;
  if (wise.cand) return wise.cand;
  wise.cand = new Set(); wise.gaiaPm = []; wise.matched = new Set();
  wise.data.sources.forEach((s, i) => {
    const p = wiseAt(s, MJD_J2016);
    const g = gaia.data.stars.find((st) => Math.abs(st[2] - p.dec) * 3600 < WISE_GAIA_MATCH && sepArcsec({ ra: st[1], dec: st[2] }, p) < WISE_GAIA_MATCH);
    if (g) wise.matched.add(i);
    if (g && g[3] != null) wise.gaiaPm[i] = [g[3], g[4]];
    else if (!g && isRed(s)) wise.cand.add(i);
  });
  return wise.cand;
}
// WISE squares for the image on screen (candidates in red, larger); returns the label line.
function drawWiseLayer(ctx, r, dpr) {
  if (wise.loading) return "WISE · loading CatWISE2020 from IRSA (can take up to a minute)…";
  if (wise.error) return "WISE · unavailable: " + plainError(wise.error, "IRSA");
  const f = ex.frames[shownIndex()];
  if (!wise.data || !exView.field || !exView.hasImage || !f) return "WISE";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const fld = exView.field, zs = Math.min(1.6, Math.sqrt(exView.z)), cand = wiseCandidates();
  let shown = 0, nc = 0;
  wise.data.sources.forEach((s, i) => {
    const pos = wiseAt(s, f.mjd, i), q = skyToPix(fld, pos.ra, pos.dec), p = exView.toScreen(q.ix, q.iy);
    if (!exView.inside(q.ix, q.iy) || p.x < -20 || p.y < -20 || p.x > r.width + 20 || p.y > r.height + 20) return;
    shown++;
    const c = cand && cand.has(i); if (c) nc++;
    const h = (c ? 8 : Math.max(3, Math.min(7, 7 - ((s[6] || 16) - 10) * 0.5))) * zs;
    for (const [w, col] of [[3, "rgba(0,0,0,0.6)"], [c ? 2 : 1.25, c ? CAND_COLOR : WISE_COLOR]]) {
      ctx.lineWidth = w; ctx.strokeStyle = col; ctx.strokeRect(p.x - h, p.y - h, 2 * h, 2 * h);
    }
  });
  const d = wise.data;
  return [`${d.catalog.toUpperCase()} · W2 < ${d.w2max} · ${shown} sources` +
    (cand ? ` · ${nc} brown-dwarf candidate${nc === 1 ? "" : "s"} (red)` : gaia.error ? " · candidates need Gaia" : "") +
    (d.truncated ? ` · brightest ${d.sources.length} only` : ""),
    `${d.catalog.toUpperCase()} · ${shown}` + (cand ? ` · ${nc} candidate${nc === 1 ? "" : "s"}` : "")];
}
// Pop-up rows for the nearest WISE source to sky position c at the given date.
function wisePopRows(c, mjd) {
  if (!wise.on && !wise.data) return "";
  const head = `<div class="popsec popsec-wise">WISE · ${esc(wise.data ? wise.data.catalog : "CatWISE2020")} · IRSA</div>`;
  if (wise.loading) return head + `<div class="popnote">Loading WISE sources…</div>`;
  if (wise.error) return head + `<div class="popnote">WISE unavailable: ${esc(plainError(wise.error, "IRSA"))}</div>`;
  if (!wise.data) return "";
  let best = -1, bd = Infinity;
  const cand = wiseCandidates();
  wise.data.sources.forEach((s, i) => { const d = sepArcsec(wiseAt(s, mjd, i), c); if (d < bd) { bd = d; best = i; } });
  if (best < 0 || bd > WISE_MATCH_ARCSEC) return head + `<div class="popnote">No WISE source with W2 < ${wise.data.w2max} within ${WISE_MATCH_ARCSEC}″ at this date.</div>`;
  const [name, , , wpmra, wpmdec, w1, w2] = wise.data.sources[best];
  const g = wise.gaiaPm && wise.gaiaPm[best], pmra = g ? g[0] : wpmra, pmdec = g ? g[1] : wpmdec;
  const pm = Math.hypot(pmra || 0, pmdec || 0), pa = ((Math.atan2(pmra || 0, pmdec || 0) * 180) / Math.PI + 360) % 360;
  const isCand = cand && cand.has(best);
  return head + [
    `<div class="prow wide"><div class="k">WISE source</div><div class="v">${esc(name)}</div></div>`,
    prow("W1 (3.4 µm)", w1 != null ? `${w1.toFixed(2)} mag` : "not detected"),
    prow("W2 (4.6 µm)", w2 != null ? `${w2.toFixed(2)} mag` : "—"),
    prow("W1 − W2", w1 != null && w2 != null ? (w1 - w2).toFixed(2) + (w1 - w2 >= 0.4 ? " · red" : "") : "—"),
    prow("Proper motion", pmra != null ? `${pm.toFixed(0)} mas/yr · PA ${pa.toFixed(0)}°` + (g ? " (Gaia)" : "") : "—"),
    prow("Offset", `${bd.toFixed(1)}″`),
    prow("Gaia match", !cand ? "—" : wise.matched.has(best) ? `yes, within ${WISE_GAIA_MATCH}″` : `none within ${WISE_GAIA_MATCH}″`),
  ].join("") + (isCand
    ? `<div class="popnote popcand">Brown-dwarf candidate: bright and red in WISE, but no Gaia DR3 star (G < ${GAIA_GMAX}) within ${WISE_GAIA_MATCH}″.</div>`
    : "");
}
$("wiseBtn").addEventListener("click", () => { wise.on = !wise.on; drawGaia(); renderPop(); if (ex.target) writeHash(ex.target); });

// Keys on page 2: ← / → step, Space plays or pauses, Esc closes the pop-up.
document.addEventListener("keydown", (e) => {
  if ($("explore").hidden || document.querySelector("dialog[open]")) return;   // (not while a help screen is open)
  if (e.key === "Escape") { if (!$("pop").hidden) $("popClose").click(); return; }
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === " " && e.target.tagName === "BUTTON") return;
  if (e.key === "ArrowLeft") { stop(); stepFrame(-1); }
  else if (e.key === "ArrowRight") { stop(); stepFrame(1); }
  else if (e.key === " ") { e.preventDefault(); ex.playing ? stop() : play(); }
});

// Back to page 1, with the searched position selected and marked on the grid.
$("back").addEventListener("click", (e) => {
  e.preventDefault();
  stop(); stopBlink(); ex.searchId++; gaia.id++; wise.id++;
  history.replaceState(null, "", location.pathname + location.search);
  $("explore").hidden = true; $("pick").hidden = false;
  const c = ex.target;
  requestAnimationFrame(() => {
    if (c) { setPick(c, true); centreMap(c); } else drawMap();
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
  if (wise.on) p.set("wise", 1);
  if (ex.view !== "stacks") p.set("view", ex.view);
  if (ex.mode !== "normal") p.set("mode", ex.mode);
  if (ex.ref !== "prev") p.set("ref", ex.ref);
  if (ex.lock[ex.view] !== (ex.view === "stacks")) p.set("lock", ex.lock[ex.view] ? 1 : 0);   // only when not the default
  if (ex.curve !== window.innerWidth > 760) p.set("curve", ex.curve ? 1 : 0);
  if (!$("explore").hidden && ex.frames.length) {
    if (ex.current) p.set("i", ex.current);                     // the image shown
    if (exView.field && exView.z > 1.001) {                     // zoom and the image point at the centre
      const r = exView.rect(), q = exView.toImage(r.width / 2, r.height / 2);
      p.set("z", +exView.z.toFixed(2)); p.set("at", `${q.ix.toFixed(1)},${q.iy.toFixed(1)}`);
    }
  }
  history.replaceState(null, "", "#" + p.toString());
}
// Hash updates while playing, zooming or panning are batched: browsers limit how often a page
// may change its address.
let hashTimer = null;
function scheduleHash() { clearTimeout(hashTimer); hashTimer = setTimeout(() => writeHash(ex.target), 300); }
// Zoom and pan from a shared link, once the first image is on screen.
function applyPendingZoom() {
  const z = ex.pending.z; if (!z || !exView.field) return;
  const at = ex.pending.at || { ix: exView.field.nx / 2, iy: exView.field.ny / 2 };
  delete ex.pending.z; delete ex.pending.at;
  exView.z = Math.max(1, Math.min(8, z));
  const r = exView.rect(), k = exView.k();
  exView.tx = r.width / 2 - at.ix * k; exView.ty = r.height / 2 - at.iy * k;
  exView.fitClamp(); exView.draw();
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has("band") && BANDS[p.get("band")]) $("band").value = p.get("band");
  if (p.has("size")) {   // stored in arcsec
    const m = Math.round(Number(p.get("size")) / 60);
    if (m >= 1) $("size").value = Math.min(MAX_HEIGHT_ARCMIN, m);
  }
  if (p.has("speed")) {
    let s = Number(p.get("speed"));
    if (s > 10) s = BASE_FRAME_MS / s;     // older links stored milliseconds per frame
    let best = 2; SPEED_LIST.forEach((x, i) => { if (Math.abs(x - s) < Math.abs(SPEED_LIST[best] - s)) best = i; });
    ex.speedIdx = best;
  }
  gaia.on = p.get("gaia") === "1";
  wise.on = p.get("wise") === "1";
  ex.view = VIEWS.includes(p.get("view")) ? p.get("view") : "stacks";
  ex.mode = ["blink", "diff"].includes(p.get("mode")) ? p.get("mode") : "normal";
  const r = p.get("ref");
  ex.ref = r === "first" ? "first" : /^\d+$/.test(r || "") ? Number(r) : "prev";
  if (p.has("lock")) ex.lock[ex.view] = p.get("lock") === "1";
  if (p.has("curve")) ex.curve = p.get("curve") === "1";
  ex.pending = {};
  if (/^\d+$/.test(p.get("i") || "")) ex.pending.i = Number(p.get("i"));
  const z = Number(p.get("z")), at = (p.get("at") || "").split(",").map(Number);
  if (z > 1 && z <= 8) ex.pending.z = z;
  if (at.length === 2 && at.every(Number.isFinite)) ex.pending.at = { ix: at[0], iy: at[1] };
  const ra = p.has("ra") ? parseRA(p.get("ra")) : null, dec = p.has("dec") ? parseDec(p.get("dec")) : null;
  return ra !== null && dec !== null ? { ra, dec } : null;
}

// ======================================================================
// Start: a link with #ra=…&dec=… opens page 2 directly; otherwise page 1 on the start preset.
// ======================================================================
// ---- help screens: each i button opens the explanation of its page (a modal dialog: Esc,
// the × button or a click outside closes it, and focus returns to the i button).
// Until help has been opened once (remembered in this browser), the i buttons pulse gently.
const HELP_KEY = "anvis.helpSeen";
let helpSeen = false;
try { helpSeen = localStorage.getItem(HELP_KEY) === "1"; } catch { /* storage blocked */ }
document.querySelectorAll(".infobtn").forEach((b) => {
  b.classList.toggle("attn", !helpSeen);
  b.addEventListener("click", () => {
    stop(); $(b.dataset.help).showModal();
    document.querySelectorAll(".infobtn").forEach((x) => x.classList.remove("attn"));
    try { localStorage.setItem(HELP_KEY, "1"); } catch { /* fine */ }
  });
});
document.querySelectorAll("dialog.help").forEach((d) => {
  d.querySelector("[data-close]").addEventListener("click", () => d.close());
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });   // the backdrop
});

// ---- first-time guide: shown until dismissed (remembered in this browser, if storage works)
const HINT_KEY = "anvis.hintDismissed";
function initHint() {
  let seen = false;
  try { seen = localStorage.getItem(HINT_KEY) === "1"; } catch { /* storage blocked: show it */ }
  $("firstHint").hidden = seen;
  $("firstHintClose").addEventListener("click", () => {
    $("firstHint").hidden = true;
    try { localStorage.setItem(HINT_KEY, "1"); } catch { /* fine: hidden for this visit */ }
  });
}

(function start() {
  initHint();
  loadReleases();
  const c = readHash();
  $("size").dispatchEvent(new Event("input"));
  renderBar();
  if (c) {
    $("ra").value = c.ra.toFixed(5); $("dec").value = (c.dec >= 0 ? "+" : "") + c.dec.toFixed(5);
    pk.pick = c; updateHints(); updatePickLabel();
    openExplore(c);
  } else {
    updateHints(); updatePickLabel(); updateEstimate(); drawMap();   // the empty grid; nothing downloaded
  }
})();
