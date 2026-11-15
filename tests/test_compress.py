"""Offline tests for the gzip-compressed JSON replies (app.py). No network.

    python -m pytest -q tests/test_compress.py
"""

import gzip
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app  # noqa: E402
from test_backend import SPX  # noqa: E402


@pytest.fixture
def client():
    app.app.config["TESTING"] = True
    return app.app.test_client()


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
