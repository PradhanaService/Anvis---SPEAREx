"""Offline tests for the disk cache and gzip replies (app.py). No network.

    python -m pytest -q tests/test_cache.py
"""

import gzip
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app  # noqa: E402
from test_backend import SPX, FakeResponse, _sky_cutout  # noqa: E402


@pytest.fixture
def disk(tmp_path, monkeypatch):
    """A disk cache in a temporary folder, and empty memory caches."""
    monkeypatch.setattr(app, "DISK_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(app, "DISK_CACHE_MB", 100.0)
    monkeypatch.setattr(app, "_frames", app.FrameCache(int(50e6)))
    for f in (app.sia_rows, app.gaia_cone, app.wise_cone):
        f.cache_clear()
    yield tmp_path
    for f in (app.sia_rows, app.gaia_cone, app.wise_cone):
        f.cache_clear()


@pytest.fixture
def client():
    app.app.config["TESTING"] = True
    return app.app.test_client()


def test_disk_put_get_and_age(disk):
    app.disk_put("x", ("a", 1), b"hello")
    assert app.disk_get("x", ("a", 1)) == b"hello"
    assert app.disk_get("x", ("a", 2)) is None
    path = app._disk_path("x", ("a", 1))
    os.utime(path, (1, 1))                                   # pretend it was written long ago
    assert app.disk_get("x", ("a", 1), max_age=60) is None
    assert app.disk_get("x", ("a", 1)) == b"hello"           # still there without an age limit
    with open(path, "wb") as f:
        f.write(b"not gzip")                                 # a damaged file is a miss, not an error
    assert app.disk_get("x", ("a", 1)) is None


def test_disk_trim_removes_the_oldest_first(disk, monkeypatch):
    monkeypatch.setattr(app, "DISK_CACHE_MB", 0.003)          # 3 kB
    for i in range(5):
        app.disk_put("t", i, os.urandom(1000))               # random bytes don't compress
        os.utime(app._disk_path("t", i), (1000 + i, 1000 + i))
    app.disk_trim()
    left = [i for i in range(5) if os.path.exists(app._disk_path("t", i))]
    assert left and left == list(range(5 - len(left), 5))    # the newest ones survive
    assert sum(os.path.getsize(app._disk_path("t", i)) for i in left) <= 0.9 * 3000


def test_disk_cache_off_does_nothing(disk, monkeypatch):
    monkeypatch.setattr(app, "DISK_CACHE_MB", 0.0)
    app.disk_put("x", 1, b"data")
    assert app.disk_get("x", 1) is None and not os.listdir(disk)


def test_frame_layers_survive_a_restart(disk, monkeypatch):
    calls = []

    def fake(url, ra, dec, size):
        calls.append(url)
        return _sky_cutout(ra, dec, (12.3, 0.0))
    monkeypatch.setattr(app, "fetch_cutout", fake)
    first = app.make_frame(SPX, 150.0, 20.0, 120, 180)
    monkeypatch.setattr(app, "_frames", app.FrameCache(int(50e6)))   # "restart": memory is empty
    again = app.make_frame(SPX, 150.0, 20.0, 120, 180)
    assert calls == [SPX] and again == first                         # read from disk, identical


def test_search_is_saved_and_used_while_irsa_is_down(disk, client, monkeypatch):
    csv_text = ("energy_bandpassname,dataproduct_subtype,access_url,obs_id,obs_collection,t_min\n"
                f"SPHEREx-D3,science,{SPX},A,spherex_dr1,60800\n")
    monkeypatch.setattr(app, "remote_get", lambda *a, **k: FakeResponse(200, text=csv_text))
    assert len(client.get("/api/frames?ra=10&dec=10&band=SPHEREx-D3").get_json()["frames"]) == 1
    app.sia_rows.cache_clear()
    monkeypatch.setattr(app, "remote_get", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("IRSA down")))
    assert len(client.get("/api/frames?ra=10&dec=10&band=SPHEREx-D3").get_json()["frames"]) == 1   # fresh copy
    os.utime(app._disk_path("sia", (10.0, 10.0, app.COLLECTIONS)), (1, 1))
    app.sia_rows.cache_clear()
    assert len(client.get("/api/frames?ra=10&dec=10&band=SPHEREx-D3").get_json()["frames"]) == 1   # stale, IRSA down
    r = client.get("/api/frames?ra=11&dec=10&band=SPHEREx-D3")                                     # never searched
    assert r.status_code == 502


def test_only_complete_stacks_are_saved(disk, client, monkeypatch):
    results = iter([{"width": 1, "height": 1, "data": [1.0], "n_failed": 1},
                    {"width": 1, "height": 1, "data": [2.0], "n_failed": 0}])
    monkeypatch.setattr(app, "make_stack", lambda *a: next(results))
    q, body = "/api/stack?ra=10&dec=10&size=120", {"urls": [SPX]}
    client.post(q, json=body)
    assert not [n for n in os.listdir(disk) if n.startswith("stack-")]
    monkeypatch.setattr(app, "_frames", app.FrameCache(int(50e6)))
    client.post(q, json=body)
    assert [n for n in os.listdir(disk) if n.startswith("stack-")]
    monkeypatch.setattr(app, "_frames", app.FrameCache(int(50e6)))
    monkeypatch.setattr(app, "make_stack", lambda *a: pytest.fail("should come from disk"))
    assert json.loads(client.post(q, json=body).data)["data"] == [2.0]


def test_json_replies_are_gzipped_when_accepted(client, monkeypatch):
    big = json.dumps({"stars": [[str(i), 1.0, 2.0] for i in range(500)]})
    monkeypatch.setattr(app, "gaia_cone", lambda *a: big)
    r = client.get("/api/gaia?ra=10&dec=10", headers={"Accept-Encoding": "gzip, deflate"})
    assert r.headers["Content-Encoding"] == "gzip" and gzip.decompress(r.data).decode() == big
    assert "gzip" in r.headers["Vary"] or r.headers["Vary"] == "Accept-Encoding"
    assert client.get("/api/gaia?ra=10&dec=10").data.decode() == big        # not asked for: plain
    monkeypatch.setattr(app, "gaia_cone", lambda *a: '{"stars":[]}')
    small = client.get("/api/gaia?ra=10&dec=10", headers={"Accept-Encoding": "gzip"})
    assert "Content-Encoding" not in small.headers                          # small replies are left alone


def test_streamed_cutouts_are_not_gzipped(client, monkeypatch):
    monkeypatch.setattr(app, "frame_json", lambda *a: json.dumps({"data": [0.0] * 3000}))
    r = client.post("/api/cutouts?ra=10&dec=10", json={"urls": [SPX]}, headers={"Accept-Encoding": "gzip"})
    assert "Content-Encoding" not in r.headers and json.loads(r.data.decode().splitlines()[0])["i"] == 0
