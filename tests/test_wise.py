"""Offline tests for /api/wise (CatWISE2020 / AllWISE from IRSA). No network: replies are faked.

    python -m pytest -q tests/test_wise.py
"""

import io
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app  # noqa: E402
from test_backend import FakeResponse  # noqa: E402


@pytest.fixture
def client():
    app.app.config["TESTING"] = True
    return app.app.test_client()


@pytest.fixture(autouse=True)
def fresh():
    """Empty cache and no remembered TAP failure for every test."""
    app.wise_cone.cache_clear()
    app._tap_down_until = 0.0
    yield
    app.wise_cone.cache_clear()


TAP_CSV = ("source_name,ra,dec,pmra,pmdec,w1mpro,w2mpro\n"
           "J085508.34-071439.2,133.7847613,-7.2442498,-7.965,0.8062,18.507,15.721\n"
           "J085501.95-071428.2,133.7581637,-7.2411758,-0.00588,-0.0104,15.037,15.202\n"
           "J000000.00-000000.0,133.75,-7.24,,,,12.5\n")              # missing values

def _gator(name_col):
    """A Gator reply (IPAC table) with one fast-moving source; motions in mas/yr (as in AllWISE)."""
    from astropy.io import ascii
    from astropy.table import Table
    t = Table(rows=[("J085505.00-071430.0", 133.770833, -7.241667, -8100, 700, 17.9, 14.1)],
              names=(name_col, "ra", "dec", "pmra", "pmdec", "w1mpro", "w2mpro"))
    out = io.StringIO()
    ascii.write(t, out, format="ipac")
    return out.getvalue()


def test_wise_from_tap_converts_units_and_sorts(client, monkeypatch):
    calls = []

    def fake(url, params=None, **k):
        calls.append(url)
        return FakeResponse(200, text=TAP_CSV)
    monkeypatch.setattr(app, "remote_get", fake)
    d = client.get("/api/wise?ra=133.76&dec=-7.24&radius=0.05").get_json()
    assert calls == [app.IRSA_TAP]
    assert (d["catalog"], d["service"], d["epoch_mjd"]) == ("CatWISE2020", "IRSA TAP", 57170.0)
    assert [s[0] for s in d["sources"]] == ["J000000.00-000000.0", "J085501.95-071428.2", "J085508.34-071439.2"]   # by W2
    fast = d["sources"][2]
    assert fast[3] == -7965.0 and fast[4] == 806.2                  # arcsec/yr -> mas/yr
    assert d["sources"][0][3:6] == [None, None, None]               # missing values stay missing


def test_wise_falls_back_to_gator_and_remembers_tap_is_down(client, monkeypatch):
    calls = []

    def fake(url, params=None, **k):
        calls.append((url, params.get("catalog")))
        if url == app.IRSA_TAP:
            raise RuntimeError("IRSA is busy or unavailable")
        return FakeResponse(200, text=_gator("source_name"))
    monkeypatch.setattr(app, "remote_get", fake)
    d = client.get("/api/wise?ra=133.76&dec=-7.24&radius=0.05").get_json()
    assert (d["catalog"], d["service"]) == ("CatWISE2020", "IRSA Gator")
    assert d["sources"][0][0] == "J085505.00-071430.0"
    assert calls == [(app.IRSA_TAP, None), (app.IRSA_GATOR, "catwise_2020")]
    calls.clear()
    client.get("/api/wise?ra=10&dec=10&radius=0.05")                # another field: TAP is skipped for now
    assert calls == [(app.IRSA_GATOR, "catwise_2020")]


def test_wise_falls_back_to_allwise_in_mas_per_year(client, monkeypatch):
    def fake(url, params=None, **k):
        if url == app.IRSA_GATOR and params["catalog"] == "allwise_p3as_psd":
            return FakeResponse(200, text=_gator("designation"))
        raise RuntimeError("down")
    monkeypatch.setattr(app, "remote_get", fake)
    d = client.get("/api/wise?ra=133.76&dec=-7.24&radius=0.05").get_json()
    assert (d["catalog"], d["epoch_mjd"]) == ("AllWISE", 55400.0)
    assert d["sources"][0][3:] == [-8100.0, 700.0, 17.9, 14.1]     # AllWISE motions are already mas/yr


def test_wise_reports_failure(client, monkeypatch):
    monkeypatch.setattr(app, "remote_get", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("IRSA down")))
    r = client.get("/api/wise?ra=133.76&dec=-7.24")
    assert r.status_code == 502 and "IRSA down" in r.get_json()["error"]


@pytest.mark.parametrize("query", ["ra=10&dec=10&radius=0.5", "ra=10&dec=10&radius=0.0001",
                                   "ra=10&dec=10&w2max=30", "ra=10&dec=10&w2max=x", "dec=10", "ra=10&dec=95"])
def test_wise_rejects_bad_requests(client, query):
    r = client.get(f"/api/wise?{query}")
    assert r.status_code == 400 and "error" in r.get_json()
