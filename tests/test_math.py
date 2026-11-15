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
