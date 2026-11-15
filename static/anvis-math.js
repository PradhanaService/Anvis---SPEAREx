// Anvis – small pure functions on images (no DOM), shared by the page and the tests.
//
// An image here is a "cut" as the server sends it: { width, height, data } where data is a flat
// row-major array of numbers (MJy/sr) with null for "no data". The page loads this file before
// app.js; the tests (tests/test_math.py) run it in node, which is why it ends with module.exports.

// Median and robust standard deviation (1.4826 × median absolute deviation) of the non-null
// values. The MAD ignores stars and other outliers, so sigma measures the noise.
function robustStats(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { median: 0, sigma: 0, n: 0 };
  const mid = (a) => (a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2);
  const median = mid(v);
  const dev = v.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  return { median, sigma: 1.4826 * mid(dev), n: v.length };
}

// Difference image: current − reference, pixel by pixel on the shared north-up grid, measured
// in units of its uncertainty so the display means the same on every pair:
//   change = cur − ref − median(cur − ref)   (the sky background differs a little between visits
//            – zodiacal light residuals – and would otherwise tint the whole image)
//   sigma  = robust noise of the change (1.4826 × MAD)
//   z      = change / sqrt(sigma² + (floor × brightness)²)
// brightness = the pixel's brightness above its own image's background (median), the larger of
// the two images. The floor (10% of it) allows for the small differences
// in PSF and wavelength mix between visits, which leave residuals on every bright star; without
// it all constant stars would light up. Moving or strongly varying objects change by far more
// than 10%, so they still stand out. The display runs from −sigmas to +sigmas in z.
const DIFF_SIGMAS = 5, DIFF_FLOOR = 0.1;
function diffImage(cur, ref, sigmas = DIFF_SIGMAS, floor = DIFF_FLOOR) {
  if (cur.width !== ref.width || cur.height !== ref.height) throw new Error("images are on different grids");
  const raw = cur.data.map((v, i) => (v === null || ref.data[i] === null ? null : v - ref.data[i]));
  const st = robustStats(raw);
  const sigma = Math.max(st.sigma, 1e-9);
  const change = raw.map((v) => (v === null ? null : v - st.median));
  const bgCur = robustStats(cur.data).median, bgRef = robustStats(ref.data).median;
  const data = change.map((v, i) => {
    if (v === null) return null;
    const b = floor * Math.max(Math.abs(cur.data[i] - bgCur), Math.abs(ref.data[i] - bgRef));
    return v / Math.sqrt(sigma * sigma + b * b);
  });
  return { width: cur.width, height: cur.height, pixel_scale_arcsec: cur.pixel_scale_arcsec, data, change,
           offset: st.median, sigma, scale: sigmas, floor };
}

// Target photometry: the brightness of a point source at field pixel (x, y) (continuous
// coordinates; pixel i spans i..i+1), as an aperture sum minus the local sky.
//   aperture: pixels whose centre is within r of (x, y)   (2 px = 12.3″, about the SPHEREx PSF);
//             with r0 > 0, only the ring r0..r (used for saturated stars, see coreHoleRadius)
//   sky: the median of the pixels in the annulus rin..rout (4–7 px), which ignores other stars
// The sum is converted from MJy/sr × pixels to mJy with the solid angle of one 6.15″ pixel.
// Missing pixels in the aperture are counted in nbad (the measurement is then incomplete).
// err is the sky noise only (sigma of the annulus, scaled to the aperture), so it is a lower
// limit: resampled pixels have correlated noise and photon noise of the star is not included.
const APERTURE = { r: 2, rin: 4, rout: 7 };
const PIXEL_SR = (6.15 / 206264.806) ** 2;             // solid angle of one 6.15″ pixel (sr)
const MJY_PER_MJYSR_PIXEL = PIXEL_SR * 1e9;            // 1 MJy/sr over one pixel, in mJy (1 MJy = 1e9 mJy)
function aperturePhotometry(cut, x, y, ap = APERTURE) {
  const W = cut.width, H = cut.height, ring = [];
  let sum = 0, n = 0, nbad = 0;
  for (let py = Math.floor(y - ap.rout); py <= Math.ceil(y + ap.rout); py++) {
    for (let px = Math.floor(x - ap.rout); px <= Math.ceil(x + ap.rout); px++) {
      const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
      const inside = px >= 0 && py >= 0 && px < W && py < H, v = inside ? cut.data[py * W + px] : null;
      if (d <= ap.r && d >= (ap.r0 || 0)) { if (v === null) nbad++; else { sum += v; n++; } }
      else if (d >= ap.rin && d <= ap.rout && v !== null) ring.push(v);
    }
  }
  if (!n || ring.length < 8) return null;
  const sky = robustStats(ring);
  const k = MJY_PER_MJYSR_PIXEL;
  return { flux: (sum - n * sky.median) * k, err: sky.sigma * Math.sqrt(n + (n * n) / ring.length) * k,
           sky: sky.median, npix: n, nbad };
}

// Radius (px) of the no-data hole at (x, y): the distance of the farthest no-data pixel within
// max px, or 0 if there is none. A saturated star has no valid pixels at its centre; its halo
// outside this radius still grows and shrinks with its brightness.
function coreHoleRadius(cut, x, y, max = 10) {
  let r = 0;
  for (let py = Math.floor(y - max); py <= Math.ceil(y + max); py++) {
    for (let px = Math.floor(x - max); px <= Math.ceil(x + max); px++) {
      if (px < 0 || py < 0 || px >= cut.width || py >= cut.height) continue;
      const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
      if (d <= max && cut.data[py * cut.width + px] === null) r = Math.max(r, d);
    }
  }
  return r;
}

if (typeof module !== "undefined") module.exports = { robustStats, diffImage, DIFF_SIGMAS, DIFF_FLOOR, aperturePhotometry, APERTURE, MJY_PER_MJYSR_PIXEL, coreHoleRadius };
