"""Anvis (SPHEREx time viewer): a small Flask backend.

All SPHEREx data comes from NASA/IPAC IRSA:
  * Frame list: IRSA Simple Image Access (SIA) service, collections
    spherex_dr1 and spherex_qr3 (as in the "Introduction to SPHEREx
    Spectral Images" tutorial notebook).
  * Pixels: IRSA's cutout service, appended to each spectral image URL as
    ?center=<ra>,<dec>d&size=<deg> (as in the "SPHEREx Spectral Image
    Cutouts" tutorial notebook).
Gaia DR3 stars for the overlay come from MAST (STScI) through its TAP service.

The browser can't call IRSA directly (no CORS headers), so this server
fetches for it and returns small JSON arrays.

Endpoints
  GET  /                 the web page (static/index.html)
  GET  /api/frames       SPHEREx images covering a position in one band, oldest first
  GET  /api/cutout       one frame: zodi-subtracted, resampled north-up (JSON)
  POST /api/cutouts      many frames, streamed back one JSON line each as they finish
  GET  /api/gaia         Gaia DR3 stars around a position
  GET  /api/collections  the SPHEREx releases searched (ANVIS_COLLECTIONS) and, at a position,
                         every SPHEREx collection IRSA has there

Caches (all in memory unless noted)
  * IRSA searches (sia_rows) and Gaia cones (gaia_cone): functools.lru_cache.
  * Processed frames: FrameCache, limited by size (ANVIS_CACHE_MB, default 300 MB).
  * WCS-WAVE wavelength tables: in memory and on disk in cache/ (ANVIS_CACHE).
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
from collections import Counter, OrderedDict
from functools import lru_cache

import numpy as np
import requests
from astropy.io import fits
from astropy.io.votable import parse_single_table
from astropy.time import Time
from astropy.wcs import WCS
from flask import Flask, Response, jsonify, request, send_from_directory

warnings.filterwarnings("ignore")
logging.getLogger("astropy").setLevel(logging.ERROR)

IRSA = "https://irsa.ipac.caltech.edu"
SIA_URL = IRSA + "/SIA"
DATA_PREFIX = IRSA + "/ibe/data/spherex/"
DEFAULT_COLLECTIONS = "spherex_dr1,spherex_qr3"   # DR1 + QR3 (QR2 is superseded)


def collections_from_env(value):
    """The IRSA collections to search, from ANVIS_COLLECTIONS ("a,b,c").

    New SPHEREx releases appear on IRSA as new collections (for example spherex_qr4), so they are
    configured rather than written into the code. Names are checked because they go into the
    IRSA query; a bad value stops the server with a clear message instead of failing later.
    """
    names = [c.strip() for c in value.split(",") if c.strip()]
    bad = [c for c in names if not re.fullmatch(r"[a-z0-9_]+", c)]
    if not names or bad:
        raise ValueError(f"ANVIS_COLLECTIONS must be comma-separated IRSA collection names, got {value!r}")
    return names


COLLECTIONS = collections_from_env(os.environ.get("ANVIS_COLLECTIONS", DEFAULT_COLLECTIONS))
BANDS = [f"SPHEREx-D{i}" for i in range(1, 7)]
PIXEL_SCALE = 6.15 / 3600.0  # deg/pixel, native SPHEREx scale
MAX_SIZE_ARCSEC = 1800    # field height (and width, for square fields)
MAX_WIDTH_ARCSEC = 1800   # field width for wide fields
USER_AGENT = "anvis/1.0"

# Be polite to IRSA and MAST: at most 10 requests to them at a time from this server
# (more made IRSA answer "busy" much more often, for little gain).
_remote_slots = threading.Semaphore(10)
# Worker threads for /api/cutouts (each one waits on _remote_slots before calling IRSA).
_pool = cf.ThreadPoolExecutor(max_workers=10)
MAX_BATCH = 400   # most frames one /api/cutouts request may ask for

app = Flask(__name__, static_folder="static", static_url_path="")
session = requests.Session()
session.headers["User-Agent"] = USER_AGENT


# ----------------------------------------------------------------------------- request helpers
def bad(msg, code=400):
    """A JSON error response: {"error": msg} with the given HTTP status."""
    return jsonify({"error": msg}), code


def parse_position():
    """(ra, dec) in decimal degrees from the query string; ValueError if missing or out of range."""
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
    """The single-page app; its CSS and JS are served from static/ by Flask."""
    return send_from_directory(app.static_folder, "index.html")


# ----------------------------------------------------------------------------- finding images (SIA)
SIA_COLUMNS = ("energy_bandpassname", "dataproduct_subtype", "access_url", "obs_id", "obs_collection", "t_min")


@lru_cache(maxsize=256)
def sia_rows(ra, dec):
    """All SPHEREx images (every band) covering a position, from IRSA's SIA service. Cached."""
    params = [("POS", f"circle {ra} {dec} 0.0005"), ("RESPONSEFORMAT", "CSV"), ("MAXREC", "20000")]
    params += [("COLLECTION", c) for c in COLLECTIONS]
    text = remote_get(SIA_URL, params=params, timeout=120).text
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


def release_label(collection):
    """Short name of a collection for the page: spherex_dr1 -> "DR1", spherex_qr3_deep -> "QR3 Deep"."""
    parts = collection.removeprefix("spherex_").split("_")
    return " ".join([parts[0].upper()] + [p.capitalize() for p in parts[1:]])


@lru_cache(maxsize=256)
def spherex_collections_at(ra, dec):
    """{collection: image count} for every SPHEREx collection IRSA has at (ra, dec). Cached.

    IRSA has no quick way to list all collections (a TAP query for that took over 90 s), but an
    SIA search without a collection filter at one position is fast and shows what exists there.
    """
    params = [("POS", f"circle {ra} {dec} 0.0005"), ("RESPONSEFORMAT", "CSV"), ("MAXREC", "50000")]
    text = remote_get(SIA_URL, params=params, timeout=120).text
    counts = Counter(row.get("obs_collection") or "" for row in csv.DictReader(io.StringIO(text)))
    return {c: n for c, n in sorted(counts.items()) if c.startswith("spherex")}


@app.get("/api/collections")
def collections():
    """The SPHEREx collections this server searches; with ?ra&dec also those IRSA has there.

    {"in_use": [{"collection", "label"}], "available": [{"collection", "label", "images", "in_use"}]}
    ("available" only when a position is given).
    """
    out = {"in_use": [{"collection": c, "label": release_label(c)} for c in COLLECTIONS]}
    if "ra" in request.args or "dec" in request.args:
        try:
            ra, dec = parse_position()
        except ValueError as e:
            return bad(str(e))
        try:
            found = spherex_collections_at(round(ra, 5), round(dec, 5))
        except Exception as e:
            return bad(f"IRSA SIA query failed: {e}", 502)
        out["available"] = [{"collection": c, "label": release_label(c), "images": n, "in_use": c in COLLECTIONS}
                            for c, n in found.items()]
    return jsonify(out)


# ----------------------------------------------------------------------------- talking to IRSA / MAST
def remote_get(url, params=None, timeout=180, tries=12, n_hdus=None):
    """GET from IRSA (or MAST), retrying when it is busy or briefly unavailable (429/5xx).

    Waits 0.5 s before the first retry, growing to at most 5 s; other HTTP errors are raised.

    With n_hdus, read only the first n_hdus FITS HDUs of the response and return their bytes.
    """
    delay = 0.5
    for attempt in range(tries):
        try:
            with _remote_slots:
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


# ----------------------------------------------------------------------------- cutouts and frames
_wave_tables = {}  # (detector, pipeline version) -> WCS-WAVE table HDU
_wave_lock = threading.Lock()
# WCS-WAVE tables are also saved here, so they survive a server restart.
CACHE_DIR = os.environ.get("ANVIS_CACHE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache"))


def _wave_path(key):
    """Disk path of the saved WCS-WAVE table for (detector, pipeline version)."""
    name = re.sub(r"[^A-Za-z0-9._-]", "_", f"wcswave_D{key[0]}_{key[1]}")
    return os.path.join(CACHE_DIR, name + ".fits")


def fetch_cutout(url, ra, dec, size_deg):
    """Get one cutout via IRSA's cutout service (tutorial: ?center=<ra>,<dec>d&size=<deg>).

    Returns an HDUList with PRIMARY, IMAGE, FLAGS, VARIANCE, ZODI and WCS-WAVE.
    WCS-WAVE (the wavelength lookup table) is identical for every image from the same
    detector and pipeline version, so it is downloaded once and reused.
    """
    full = f"{url}?center={ra},{dec}d&size={size_deg}"
    hdul = fits.HDUList.fromstring(remote_get(full, n_hdus=5))
    if [h.name for h in hdul] != ["PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI"]:
        return fits.HDUList.fromstring(remote_get(full).content)  # unexpected layout: take it all
    key = (hdul["IMAGE"].header.get("DETECTOR"), hdul[0].header.get("VERSION"))
    if key not in _wave_tables:
        with _wave_lock:
            if key not in _wave_tables:
                path = _wave_path(key)
                try:
                    with fits.open(path) as saved:
                        _wave_tables[key] = saved["WCS-WAVE"].copy()
                except (OSError, KeyError):
                    whole = fits.HDUList.fromstring(remote_get(full).content)
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


# Flags that make a pixel unreliable: the conservative CONTAINS_BAD_PIXEL set from the SPHEREx
# Explanatory Supplement (Table 16), as used in IRSA's "Source Discovery Tool" tutorial.
# Shown as red dots on the explore page's date strip when set within 1 pixel of the target.
BAD_FLAGS = {"TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "DICHROIC", "MISSING_DATA", "HOT", "COLD",
             "NONLINEAR", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK", "PERSIST", "BLOOM",
             "SNOWBALL", "HALO", "SATELLITE_HALO"}


def flag_names(header):
    """{bitmask: (name, description)} from a FLAGS header's MSKNnnnn / MSKMnnnn / MSKDnnnn cards."""
    out = {}
    for key in header:
        if key.startswith("MSKN"):
            n = key[4:]
            mask = header.get("MSKM" + n)
            if mask:
                out[int(mask)] = (str(header[key]), str(header.get("MSKD" + n, "")))
    return out


def target_flags(flags_hdu, xc, yc):
    """Quality flags set within 1 pixel of the target, named from the FLAGS header (MSKNnnnn)."""
    h, data = flags_hdu.header, flags_hdu.data
    xi, yi = int(round(float(xc))), int(round(float(yc)))
    if data is None or not (0 <= xi < data.shape[1] and 0 <= yi < data.shape[0]):
        return []
    box = data[max(0, yi - 1):yi + 2, max(0, xi - 1):xi + 2]
    bits = int(np.bitwise_or.reduce(box.ravel())) if box.size else 0
    return [{"name": name, "desc": desc} for mask, (name, desc) in sorted(flag_names(h).items())
            if bits & mask and name in BAD_FLAGS]


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
    """One SPHEREx image as a frame of the field centred on (ra, dec).

    The field is size_arcsec tall and width_arcsec wide (default: square), on a north-up,
    east-left grid at the native 6.15" pixel scale, so frames from different visits line up.
    Returns a dict with the pixel values (MJy/sr, zodiacal light subtracted; None = no data),
    the wavelength at the target, the quality flags at the target and the observation time.
    """
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
    """One frame (see make_frame) for ?ra&dec&size&width (arcsec) and url (an IRSA SPHEREx image)."""
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


# ----------------------------------------------------------------------------- Gaia
# Gaia DR3 stars from MAST (STScI) via its TAP service, for the overlay and the About pop-up.
MAST_GAIA_TAP = "https://mast.stsci.edu/vo-tap/api/v0.1/gaiadr3/sync"
GAIA_COLUMNS = ("source_id", "ra", "dec", "pmra", "pmdec", "parallax", "parallax_error", "phot_g_mean_mag", "bp_rp")
GAIA_MAX_STARS = 5000
GAIA_EPOCH = 2016.0   # Gaia DR3 reference epoch (Julian year) for ra, dec


@lru_cache(maxsize=256)
def gaia_cone(ra, dec, radius_deg, gmax):
    """Gaia DR3 stars brighter than gmax within radius_deg of (ra, dec), as compact JSON text.

    Each star is [source_id (text: too big for a JavaScript number), ra, dec, pmra, pmdec,
    parallax, parallax_error, G, BP-RP]. Only numbers reach the query: the endpoint checks them.
    """
    query = (f"SELECT TOP {GAIA_MAX_STARS} {', '.join(GAIA_COLUMNS)} FROM dbo.gaia_source "
             f"WHERE 1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg})) "
             f"AND phot_g_mean_mag < {gmax} ORDER BY phot_g_mean_mag")
    r = remote_get(MAST_GAIA_TAP, params={"REQUEST": "doQuery", "LANG": "ADQL", "QUERY": query}, timeout=120)
    table = parse_single_table(io.BytesIO(r.content)).to_table()

    def num(v, nd):
        return None if np.ma.is_masked(v) or not np.isfinite(v) else round(float(v), nd)

    stars = [[str(int(t["source_id"])), num(t["ra"], 7), num(t["dec"], 7), num(t["pmra"], 3), num(t["pmdec"], 3),
              num(t["parallax"], 4), num(t["parallax_error"], 4), num(t["phot_g_mean_mag"], 3), num(t["bp_rp"], 3)]
             for t in table]
    return json.dumps({"epoch": GAIA_EPOCH, "gmax": gmax, "columns": list(GAIA_COLUMNS), "stars": stars,
                       "truncated": len(stars) >= GAIA_MAX_STARS, "source": "Gaia DR3 via MAST (STScI)"},
                      separators=(",", ":"))


@app.get("/api/gaia")
def gaia():
    """Gaia DR3 stars (G < gmax) within radius_deg of (ra, dec), brightest first, at epoch 2016.0."""
    try:
        ra, dec = parse_position()
        radius = float(request.args.get("radius", 0.1))
        gmax = float(request.args.get("gmax", 19))
    except ValueError as e:
        return bad(str(e))
    # Up to 0.4°: a 30′ × 30′ field reaches 21′ from its centre at the corners.
    if not 0.001 <= radius <= 0.4:
        return bad("radius must be between 0.001 and 0.4 degrees")
    if not 5 <= gmax <= 21:
        return bad("gmax must be between 5 and 21")
    try:
        text = gaia_cone(round(ra, 5), round(dec, 5), round(radius, 4), round(gmax, 1))
    except Exception as e:
        app.logger.warning("Gaia query failed: %s", e)
        return bad(f"Gaia query at MAST failed: {e}", 502)
    resp = Response(text, mimetype="application/json")
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, threaded=True)
