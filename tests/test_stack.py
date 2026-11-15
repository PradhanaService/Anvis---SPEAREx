"""Offline tests for survey epochs and per-epoch stacking (app.py).

No network: IRSA cutouts are replaced with synthetic images whose noise is known.

    python -m pytest -q tests/test_stack.py
"""

import json
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app  # noqa: E402
from test_backend import SPX, _sky_cutout  # noqa: E402


@pytest.fixture
def client():
    app.app.config["TESTING"] = True
    return app.app.test_client()


@pytest.fixture(autouse=True)
def empty_cache():
    """Each test starts with an empty frame/layer/stack cache (they share one)."""
    app._frames = app.FrameCache(int(50e6))
    yield


# ----------------------------------------------------------------------------- epochs
def test_group_epochs_splits_on_gaps():
    mjds = [100, 101, 110, 130,          # gaps up to 20 days: one epoch
            300, 302,                    # 170-day gap: a new epoch
            500]                         # and another
    assert app.group_epochs(mjds) == [(0, 3), (4, 5), (6, 6)]


def test_group_epochs_gap_rule_is_strictly_greater():
    g = app.EPOCH_GAP_DAYS
    assert app.group_epochs([0, g]) == [(0, 1)]                   # exactly the gap: same epoch
    assert app.group_epochs([0, g + 0.01]) == [(0, 0), (1, 1)]


def test_group_epochs_caps_epoch_length():
    # Near the ecliptic poles there may be no gaps at all: every 10 days for a year.
    mjds = list(range(0, 365, 10))
    epochs = app.group_epochs(mjds)
    assert len(epochs) > 1
    for a, b in epochs:
        assert mjds[b] - mjds[a] <= app.EPOCH_MAX_DAYS
    assert epochs[0][0] == 0 and epochs[-1][1] == len(mjds) - 1   # every frame in exactly one epoch
    assert all(epochs[k][1] + 1 == epochs[k + 1][0] for k in range(len(epochs) - 1))


def test_group_epochs_empty():
    assert app.group_epochs([]) == []


def test_frames_endpoint_adds_epochs_without_changing_frames(client, monkeypatch):
    def row(obs, mjd):
        return {"energy_bandpassname": "SPHEREx-D3", "dataproduct_subtype": "science", "access_url": SPX,
                "obs_id": obs, "obs_collection": "spherex_dr1", "t_min": str(mjd)}
    rows = (row("A", 60800), row("B", 60805), row("C", 61000), row("D", 61002), row("E", 61004))
    monkeypatch.setattr(app, "sia_rows", lambda ra, dec: rows)
    d = client.get("/api/frames?ra=10&dec=10&band=SPHEREx-D3").get_json()
    assert set(d["frames"][0]) == {"obs_id", "collection", "mjd", "date", "url", "epoch"}
    assert [f["epoch"] for f in d["frames"]] == [0, 0, 1, 1, 1]
    e = d["epochs"]
    assert [(x["first"], x["last"], x["n"]) for x in e] == [(0, 1, 2), (2, 4, 3)]
    assert e[1]["start_mjd"] == 61000 and e[1]["end_mjd"] == 61004 and e[1]["start"] == "2025-11-21 00:00:00"
    assert d["epoch_rule"] == {"gap_days": app.EPOCH_GAP_DAYS, "max_days": app.EPOCH_MAX_DAYS}


# ----------------------------------------------------------------------------- stacking math
def _layers(image, variance, bad=None):
    image = np.asarray(image, float)
    return {"image": image, "variance": np.asarray(variance, float),
            "bad": np.zeros(image.shape, bool) if bad is None else np.asarray(bad, bool)}


def test_combine_is_inverse_variance_weighted():
    a = _layers([[1.0]], [1.0])       # weight 1
    b = _layers([[4.0]], [0.5])       # weight 2
    mean, var, n, fallback = app.combine([a, b])
    assert mean[0, 0] == pytest.approx((1 * 1 + 4 * 2) / 3)
    assert var[0, 0] == pytest.approx(1 / 3)
    assert n[0, 0] == 2 and fallback == 0


def test_combine_skips_bad_pixels():
    a = _layers([[1.0, 1.0]], [1.0, 1.0])
    b = _layers([[1000.0, 3.0]], [1.0, 1.0], bad=[[True, False]])   # a cosmic ray, flagged
    mean, var, n, _ = app.combine([a, b])
    assert mean[0, 0] == 1.0 and n[0, 0] == 1 and var[0, 0] == 1.0
    assert mean[0, 1] == 2.0 and n[0, 1] == 2


def test_combine_uses_flagged_values_only_where_nothing_else_exists():
    # A saturated star core flagged in every frame: averaged anyway instead of a hole.
    a = _layers([[10.0, 1.0]], [1.0, 1.0], bad=[[True, False]])
    b = _layers([[20.0, 1.0]], [1.0, 1.0], bad=[[True, False]])
    mean, _, n, fallback = app.combine([a, b])
    assert mean[0, 0] == 15.0 and n[0, 0] == 0 and fallback == 1
    # No finite value at all: no data.
    c = _layers([[np.nan]], [np.nan], bad=[[True]])
    mean, _, _, fallback = app.combine([c, c])
    assert np.isnan(mean[0, 0]) and fallback == 0


def test_combine_reduces_noise_as_expected():
    rng = np.random.default_rng(1)
    sigma, k = 2.0, 16
    frames = [_layers(rng.normal(5.0, sigma, (200, 200)), np.full((200, 200), sigma ** 2)) for _ in range(k)]
    mean, var, _, _ = app.combine(frames)
    assert np.std(mean) == pytest.approx(sigma / np.sqrt(k), rel=0.05)    # measured noise: sigma / sqrt(k)
    assert np.sqrt(var).mean() == pytest.approx(sigma / np.sqrt(k))       # and the reported one agrees
    assert np.mean(mean) == pytest.approx(5.0, abs=0.01)


# ----------------------------------------------------------------------------- /api/stack
def test_make_stack_lines_up_frames_and_reports_the_epoch(monkeypatch):
    ra0, dec0 = 150.0, 20.0
    rotations = {"a.fits": 10.0, "b.fits": 75.0, "c.fits": 200.0}     # each visit rotated differently

    def fake_cutout(url, ra, dec, size):
        h = _sky_cutout(ra0, dec0, (-36.9, 61.5), rotation_deg=rotations[url.rsplit("/", 1)[1]])
        h["IMAGE"].header["MJD-AVG"] = 60800.0 + list(rotations).index(url.rsplit("/", 1)[1])
        return h
    monkeypatch.setattr(app, "fetch_cutout", fake_cutout)
    urls = [app.DATA_PREFIX + "x/" + k for k in rotations]
    s = app.make_stack(urls, ra0, dec0, 240, 300)
    assert (s["width"], s["height"]) == (round(300 / 6.15), round(240 / 6.15))
    img = np.array([np.nan if v is None else v for v in s["data"]]).reshape(s["height"], s["width"])
    y, x = np.unravel_index(np.nanargmax(img), img.shape)
    assert y == pytest.approx(s["height"] / 2 - 10, abs=1)              # same place as in make_frame
    assert x == pytest.approx(s["width"] / 2 + 6, abs=1)
    assert (s["n_frames"], s["n_used"], s["n_failed"]) == (3, 3, 0)
    assert (s["mjd_start"], s["mjd_end"]) == (60800.0, 60802.0)
    assert s["quality"] == [] and s["unit"] == "MJy/sr"


def test_make_stack_survives_some_failed_frames(monkeypatch):
    def fake_cutout(url, ra, dec, size):
        if url.endswith("bad.fits"):
            raise RuntimeError("IRSA busy")
        return _sky_cutout(ra, dec, (0, 0))
    monkeypatch.setattr(app, "fetch_cutout", fake_cutout)
    s = app.make_stack([app.DATA_PREFIX + "x/ok.fits", app.DATA_PREFIX + "x/bad.fits"], 150.0, 20.0, 120, 120)
    assert (s["n_used"], s["n_failed"]) == (1, 1)
    monkeypatch.setattr(app, "fetch_cutout", lambda *a: (_ for _ in ()).throw(RuntimeError("down")))
    with pytest.raises(RuntimeError):
        app.make_stack([app.DATA_PREFIX + "x/other.fits"], 150.0, 20.0, 120, 120)


@pytest.mark.parametrize("query, body", [
    ("ra=10&dec=10", {"urls": []}),                                     # no frames
    ("ra=10&dec=10", {"nope": [SPX]}),                                  # wrong body
    ("ra=10&dec=10", {"urls": ["https://example.com/a.fits"]}),          # not IRSA SPHEREx
    ("ra=10&dec=10", {"urls": [SPX + "?x=1"]}),                         # query string
    ("ra=10&dec=10&size=10", {"urls": [SPX]}),                          # field too small
    ("ra=10&dec=10&width=5000", {"urls": [SPX]}),                       # field too wide
    ("ra=400&dec=10", {"urls": [SPX]}),                                 # bad position
    ("ra=10&dec=10", {"urls": [SPX] * (app.MAX_BATCH + 1)}),            # too many
])
def test_stack_rejects_bad_requests(client, query, body):
    r = client.post(f"/api/stack?{query}", json=body)
    assert r.status_code == 400 and "error" in r.get_json()


def test_stack_endpoint_caches_and_thins(client, monkeypatch):
    calls = []

    def fake_stack(urls, ra, dec, size, width):
        calls.append(list(urls))
        return {"width": 1, "height": 1, "data": [1.0], "n_frames": len(urls)}
    monkeypatch.setattr(app, "make_stack", fake_stack)
    urls = [app.DATA_PREFIX + f"x/{i}.fits" for i in range(app.MAX_STACK_FRAMES + 50)]
    r1 = client.post("/api/stack?ra=10&dec=10&size=120", json={"urls": urls})
    r2 = client.post("/api/stack?ra=10&dec=10&size=120", json={"urls": urls})
    assert r1.status_code == 200 and json.loads(r1.data) == json.loads(r2.data)
    assert len(calls) == 1 and len(calls[0]) == app.MAX_STACK_FRAMES       # second reply from the cache


def test_stack_endpoint_reports_irsa_failure(client, monkeypatch):
    monkeypatch.setattr(app, "make_stack", lambda *a: (_ for _ in ()).throw(RuntimeError("IRSA down")))
    r = client.post("/api/stack?ra=10&dec=10", json={"urls": [SPX]})
    assert r.status_code == 502 and "IRSA down" in r.get_json()["error"]


def test_frame_layers_are_cached_for_frames_and_stacks(monkeypatch):
    n = []

    def fake_cutout(url, ra, dec, size):
        n.append(url)
        return _sky_cutout(ra, dec, (0, 0))
    monkeypatch.setattr(app, "fetch_cutout", fake_cutout)
    app.make_stack([SPX], 150.0, 20.0, 120, 120)
    app.make_frame(SPX, 150.0, 20.0, 120, 120)          # the single frame reuses the stack's download
    assert n == [SPX]
