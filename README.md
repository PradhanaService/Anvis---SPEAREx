# Anvis

*A SPHEREx time viewer.*

A small public web tool: enter a sky position (RA, Dec) and see every SPHEREx image of
that patch of sky, in time order, in a WiseView-style flip-book player.

## How it works

| Step | Source |
|------|--------|
| Find all SPHEREx spectral images covering the position in the chosen detector band (D1–D6), collections `spherex_dr1` + `spherex_qr3` | IRSA SIA service, `https://irsa.ipac.caltech.edu/SIA` (as in the tutorial *Introduction to SPHEREx Spectral Images*) |
| Download a small cutout of each image | IRSA cutout service: `<image URL>?center=<ra>,<dec>d&size=<deg>` (as in the tutorial *SPHEREx Spectral Image Cutouts*) |
| Subtract the `ZODI` extension from `IMAGE`, compute central wavelength from the spectral WCS (`key="W"`) | Same tutorials |
| Resample every cutout onto one north-up grid (SPHEREx's orientation changes between visits) and play them in order | This app |

All data comes from the NASA/IPAC Infrared Science Archive
(https://irsa.ipac.caltech.edu/Missions/spherex.html). IRSA does not send CORS headers,
so a small Python backend (`app.py`) does the IRSA requests; the page itself is plain
HTML/CSS/JS in `static/`.

The app has two pages:

1. **Select coordinates** – a real SPHEREx image (30′ × 10.5′) you can pan, zoom and hover to
   read coordinates; click to pick a position, or type RA/Dec (degrees or sexagesimal).
   Choose the band (D1–D6) and field height, then Search.
2. **Explore observations** – every SPHEREx image of that field in time order, with a frame
   strip, Prev / Pause / Play / Next, speed chips (0.25x–3x), brightness/invert controls,
   zoom and pan, ←/→/space keys, and a shareable URL (`#ra=...&dec=...&size=...&band=...`).
   Click the image to read the position, measured surface brightness (MJy/sr) and wavelength
   in each frame; every frame links to its original FITS file at IRSA.

Note: SPHEREx's wavelength varies across its detectors, so each frame samples a slightly
different wavelength within the band. The wavelength is shown with each frame.

## Run locally

```bash
pip install -r requirements.txt
```

```bash
python app.py
```

Then open http://localhost:8000/#ra=210.80227&dec=54.34895 (M101).

## Make it public

Deploy the folder to any host that runs Python or Docker (Render, Railway, Fly.io,
Google Cloud Run, a VPS, …):

* Python hosts: they pick up `requirements.txt` and the `Procfile`
  (`gunicorn app:app ...`).
* Docker hosts: `docker build -t anvis . && docker run -p 8000:8000 anvis`.

Use one worker process (as in the Procfile) so the in-memory cutout cache is shared.
