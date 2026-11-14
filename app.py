"""Anvis (SPHEREx time viewer): a small Flask backend.

All SPHEREx data comes from NASA/IPAC IRSA:
  * Frame list: IRSA Simple Image Access (SIA) service, collections
    spherex_dr1 and spherex_qr3 (as in the "Introduction to SPHEREx
    Spectral Images" tutorial notebook).
  * Pixels: IRSA's cutout service, appended to each spectral image URL as
    ?center=<ra>,<dec>d&size=<deg> (as in the "SPHEREx Spectral Image
    Cutouts" tutorial notebook).

The browser can't call IRSA directly (no CORS headers), so this server
fetches for it and returns small JSON arrays.
"""

import concurrent.futures as cf
import csv
import io
import json
import logging
import os
import re
import threading
import time
import warnings
from collections import OrderedDict
from functools import lru_cache

import numpy as np
import requests
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from flask import Flask, Response, jsonify, request, send_from_directory

warnings.filterwarnings("ignore")
logging.getLogger("astropy").setLevel(logging.ERROR)

IRSA = "https://irsa.ipac.caltech.edu"
SIA_URL = IRSA + "/SIA"
DATA_PREFIX = IRSA + "/ibe/data/spherex/"
COLLECTIONS = ["spherex_dr1", "spherex_qr3"]  # DR1 + QR3 (QR2 is superseded)
BANDS = [f"SPHEREx-D{i}" for i in range(1, 7)]
PIXEL_SCALE = 6.15 / 3600.0  # deg/pixel, native SPHEREx scale
MAX_SIZE_ARCSEC = 1800    # field height (and width, for square fields)
MAX_WIDTH_ARCSEC = 1800   # field width for wide fields
USER_AGENT = "anvis/1.0"

# Be polite to IRSA: limit concurrent cutout downloads from this server.
_irsa_slots = threading.Semaphore(10)
# Worker threads for /api/cutouts (each one waits on _irsa_slots before calling IRSA).
_pool = cf.ThreadPoolExecutor(max_workers=10)
MAX_BATCH = 400

app = Flask(__name__, static_folder="static", static_url_path="")
session = requests.Session()
session.headers["User-Agent"] = USER_AGENT


def bad(msg, code=400):
    return jsonify({"error": msg}), code


def parse_position():
    try:
        ra = float(request.args["ra"])
        dec = float(request.args["dec"])
    except (KeyError, ValueError):
        raise ValueError("ra and dec must be numbers in decimal degrees")
    if not (0 <= ra < 360 and -90 <= dec <= 90):
        raise ValueError("ra must be in [0, 360) and dec in [-90, 90]")
    return ra, dec


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


SIA_COLUMNS = ("energy_bandpassname", "dataproduct_subtype", "access_url", "obs_id", "obs_collection", "t_min")


@lru_cache(maxsize=256)
def sia_rows(ra, dec):
    """All SPHEREx images (every band) covering a position, from IRSA's SIA service. Cached."""
    params = [("POS", f"circle {ra} {dec} 0.0005"), ("RESPONSEFORMAT", "CSV"), ("MAXREC", "20000")]
    params += [("COLLECTION", c) for c in COLLECTIONS]
    text = irsa_get(SIA_URL, params=params, timeout=120).text
    # Keep only the columns used below, so cached searches stay small.
    return tuple({k: row.get(k) for k in SIA_COLUMNS} for row in csv.DictReader(io.StringIO(text)))


@app.get("/api/frames")
def frames():
    """List all SPHEREx spectral images covering (ra, dec) in one band, oldest first."""
    try:
        ra, dec = parse_position()
    except ValueError as e:
        return bad(str(e))
    band = request.args.get("band", "SPHEREx-D2")
    if band not in BANDS:
        return bad("band must be one of " + ", ".join(BANDS))

    try:
        rows = sia_rows(round(ra, 6), round(dec, 6))
    except Exception as e:
        return bad(f"IRSA SIA query failed: {e}", 502)

    out, seen = [], set()
    for row in rows:
        if row.get("energy_bandpassname") != band or row.get("dataproduct_subtype") != "science":
            continue
        if not row["access_url"].startswith(DATA_PREFIX) or row["obs_id"] in seen:
            continue
        seen.add(row["obs_id"])
        mjd = float(row["t_min"])
        out.append({
            "obs_id": row["obs_id"],
            "collection": row["obs_collection"],
            "mjd": mjd,
            "date": Time(mjd, format="mjd").isot[:19].replace("T", " "),
            "url": row["access_url"],
        })
    out.sort(key=lambda f: f["mjd"])
    return jsonify({"ra": ra, "dec": dec, "band": band, "frames": out})


def irsa_get(url, params=None, timeout=180, tries=12, n_hdus=None):
    """GET from IRSA, retrying when it is busy or briefly unavailable (429/5xx).

    With n_hdus, read only the first n_hdus FITS HDUs of the response and return their bytes.
    """
    delay = 0.5
    for attempt in range(tries):
        try:
            with _irsa_slots:
                r = session.get(url, params=params, timeout=timeout, stream=n_hdus is not None)
                if r.status_code == 200:
                    if n_hdus is None:
                        return r
                    try:
                        return read_first_hdus(r.iter_content(65536), n_hdus)
                    finally:
                        r.close()
        except (requests.ConnectionError, requests.Timeout):
            r = None
        if r is not None and r.status_code not in (429, 500, 502, 503, 504):
            raise RuntimeError(f"IRSA error {r.status_code}: {r.text[:200]}")
        if attempt < tries - 1:
            time.sleep(delay)
            delay = min(delay * 1.5, 5.0)
    raise RuntimeError("IRSA is busy or unavailable; please try again later")


def read_first_hdus(chunks, n_hdus):
    """Read a streamed FITS file only up to the end of its first n_hdus HDUs.

    SPHEREx cutouts are ~4 MB, almost all of it the EPSF table (HDU 5) which this app
    doesn't use; IMAGE..ZODI (HDUs 1-4) are only a few kB, so we stop early.
    """
    buf, pos = bytearray(), 0
    chunks = iter(chunks)

    def need(n):
        while len(buf) < n:
            chunk = next(chunks, None)
            if chunk is None:
                raise RuntimeError("IRSA cutout ended early")
            buf.extend(chunk)

    for _ in range(n_hdus):
        cards, end = {}, False
        while not end:  # header: 2880-byte blocks of 80-char cards, ending with END
            need(pos + 2880)
            block = bytes(buf[pos:pos + 2880]).decode("ascii", "replace")
            pos += 2880
            for i in range(0, 2880, 80):
                card = block[i:i + 80]
                key = card[:8].strip()
                if key == "END":
                    end = True
                    break
                if card[8:10] == "= ":
                    cards[key] = card[10:].split("/")[0].strip()
        naxis = int(cards.get("NAXIS", 0))
        size = 0
        if naxis:
            size = 1
            for i in range(1, naxis + 1):
                size *= int(cards[f"NAXIS{i}"])
        size = abs(int(cards["BITPIX"])) // 8 * int(cards.get("GCOUNT", 1)) * (int(cards.get("PCOUNT", 0)) + size)
        pos += -(-size // 2880) * 2880  # data, padded to a whole block
    need(pos)
    return bytes(buf[:pos])


_wave_tables = {}  # (detector, pipeline version) -> WCS-WAVE table HDU
_wave_lock = threading.Lock()
# WCS-WAVE tables are also saved here, so they survive a server restart.
CACHE_DIR = os.environ.get("ANVIS_CACHE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache"))


def _wave_path(key):
    name = re.sub(r"[^A-Za-z0-9._-]", "_", f"wcswave_D{key[0]}_{key[1]}")
    return os.path.join(CACHE_DIR, name + ".fits")


def fetch_cutout(url, ra, dec, size_deg):
    """Get one cutout via IRSA's cutout service (tutorial: ?center=<ra>,<dec>d&size=<deg>).

    Returns an HDUList with PRIMARY, IMAGE, FLAGS, VARIANCE, ZODI and WCS-WAVE.
    WCS-WAVE (the wavelength lookup table) is identical for every image from the same
    detector and pipeline version, so it is downloaded once and reused.
    """
    full = f"{url}?center={ra},{dec}d&size={size_deg}"
    hdul = fits.HDUList.fromstring(irsa_get(full, n_hdus=5))
    if [h.name for h in hdul] != ["PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI"]:
        return fits.HDUList.fromstring(irsa_get(full).content)  # unexpected layout: take it all
    key = (hdul["IMAGE"].header.get("DETECTOR"), hdul[0].header.get("VERSION"))
    if key not in _wave_tables:
        with _wave_lock:
            if key not in _wave_tables:
                path = _wave_path(key)
                try:
                    with fits.open(path) as saved:
                        _wave_tables[key] = saved["WCS-WAVE"].copy()
                except (OSError, KeyError):
                    whole = fits.HDUList.fromstring(irsa_get(full).content)
                    _wave_tables[key] = whole["WCS-WAVE"].copy()
                    try:
                        os.makedirs(CACHE_DIR, exist_ok=True)
                        fits.HDUList([fits.PrimaryHDU(), _wave_tables[key].copy()]).writeto(path + ".tmp", overwrite=True)
                        os.replace(path + ".tmp", path)
                    except OSError:
                        pass  # caching is optional
    hdul.append(_wave_tables[key])
    return hdul


def bilinear(img, x, y):
    """Sample img at fractional pixel positions (x, y); NaN outside the image."""
    h, w = img.shape
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    ok = (x0 >= 0) & (y0 >= 0) & (x0 < w - 1) & (y0 < h - 1)
    x0c, y0c = np.clip(x0, 0, w - 2), np.clip(y0, 0, h - 2)
    fx, fy = x - x0c, y - y0c
    v = (img[y0c, x0c] * (1 - fx) * (1 - fy) + img[y0c, x0c + 1] * fx * (1 - fy)
         + img[y0c + 1, x0c] * (1 - fx) * fy + img[y0c + 1, x0c + 1] * fx * fy)
    return np.where(ok, v, np.nan)


# SPHEREx FLAGS planes that are informational rather than a data-quality problem.
INFO_FLAGS = {"FULLSAMPLE", "SOURCE"}


def target_flags(flags_hdu, xc, yc):
    """Quality flags set within 1 pixel of the target, named from the FLAGS header (MSKNnnnn)."""
    h, data = flags_hdu.header, flags_hdu.data
    xi, yi = int(round(float(xc))), int(round(float(yc)))
    if data is None or not (0 <= xi < data.shape[1] and 0 <= yi < data.shape[0]):
        return []
    box = data[max(0, yi - 1):yi + 2, max(0, xi - 1):xi + 2]
    bits = int(np.bitwise_or.reduce(box.ravel())) if box.size else 0
    out = []
    for key in h:
        if key.startswith("MSKN"):
            n = key[4:]
            mask, name = h.get("MSKM" + n), str(h[key])
            if mask and bits & int(mask) and name not in INFO_FLAGS:
                out.append({"name": name, "desc": str(h.get("MSKD" + n, ""))})
    return out


class FrameCache:
    """Least-recently-used cache of frames as JSON text, limited by total size in bytes.

    Frames are kept as JSON text (about a quarter of the memory of the Python objects) and the
    oldest are dropped once the total passes the limit (ANVIS_CACHE_MB, default 300 MB).
    """

    def __init__(self, max_bytes):
        self.max_bytes, self.total = max_bytes, 0
        self.items = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            text = self.items.get(key)
            if text is not None:
                self.items.move_to_end(key)
            return text

    def put(self, key, text):
        with self.lock:
            if key in self.items:
                self.total -= len(self.items.pop(key))
            self.items[key] = text
            self.total += len(text)
            while self.total > self.max_bytes and len(self.items) > 1:
                self.total -= len(self.items.popitem(last=False)[1])


_frames = FrameCache(int(float(os.environ.get("ANVIS_CACHE_MB", 300)) * 1e6))


def frame_json(url, ra, dec, size_arcsec, width_arcsec):
    """make_frame() as JSON text, through the size-limited cache."""
    key = (url, ra, dec, size_arcsec, width_arcsec)
    text = _frames.get(key)
    if text is None:
        text = json.dumps(make_frame(url, ra, dec, size_arcsec, width_arcsec), separators=(",", ":"))
        _frames.put(key, text)
    return text


def make_frame(url, ra, dec, size_arcsec, width_arcsec=None):
    """One frame: height size_arcsec, width width_arcsec (default: square)."""
    width_arcsec = width_arcsec or size_arcsec
    size_deg, width_deg = size_arcsec / 3600.0, width_arcsec / 3600.0
    # SPHEREx's detector is rotated differently on every visit, so request a square cutout
    # that covers the field's diagonal at any rotation.
    cover = (np.hypot(size_arcsec, width_arcsec) + 30) / 3600.0
    with fetch_cutout(url, ra, dec, round(cover, 5)) as hdul:
        header = hdul["IMAGE"].header
        # Zodiacal-light-subtracted surface brightness, as in the tutorial notebooks.
        image = hdul["IMAGE"].data.astype(float) - hdul["ZODI"].data.astype(float)
        sky = WCS(header)
        xc, yc = sky.world_to_pixel_values(ra, dec)
        # Central wavelength from the spectral WCS (key "W"), as in the cutouts tutorial.
        try:
            spec = WCS(header, fobj=hdul, key="W")
            spec.sip = None
            wavelength = float(np.asarray(spec.pixel_to_world_values(xc, yc)[0]))
        except Exception:
            wavelength = None
        mjd = header.get("MJD-AVG") or header.get("MJD-OBS")
        version = hdul[0].header.get("VERSION", "")
        quality = target_flags(hdul["FLAGS"], xc, yc)

    # Resample onto a common north-up, east-left grid so every frame lines up.
    ny = max(8, int(round(size_deg / PIXEL_SCALE)))
    nx = max(8, int(round(width_deg / PIXEL_SCALE)))
    grid = WCS(naxis=2)
    grid.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    grid.wcs.crval = [ra, dec]
    grid.wcs.crpix = [(nx + 1) / 2, (ny + 1) / 2]
    grid.wcs.cdelt = [-PIXEL_SCALE, PIXEL_SCALE]
    gy, gx = np.mgrid[0:ny, 0:nx]
    wra, wdec = grid.pixel_to_world_values(gx.ravel(), gy.ravel())
    sx, sy = sky.world_to_pixel_values(wra, wdec)
    out = bilinear(image, sx, sy).reshape(ny, nx)[::-1]  # row 0 = north (top of screen)

    data = [None if not np.isfinite(v) else round(float(v), 4) for v in out.ravel()]
    return {"width": nx, "height": ny, "pixel_scale_arcsec": PIXEL_SCALE * 3600,
            "data": data, "wavelength_um": wavelength, "quality": quality,
            "mjd_avg": mjd, "pipeline_version": version, "unit": "MJy/sr"}


@app.get("/api/cutout")
def cutout():
    try:
        ra, dec = parse_position()
        size = float(request.args.get("size", 180))
        width = float(request.args.get("width", size))
    except ValueError as e:
        return bad(str(e))
    url = request.args.get("url", "")
    if not url.startswith(DATA_PREFIX) or not url.endswith(".fits") or "?" in url:
        return bad("url must be an IRSA SPHEREx image URL")
    if not 30 <= size <= MAX_SIZE_ARCSEC:
        return bad(f"size must be between 30 and {MAX_SIZE_ARCSEC} arcsec")
    if not 30 <= width <= MAX_WIDTH_ARCSEC:
        return bad(f"width must be between 30 and {MAX_WIDTH_ARCSEC} arcsec")
    try:
        text = frame_json(url, round(ra, 6), round(dec, 6), round(size), round(width))
    except Exception as e:
        app.logger.warning("cutout failed for %s: %s", url, e)
        return bad(str(e), 502)
    resp = Response(text, mimetype="application/json")
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@app.post("/api/cutouts")
def cutouts():
    """Many frames in one request, streamed back as each is ready (one JSON object per line).

    Browsers open only ~6 connections per site, so one streamed request lets the server fetch
    10 frames from IRSA at a time. Lines: {"i": <index>, "frame": {...}} or {"i": <index>, "error": "..."}.
    """
    try:
        ra, dec = parse_position()
        size = float(request.args.get("size", 180))
        width = float(request.args.get("width", size))
    except ValueError as e:
        return bad(str(e))
    if not 30 <= size <= MAX_SIZE_ARCSEC:
        return bad(f"size must be between 30 and {MAX_SIZE_ARCSEC} arcsec")
    if not 30 <= width <= MAX_WIDTH_ARCSEC:
        return bad(f"width must be between 30 and {MAX_WIDTH_ARCSEC} arcsec")
    urls = (request.get_json(silent=True) or {}).get("urls")
    if not isinstance(urls, list) or not 1 <= len(urls) <= MAX_BATCH:
        return bad(f"body must be {{\"urls\": [...]}} with 1 to {MAX_BATCH} URLs")
    for url in urls:
        if not isinstance(url, str) or not url.startswith(DATA_PREFIX) or not url.endswith(".fits") or "?" in url:
            return bad("every url must be an IRSA SPHEREx image URL")
    args = (round(ra, 6), round(dec, 6), round(size), round(width))

    def generate():
        # Submitted in list order (time order), so early frames tend to arrive first.
        futures = {_pool.submit(frame_json, url, *args): i for i, url in enumerate(urls)}
        try:
            for fut in cf.as_completed(futures):
                i = futures[fut]
                try:
                    line = '{"i":%d,"frame":%s}' % (i, fut.result())
                except Exception as e:
                    app.logger.warning("cutout failed for %s: %s", urls[i], e)
                    line = json.dumps({"i": i, "error": str(e)})
                yield line + "\n"
        finally:  # the browser went away (new search, closed tab): drop work not yet started
            for fut in futures:
                fut.cancel()

    return Response(generate(), mimetype="application/x-ndjson")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, threaded=True)
