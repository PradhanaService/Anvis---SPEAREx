"""Offline tests for the Anvis backend (app.py).

Nothing here talks to IRSA or MAST: their replies are replaced with synthetic FITS images,
CSV rows and VOTables, so the tests are fast and repeatable.  Run from the project folder:

    python -m pytest -q tests/test_backend.py
"""

import io
import json
import os
import sys

import numpy as np
import pytest
from astropy.io import fits
from astropy.io.votable.tree import Field, Resource, TableElement, VOTableFile
from astropy.wcs import WCS

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app  # noqa: E402

SPX = app.DATA_PREFIX + "dr1/level2/2025W19_2B/x/1/level2_2025W19_2B_0001_1D3_spx_x.fits"


@pytest.fixture
def client():
    app.app.config["TESTING"] = True
    return app.app.test_client()


# ----------------------------------------------------------------------------- input checks
@pytest.mark.parametrize("query", [
    "",                                  # no position
    "ra=abc&dec=1",                      # not a number
    "ra=360&dec=0",                      # RA out of range
    "ra=10&dec=91",                      # Dec out of range
    "ra=nan&dec=0",                      # NaN is rejected too
])
def test_frames_rejects_bad_positions(client, query):
    r = client.get("/api/frames?" + query)
    assert r.status_code == 400 and "error" in r.get_json()


def test_frames_rejects_unknown_band(client):
    r = client.get("/api/frames?ra=10&dec=10&band=SPHEREx-D9")
    assert r.status_code == 400


@pytest.mark.parametrize("query", [
    "ra=10&dec=10&size=240&url=https://example.com/a.fits",     # not an IRSA SPHEREx URL
    f"ra=10&dec=10&size=240&url={SPX}?x=1",                      # extra query string
    f"ra=10&dec=10&size=10&url={SPX}",                           # field too small
    f"ra=10&dec=10&size=240&width=5000&url={SPX}",               # field too wide
])
def test_cutout_rejects_bad_requests(client, query):
    assert client.get("/api/cutout?" + query).status_code == 400


@pytest.mark.parametrize("body", [
    None,                                        # no body
    {"urls": []},                                # empty list
    {"urls": ["https://example.com/a.fits"]},    # foreign URL
    {"urls": [SPX] * (app.MAX_BATCH + 1)},       # too many
])
def test_cutouts_rejects_bad_bodies(client, body):
    r = client.post("/api/cutouts?ra=10&dec=10&size=240&width=600", json=body)
    assert r.status_code == 400


@pytest.mark.parametrize("query", ["ra=10&dec=10&radius=1", "ra=10&dec=10&radius=0.1&gmax=30", "dec=10"])
def test_gaia_rejects_bad_requests(client, query):
    assert client.get("/api/gaia?" + query).status_code == 400


def test_index_page(client):
    r = client.get("/")
    assert r.status_code == 200 and b"<title>Anvis" in r.data
    for asset in ("/app.js", "/style.css"):
        assert client.get(asset).status_code == 200


# ----------------------------------------------------------------------------- /api/frames
def test_frames_filters_sorts_and_dedupes(client, monkeypatch):
    rows = (
        {"energy_bandpassname": "SPHEREx-D3", "dataproduct_subtype": "science", "access_url": SPX,
         "obs_id": "B", "obs_collection": "spherex_dr1", "t_min": "60810.5"},
        {"energy_bandpassname": "SPHEREx-D3", "dataproduct_subtype": "science", "access_url": SPX,
         "obs_id": "A", "obs_collection": "spherex_dr1", "t_min": "60800.25"},
        {"energy_bandpassname": "SPHEREx-D3", "dataproduct_subtype": "science", "access_url": SPX,
         "obs_id": "A", "obs_collection": "spherex_qr3", "t_min": "60800.25"},          # duplicate obs_id
        {"energy_bandpassname": "SPHEREx-D2", "dataproduct_subtype": "science", "access_url": SPX,
         "obs_id": "C", "obs_collection": "spherex_dr1", "t_min": "60805"},             # other band
        {"energy_bandpassname": "SPHEREx-D3", "dataproduct_subtype": "cube", "access_url": SPX,
         "obs_id": "D", "obs_collection": "spherex_dr1", "t_min": "60805"},             # not a spectral image
        {"energy_bandpassname": "SPHEREx-D3", "dataproduct_subtype": "science", "access_url": "https://x/y.fits",
         "obs_id": "E", "obs_collection": "spherex_dr1", "t_min": "60805"},             # not on IRSA
    )
    monkeypatch.setattr(app, "sia_rows", lambda ra, dec: rows)
    d = client.get("/api/frames?ra=10&dec=10&band=SPHEREx-D3").get_json()
    assert [f["obs_id"] for f in d["frames"]] == ["A", "B"]          # oldest first, one per obs_id
    assert d["frames"][0]["date"] == "2025-05-05 06:00:00"            # MJD 60800.25 in UTC


def test_frames_reports_irsa_failure(client, monkeypatch):
    def boom(ra, dec):
        raise RuntimeError("IRSA is busy")
    monkeypatch.setattr(app, "sia_rows", boom)
    r = client.get("/api/frames?ra=10&dec=10&band=SPHEREx-D3")
    assert r.status_code == 502 and "IRSA" in r.get_json()["error"]


# ----------------------------------------------------------------------------- talking to IRSA
class FakeResponse:
    def __init__(self, status, content=b"", text=""):
        self.status_code, self.content, self.text = status, content, text

    def iter_content(self, n):
        for i in range(0, len(self.content), n):
            yield self.content[i:i + n]

    def close(self):
        pass


def test_remote_get_retries_busy_then_succeeds(monkeypatch):
    replies = [FakeResponse(503), FakeResponse(502), FakeResponse(200, b"ok")]
    monkeypatch.setattr(app.session, "get", lambda *a, **k: replies.pop(0))
    monkeypatch.setattr(app.time, "sleep", lambda s: None)
    assert app.remote_get("https://irsa/x").content == b"ok"


def test_remote_get_gives_up_and_raises_other_errors(monkeypatch):
    monkeypatch.setattr(app.time, "sleep", lambda s: None)
    monkeypatch.setattr(app.session, "get", lambda *a, **k: FakeResponse(503))
    with pytest.raises(RuntimeError, match="busy"):
        app.remote_get("https://irsa/x", tries=3)
    monkeypatch.setattr(app.session, "get", lambda *a, **k: FakeResponse(404, text="not found"))
    with pytest.raises(RuntimeError, match="404"):
        app.remote_get("https://irsa/x")


def _mef():
    """A small multi-extension FITS file shaped like a SPHEREx cutout (6 HDUs after PRIMARY)."""
    hdus = [fits.PrimaryHDU()]
    for name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI"):
        hdus.append(fits.ImageHDU(np.zeros((7, 9), np.float32), name=name))
    hdus.append(fits.BinTableHDU.from_columns([fits.Column("A", "D", array=np.arange(5000.0))], name="EPSF"))
    hdus.append(fits.BinTableHDU.from_columns([fits.Column("VALUES", "E", array=np.ones(3))], name="WCS-WAVE"))
    buf = io.BytesIO(); fits.HDUList(hdus).writeto(buf); return buf.getvalue()


def test_read_first_hdus_stops_after_zodi():
    raw = _mef()
    chunks = (raw[i:i + 1000] for i in range(0, len(raw), 1000))   # streamed in small pieces
    head = app.read_first_hdus(chunks, 5)
    hdul = fits.HDUList.fromstring(head)
    assert [h.name for h in hdul] == ["PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI"]
    epsf_start = fits.open(io.BytesIO(raw))["EPSF"].fileinfo()["hdrLoc"]
    assert len(head) == epsf_start           # stopped exactly where the big EPSF table begins


def test_read_first_hdus_detects_truncation():
    raw = _mef()
    with pytest.raises(RuntimeError, match="ended early"):
        app.read_first_hdus(iter([raw[:5000]]), 5)


# ----------------------------------------------------------------------------- frame building
def test_bilinear_interpolates_and_masks_outside():
    img = np.array([[0.0, 10.0], [20.0, 30.0]])
    v = app.bilinear(img, np.array([0.5, 0.0, 5.0]), np.array([0.5, 0.0, 0.0]))
    assert v[0] == pytest.approx(15.0) and v[1] == pytest.approx(0.0) and np.isnan(v[2])


def _flags_hdu(bits_at_target):
    data = np.zeros((11, 11), np.int32)
    data[5, 6] = bits_at_target                     # 1 pixel from the target at (5, 5)
    data[0, 0] = 1 << 22                            # far away: must not count
    h = fits.Header()
    for n, (name, desc) in enumerate([("TRANSIENT", "Transient"), ("OVERFLOW", "Overflow"),
                                      ("SOURCE", "Known source"), ("GHOST", "Ghost")]):
        bit = [0, 1, 21, 22][n]
        h[f"MSKN{bit:04d}"], h[f"MSKM{bit:04d}"], h[f"MSKD{bit:04d}"] = name, 1 << bit, desc
    return fits.ImageHDU(data, header=h, name="FLAGS")


def test_target_flags_names_only_bad_flags_near_target():
    hdu = _flags_hdu((1 << 1) | (1 << 21))          # OVERFLOW + SOURCE (SOURCE is informational)
    assert [f["name"] for f in app.target_flags(hdu, 5.0, 5.0)] == ["OVERFLOW"]
    assert app.target_flags(_flags_hdu(0), 5.0, 5.0) == []
    assert app.target_flags(hdu, 50.0, 50.0) == []                  # target off the image


def _sky_cutout(ra0, dec0, star_offset_arcsec, rotation_deg=30.0, n=61):
    """A synthetic cutout: rotated TAN WCS at 6.15"/px, constant zodi, one star at an offset."""
    s = 6.15 / 3600
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    th = np.radians(rotation_deg)
    w.wcs.cd = np.array([[-s * np.cos(th), s * np.sin(th)], [s * np.sin(th), s * np.cos(th)]])
    de, dn = star_offset_arcsec                     # east, north
    sra = ra0 + de / 3600 / np.cos(np.radians(dec0)); sdec = dec0 + dn / 3600
    sx, sy = w.world_to_pixel_values(sra, sdec)
    yy, xx = np.mgrid[0:n, 0:n]
    image = 5.0 + 1000.0 * np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * 0.8 ** 2))
    hdr = w.to_header(); hdr["MJD-AVG"] = 60800.0; hdr["DETECTOR"] = 3
    return fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(image.astype(np.float32), header=hdr, name="IMAGE"),
                         _flags_hdu(0), fits.ImageHDU(np.ones_like(image, np.float32), name="VARIANCE"),
                         fits.ImageHDU(np.full_like(image, 5.0, np.float32), name="ZODI")])


def test_make_frame_is_north_up_east_left(monkeypatch):
    ra0, dec0 = 150.0, 20.0
    monkeypatch.setattr(app, "fetch_cutout", lambda url, ra, dec, size: _sky_cutout(ra0, dec0, (-36.9, 61.5)))
    f = app.make_frame(SPX, ra0, dec0, 240, 300)
    assert (f["width"], f["height"]) == (round(300 / 6.15), round(240 / 6.15))
    img = np.array([np.nan if v is None else v for v in f["data"]]).reshape(f["height"], f["width"])
    y, x = np.unravel_index(np.nanargmax(img), img.shape)
    # The star is 61.5" (10 px) north and 36.9" (6 px) WEST of the centre: west is to the right.
    assert y == pytest.approx(f["height"] / 2 - 10, abs=1)
    assert x == pytest.approx(f["width"] / 2 + 6, abs=1)
    assert np.nanmedian(img) == pytest.approx(0.0, abs=0.01)        # zodi (5.0) subtracted
    assert f["mjd_avg"] == 60800.0 and f["unit"] == "MJy/sr" and f["quality"] == []


def test_frame_cache_is_limited_by_size():
    c = app.FrameCache(max_bytes=10)
    c.put("a", "1234"); c.put("b", "1234")
    assert c.get("a") == "1234"                     # a becomes most recently used
    c.put("c", "1234")                              # 12 bytes > 10: drop the least recent (b)
    assert c.get("b") is None and c.get("a") == "1234" and c.get("c") == "1234"
    c.put("a", "12")                                # replacing a key updates the total
    assert c.total == 6


# ----------------------------------------------------------------------------- /api/cutouts stream
def test_cutouts_streams_frames_and_errors(client, monkeypatch):
    other = SPX.replace("0001_1", "0002_1")

    def fake(url, *args):
        if url == other:
            raise RuntimeError("IRSA is busy")
        return json.dumps({"width": 1, "height": 1, "data": [1.0]})
    monkeypatch.setattr(app, "frame_json", fake)
    r = client.post("/api/cutouts?ra=10&dec=10&size=240&width=600", json={"urls": [SPX, other]})
    lines = sorted((json.loads(l) for l in r.data.decode().splitlines()), key=lambda m: m["i"])
    assert r.mimetype == "application/x-ndjson"
    assert lines[0] == {"i": 0, "frame": {"width": 1, "height": 1, "data": [1.0]}}
    assert lines[1]["i"] == 1 and "busy" in lines[1]["error"]


# ----------------------------------------------------------------------------- Gaia
def _votable(rows):
    vot = VOTableFile(); res = Resource(); vot.resources.append(res)
    t = TableElement(vot); res.tables.append(t)
    types = {"source_id": "long"}
    t.fields.extend(Field(vot, name=c, datatype=types.get(c, "double")) for c in app.GAIA_COLUMNS)
    t.create_arrays(len(rows))
    for i, r in enumerate(rows):
        t.array[i] = r
    buf = io.BytesIO(); vot.to_xml(buf); return buf.getvalue()


def test_gaia_keeps_big_ids_exact_and_handles_missing_values(client, monkeypatch):
    big = 4472832130942575872                      # Barnard's Star: too big for a JS number
    body = _votable([(big, 269.4485, 4.7394, -801.55, 10362.39, 546.98, 0.04, 8.19, 2.83),
                     (12, 269.45, 4.74, np.nan, np.nan, np.nan, np.nan, 18.5, np.nan)])
    monkeypatch.setattr(app, "remote_get", lambda *a, **k: FakeResponse(200, body))
    app.gaia_cone.cache_clear()
    d = client.get("/api/gaia?ra=269.44&dec=4.76&radius=0.05&gmax=19").get_json()
    assert d["stars"][0][0] == str(big) and d["stars"][0][4] == pytest.approx(10362.39)
    assert d["stars"][1][3] is None and d["stars"][1][8] is None     # missing proper motion / colour
    assert d["epoch"] == 2016.0 and d["truncated"] is False
