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

if (typeof module !== "undefined") module.exports = { robustStats, diffImage, DIFF_SIGMAS, DIFF_FLOOR };
