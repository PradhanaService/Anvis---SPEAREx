"""Live checks against the real IRSA and MAST services (need internet; skipped by default).

    ANVIS_LIVE=1 python -m pytest -q tests/test_live.py

They confirm the services still answer the way the app expects: every preset has SPHEREx
images, a real cutout becomes a sensible frame, and Gaia returns Barnard's Star.
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app  # noqa: E402

pytestmark = pytest.mark.skipif(os.environ.get("ANVIS_LIVE") != "1", reason="set ANVIS_LIVE=1 to run live checks")

PRESETS = {   # the same positions as PRESETS in static/app.js
    "WISE 0855": (133.795129, -7.245147),
    "Barnard's Star": (269.446259, 4.768324),
    "Epsilon Indi B": (331.096669, -56.800649),
    "RW Aurigae": (76.956526, 30.401438),
    "R Draconis": (248.167611, 66.754979),
}


@pytest.fixture(scope="module")
def client():
    return app.app.test_client()


@pytest.mark.parametrize("name", PRESETS)
def test_preset_has_spherex_images(client, name):
    ra, dec = PRESETS[name]
    d = client.get(f"/api/frames?ra={ra}&dec={dec}&band=SPHEREx-D3").get_json()
    assert len(d["frames"]) >= 10, name
    mjds = [f["mjd"] for f in d["frames"]]
    assert mjds == sorted(mjds)


def test_real_cutout_becomes_a_frame(client):
    ra, dec = PRESETS["RW Aurigae"]
    f0 = client.get(f"/api/frames?ra={ra}&dec={dec}&band=SPHEREx-D3").get_json()["frames"][0]
    r = client.get(f"/api/cutout?ra={ra}&dec={dec}&size=240&width=600&url={f0['url']}")
    f = r.get_json()
    assert r.status_code == 200 and (f["width"], f["height"]) == (98, 39)
    assert 1.6 < f["wavelength_um"] < 2.45                     # inside detector 3's range
    assert sum(v is not None for v in f["data"]) > 0.9 * len(f["data"])


def test_cutouts_stream_real_frames(client):
    ra, dec = PRESETS["R Draconis"]
    urls = [f["url"] for f in client.get(f"/api/frames?ra={ra}&dec={dec}&band=SPHEREx-D3").get_json()["frames"][:3]]
    r = client.post(f"/api/cutouts?ra={ra}&dec={dec}&size=240&width=600", json={"urls": urls})
    lines = [json.loads(l) for l in r.data.decode().splitlines()]
    assert sorted(m["i"] for m in lines) == [0, 1, 2]
    assert all("frame" in m for m in lines)


def test_gaia_returns_barnards_star(client):
    ra, dec = PRESETS["Barnard's Star"]
    d = client.get(f"/api/gaia?ra={ra}&dec={dec}&radius=0.05&gmax=19").get_json()
    barnard = [s for s in d["stars"] if s[0] == "4472832130942575872"]
    assert barnard and barnard[0][4] > 10000                    # +10.36″/yr northward motion


def test_wise_returns_wise_0855(client):
    d = client.get("/api/wise?ra=133.795129&dec=-7.245147&radius=0.05&w2max=17").get_json()
    assert d["catalog"] in ("CatWISE2020", "AllWISE")
    fast = [s for s in d["sources"] if s[3] is not None and (s[3] ** 2 + s[4] ** 2) ** 0.5 > 7000]
    assert fast and all(s[5] is None or s[5] - s[6] > 1 for s in fast)     # ~8″/yr and very red
