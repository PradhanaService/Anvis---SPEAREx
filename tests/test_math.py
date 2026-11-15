"""Tests for the image maths in static/anvis-math.js (difference images), run in node.

The page computes difference images in the browser; these checks run the same file with node,
so they need node on the PATH (skipped otherwise).

    python -m pytest -q tests/test_math.py
"""

import json
import os
import shutil
import subprocess

import numpy as np
import pytest

MATH_JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "anvis-math.js")
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")


def js(expr, **inputs):
    """Evaluate a JavaScript expression with anvis-math.js loaded and the inputs as variables."""
    lets = "".join(f"const {k} = {json.dumps(v)};\n" for k, v in inputs.items())
    code = f"const m = require({json.dumps(MATH_JS)});\n{lets}console.log(JSON.stringify({expr}));"
    out = subprocess.run([NODE, "-"], input=code, capture_output=True, text=True, check=True)   # stdin: inputs can be large
    return json.loads(out.stdout)


def cut(a):
    a = np.asarray(a, float)
    return {"width": a.shape[1], "height": a.shape[0], "pixel_scale_arcsec": 6.15,
            "data": [None if not np.isfinite(v) else float(v) for v in a.ravel()]}


def test_robust_stats_ignores_outliers_and_nulls():
    rng = np.random.default_rng(2)
    v = list(rng.normal(3.0, 0.5, 20000))
    v += [1000.0] * 500 + [None] * 100                 # bright stars and no-data pixels
    st = js("m.robustStats(v)", v=v)
    assert st["median"] == pytest.approx(3.0, abs=0.05)     # 2.5% outliers shift it only slightly
    assert st["sigma"] == pytest.approx(0.5, rel=0.05)
    assert st["n"] == 20500
    assert js("m.robustStats([null])", ) == {"median": 0, "sigma": 0, "n": 0}


def test_diff_removes_background_offset_and_scales_by_noise():
    rng = np.random.default_rng(3)
    ref = rng.normal(0.0, 0.1, (60, 60))
    cur = ref + 0.7 + rng.normal(0.0, 0.1, (60, 60))   # brighter sky everywhere, plus new noise
    d = js("m.diffImage(cur, ref)", cur=cut(cur), ref=cut(ref))
    assert d["offset"] == pytest.approx(0.7, abs=0.01)                 # the sky offset is removed
    assert d["sigma"] == pytest.approx(0.1, rel=0.1)                    # the noise of the change
    assert d["scale"] == js("m.DIFF_SIGMAS")                             # display: ±5σ
    z = np.array(d["data"], float)
    assert np.median(z) == pytest.approx(0.0, abs=0.05)
    assert np.std(z) == pytest.approx(1.0, rel=0.1)                     # z is in units of sigma


def test_diff_moving_star_gives_a_plus_minus_pair_and_constant_stars_cancel():
    rng = np.random.default_rng(4)
    yy, xx = np.mgrid[0:40, 0:40]
    star = lambda x, y, f: f * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / 2.0)   # noqa: E731
    noise = lambda: rng.normal(0.0, 0.01, (40, 40))                              # noqa: E731
    fixed = star(30, 30, 50.0) * 1.03                                            # constant star, 3% calibration mismatch
    ref = star(10, 20, 5.0) + star(30, 30, 50.0) + noise()
    cur = star(13, 20, 5.0) + fixed + noise()                                     # the faint star moved 3 px east
    d = js("m.diffImage(cur, ref)", cur=cut(cur), ref=cut(ref))
    z = np.array(d["data"], float).reshape(40, 40)
    assert z[20, 13] > 5 and z[20, 10] < -5            # appeared (+) at the new place, gone (−) at the old
    assert abs(z[30, 30]) < 1                          # the constant bright star cancels: its core
    assert np.abs(z[25:36, 25:36]).max() < 4           # and around it nothing beyond noise level
    ch = np.array(d["change"], float).reshape(40, 40)
    assert ch[30, 30] == pytest.approx(0.03 * 50, rel=0.1)   # the raw change is still reported in MJy/sr


def test_diff_keeps_no_data_and_rejects_different_grids():
    d = js("m.diffImage(a, b)", a=cut([[1.0, np.nan]]), b=cut([[1.0, 1.0]]))
    assert d["data"][1] is None and d["change"][1] is None
    with pytest.raises(subprocess.CalledProcessError):
        js("m.diffImage(a, b)", a=cut([[1.0, 2.0]]), b=cut([[1.0], [2.0]]))


# ----------------------------------------------------------------------------- photometry
def _star_field(flux_mjy, sky=0.3, size=31, sigma_px=0.9, noise=0.0, seed=5):
    """A star of known total flux (mJy) at the field centre on a flat sky (MJy/sr)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size] + 0.5
    k = js("m.MJY_PER_MJYSR_PIXEL")
    psf = np.exp(-((xx - size / 2) ** 2 + (yy - size / 2) ** 2) / (2 * sigma_px ** 2))
    psf /= psf.sum()
    return sky + flux_mjy / k * psf + rng.normal(0, noise, (size, size)) if noise else sky + flux_mjy / k * psf


def test_pixel_solid_angle_conversion():
    # One 6.15" pixel is 8.89e-10 sr, so 1 MJy/sr over it is 0.889 mJy.
    assert js("m.MJY_PER_MJYSR_PIXEL") == pytest.approx(0.889, abs=0.001)


def test_aperture_photometry_recovers_flux_and_removes_sky():
    img = _star_field(50.0, sky=0.3)
    p = js("m.aperturePhotometry(c, 15.5, 15.5)", c=cut(img))
    # An aperture flux: the 13 pixels within r = 2 px hold this share of the star's light.
    yy, xx = np.mgrid[0:31, 0:31] + 0.5
    inside = np.hypot(xx - 15.5, yy - 15.5) <= 2
    share = (_star_field(50.0, sky=0.0)[inside]).sum() * js("m.MJY_PER_MJYSR_PIXEL") / 50.0
    assert 0.85 < share < 0.95
    assert p["flux"] == pytest.approx(50.0 * share, rel=1e-6)
    assert p["sky"] == pytest.approx(0.3, abs=1e-6) and p["nbad"] == 0 and p["npix"] == 13


def test_aperture_photometry_error_and_changes():
    a = js("m.aperturePhotometry(c, 15.5, 15.5)", c=cut(_star_field(20.0, noise=0.05, seed=6)))
    b = js("m.aperturePhotometry(c, 15.5, 15.5)", c=cut(_star_field(30.0, noise=0.05, seed=7)))
    assert a["err"] > 0 and b["flux"] - a["flux"] == pytest.approx(10.0, abs=5 * a["err"] + 0.5)


def test_aperture_photometry_counts_missing_pixels_and_needs_sky():
    img = _star_field(50.0)
    img[15, 15] = np.nan
    p = js("m.aperturePhotometry(c, 15.5, 15.5)", c=cut(img))
    assert p["nbad"] == 1 and p["npix"] == 12
    assert js("m.aperturePhotometry(c, 1.5, 1.5)", c=cut(np.ones((3, 3)))) is None   # no room for a sky ring


def test_core_hole_and_ring_photometry_for_saturated_stars():
    img = _star_field(500.0, sigma_px=2.5)
    yy, xx = np.mgrid[0:31, 0:31] + 0.5
    hole = np.hypot(xx - 15.5, yy - 15.5) <= 2.2
    img[hole] = np.nan                                           # a saturated core: no data
    assert js("m.coreHoleRadius(c, 15.5, 15.5)", c=cut(img)) == pytest.approx(2.0)          # the farthest no-data pixel centre
    assert js("m.coreHoleRadius(c, 15.5, 15.5)", c=cut(_star_field(5.0))) == 0
    ap = {"r0": 3.5, "r": 6.5, "rin": 8.5, "rout": 12.5}
    ring = js("m.aperturePhotometry(c, 15.5, 15.5, ap)", c=cut(img), ap=ap)
    brighter = js("m.aperturePhotometry(c, 15.5, 15.5, ap)", c=cut(np.where(hole, np.nan, _star_field(1000.0, sigma_px=2.5))), ap=ap)
    assert ring["nbad"] == 0 and brighter["flux"] == pytest.approx(2 * ring["flux"], rel=0.02)   # the halo scales with the star


# ----------------------------------------------------------------------------- typed coordinates
@pytest.mark.parametrize("typed, deg", [
    ("210.8", 210.8), ("0", 0.0), ("359.999", 359.999),
    ("14 03 12.5", (14 + 3 / 60 + 12.5 / 3600) * 15),          # hours, minutes, seconds
    ("14h03m12.5s", (14 + 3 / 60 + 12.5 / 3600) * 15),
    ("14:03:12.5", (14 + 3 / 60 + 12.5 / 3600) * 15),
    ("14.05h", 14.05 * 15), ("8 55", (8 + 55 / 60) * 15),
    ("  133.795129  ", 133.795129),
])
def test_parse_ra_accepts_degrees_and_hours(typed, deg):
    assert js("m.parseRA(s)", s=typed) == pytest.approx(deg, abs=1e-9)


@pytest.mark.parametrize("typed", ["", "   ", "abc", "360", "400", "24 00 00", "25h"])
def test_parse_ra_rejects_bad_input(typed):
    assert js("m.parseRA(s)", s=typed) is None


@pytest.mark.parametrize("typed, deg", [
    ("54.34895", 54.34895), ("+54.34895", 54.34895), ("-7.245147", -7.245147),
    ("−07 14 42", -(7 + 14 / 60 + 42 / 3600)),                 # Unicode minus, as copied from papers
    ("-00 30 00", -0.5),                                        # the sign counts even for 0°
    ("+04 46 06", 4 + 46 / 60 + 6 / 3600), ("-56d48m02s", -(56 + 48 / 60 + 2 / 3600)),
    ("90", 90.0), ("-90", -90.0),
])
def test_parse_dec_accepts_degrees_and_dms(typed, deg):
    assert js("m.parseDec(s)", s=typed) == pytest.approx(deg, abs=1e-9)


@pytest.mark.parametrize("typed", ["", "north", "95", "-90.5", "91 00 00"])
def test_parse_dec_rejects_bad_input(typed):
    assert js("m.parseDec(s)", s=typed) is None
