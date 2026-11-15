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

All SPHEREx data comes from the NASA/IPAC Infrared Science Archive
(https://irsa.ipac.caltech.edu/Missions/spherex.html). Gaia DR3 star positions come from MAST
(https://archive.stsci.edu/missions-and-data/gaia), via its TAP service. IRSA does not send CORS headers,
so a small Python backend (`app.py`) does the IRSA requests; the page itself is plain
HTML/CSS/JS in `static/`.

The app has two pages:

1. **01 Pick** – a sidebar (RA, Dec, height in arcmin, band D1–D6, Search, five presets) next to a
   real SPHEREx image you can pan, zoom and hover to read coordinates; click to pick a position.
   A dashed box shows the field that Search will fetch. Presets fill the target, set height 10′
   and band D3, and run the search.
2. **02 Explore** – every SPHEREx image of that field in time order: a date strip, Prev / Play /
   Pause / Next (stops at the ends), speed 0.25x–3x, BLINK (alternate with the previous
   observation), DIFF (this observation minus the previous one), full screen, zoom and pan,
   ←/→/space/Esc keys, and a shareable URL (`#ra=...&dec=...&size=...&band=...`).
   The quality chip and red dots on dates show SPHEREx quality flags at the target (from each
   image's FLAGS extension). Click the image for an "About" pop-up with the position, measured
   surface brightness (MJy/sr), wavelength and the original FITS file at IRSA.

   **GAIA** overlays Gaia DR3 stars (G < 19, from MAST at STScI) on the images, each moved from
   Gaia's 2016.0 epoch to the date of the frame shown using its proper motion; stars moving
   faster than 100 mas/yr get an arrow showing 10 years of motion. The About pop-up shows the
   nearest Gaia star (ID, G, BP−RP, parallax/distance, proper motion) within 6.2″, or says there
   is none – a SPHEREx source with no Gaia match is worth a closer look.

This is an independent tool using NASA SPHEREx data from IRSA; it is not an official NASA website.

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
