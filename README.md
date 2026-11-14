# SPHEREx Time Viewer

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

Player controls (modelled on WiseView): Prev / Play / Next, frame slider, speed (ms per frame),
min/max brightness (percentiles), invert, zoom, ←/→/space keys, and a shareable URL
(`#ra=...&dec=...&size=...&band=...`).

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
* Docker hosts: `docker build -t spherex-viewer . && docker run -p 8000:8000 spherex-viewer`.

Use one worker process (as in the Procfile) so the in-memory cutout cache is shared.
