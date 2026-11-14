"""SPHEREx Time Viewer: a small Flask backend.

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

import csv
import io
import logging
import threading
import time
import warnings
from functools import lru_cache

import numpy as np
import requests
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from flask import Flask, jsonify, request, send_from_directory

warnings.filterwarnings("ignore")
logging.getLogger("astropy").setLevel(logging.ERROR)

IRSA = "https://irsa.ipac.caltech.edu"
SIA_URL = IRSA + "/SIA"
DATA_PREFIX = IRSA + "/ibe/data/spherex/"
COLLECTIONS = ["spherex_dr1", "spherex_qr3"]  # DR1 + QR3 (QR2 is superseded)
BANDS = [f"SPHEREx-D{i}" for i in range(1, 7)]
PIXEL_SCALE = 6.15 / 3600.0  # deg/pixel, native SPHEREx scale
MAX_SIZE_ARCSEC = 600
USER_AGENT = "spherex-time-viewer/1.0"

# Be polite to IRSA: limit concurrent cutout downloads from this server.
_irsa_slots = threading.Semaphore(4)

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

    params = [("POS", f"circle {ra} {dec} 0.0005"), ("RESPONSEFORMAT", "CSV"), ("MAXREC", "20000")]
    params += [("COLLECTION", c) for c in COLLECTIONS]
    try:
        text = irsa_get(SIA_URL, params=params, timeout=120).text
    except Exception as e:
        return bad(f"IRSA SIA query failed: {e}", 502)

    out, seen = [], set()
    for row in csv.DictReader(io.StringIO(text)):
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


def irsa_get(url, params=None, timeout=180, tries=7):
    """GET from IRSA, retrying when it is busy or briefly unavailable (429/5xx)."""
    delay = 2.0
    for attempt in range(tries):
        try:
            with _irsa_slots:
                r = session.get(url, params=params, timeout=timeout)
        except (requests.ConnectionError, requests.Timeout):
            r = None
        if r is not None and r.status_code == 200:
            return r
        if r is not None and r.status_code not in (429, 500, 502, 503, 504):
            raise RuntimeError(f"IRSA error {r.status_code}: {r.text[:200]}")
        if attempt < tries - 1:
            time.sleep(delay)
            delay *= 1.6
    raise RuntimeError("IRSA is busy or unavailable; please try again later")


def fetch_cutout(url, ra, dec, size_deg):
    """Download one cutout via IRSA's cutout service (tutorial: ?center=<ra>,<dec>d&size=<deg>)."""
    return irsa_get(f"{url}?center={ra},{dec}d&size={size_deg}").content


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


@lru_cache(maxsize=4000)
def make_frame(url, ra, dec, size_arcsec):
    size_deg = size_arcsec / 3600.0
    # Request a slightly larger cutout so the rotated detector grid covers our square.
    raw = fetch_cutout(url, ra, dec, round(size_deg * 1.5, 5))
    with fits.open(io.BytesIO(raw)) as hdul:
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

    # Resample onto a common north-up, east-left grid so every frame lines up.
    n = max(8, int(round(size_deg / PIXEL_SCALE)))
    grid = WCS(naxis=2)
    grid.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    grid.wcs.crval = [ra, dec]
    grid.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    grid.wcs.cdelt = [-PIXEL_SCALE, PIXEL_SCALE]
    gy, gx = np.mgrid[0:n, 0:n]
    wra, wdec = grid.pixel_to_world_values(gx.ravel(), gy.ravel())
    sx, sy = sky.world_to_pixel_values(wra, wdec)
    out = bilinear(image, sx, sy).reshape(n, n)[::-1]  # row 0 = north (top of screen)

    data = [None if not np.isfinite(v) else round(float(v), 4) for v in out.ravel()]
    return {"width": n, "height": n, "data": data, "wavelength_um": wavelength,
            "mjd_avg": mjd, "pipeline_version": version, "unit": "MJy/sr"}


@app.get("/api/cutout")
def cutout():
    try:
        ra, dec = parse_position()
        size = float(request.args.get("size", 180))
    except ValueError as e:
        return bad(str(e))
    url = request.args.get("url", "")
    if not url.startswith(DATA_PREFIX) or not url.endswith(".fits") or "?" in url:
        return bad("url must be an IRSA SPHEREx image URL")
    if not 30 <= size <= MAX_SIZE_ARCSEC:
        return bad(f"size must be between 30 and {MAX_SIZE_ARCSEC} arcsec")
    try:
        frame = make_frame(url, round(ra, 6), round(dec, 6), round(size))
    except Exception as e:
        app.logger.warning("cutout failed for %s: %s", url, e)
        return bad(str(e), 502)
    resp = jsonify(frame)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, threaded=True)
