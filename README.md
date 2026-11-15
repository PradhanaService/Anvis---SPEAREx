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

1. **Pick** – a sidebar (RA, Dec, a field-height slider from 1′ to 30′ with a download estimate
   such as "~59 frames · ~11 MB", band D1–D6, **Slide to Search**, five presets)
   next to a real SPHEREx image you can pan, zoom and hover to read coordinates; click to pick a
   position. A dashed box shows the field the search will fetch. Drag the red handle of
   *Slide to Search* to the right end to search (Enter also works). Presets fill the target, set
   height 10′ and band D3, and search straight away.
2. **Explore** – every SPHEREx image of that field in time order: a date strip, Prev / Play /
   Pause / Next (stops at the ends), speed 0.25x–3x, BLINK (alternate with the previous
   observation), zoom and pan, ←/→/Space keys (Esc closes the pop-up), and a shareable URL
   (`#ra=...&dec=...&size=...&band=...&gaia=1`). Red dots on dates show SPHEREx quality flags at
   the target (from each image's FLAGS extension). Click the image for an "About" pop-up with the
   position, measured surface brightness (MJy/sr), wavelength and the original FITS file at IRSA.

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

## Adding a new SPHEREx data release

SPHEREx releases appear on IRSA as new collections (e.g. `spherex_qr4`). The app searches the
collections listed in the `ANVIS_COLLECTIONS` environment variable (comma-separated; default
`spherex_dr1,spherex_qr3`), so a new release needs no code change:

1. See which SPHEREx collections IRSA has at a position (any well-observed field will do):

   ```bash
   curl "http://localhost:8000/api/collections?ra=270&dec=66.56"
   ```

   Each entry shows the collection, a short label, how many images it has there, and whether the
   app already uses it. (IRSA has no quick way to list every collection, so this asks about one
   position; at a deep field it can take ~30 s.)
2. Add the new collection and restart the app, for example (macOS/Linux):

   ```bash
   ANVIS_COLLECTIONS=spherex_dr1,spherex_qr3,spherex_qr4 python app.py
   ```

   On Windows PowerShell: `$env:ANVIS_COLLECTIONS="spherex_dr1,spherex_qr3,spherex_qr4"`, then
   `python app.py`. On a host such as Render, set it as an environment variable.
3. The page credit on page 1 shows the releases in use (e.g. "Releases DR1 + QR3 + QR4").

Notes:
* Only lower-case letters, digits and `_` are accepted; anything else stops the server with a
  clear message.
* Remove a release when a newer one supersedes it (as DR1 and QR3 superseded QR2), so the same
  observation isn't shown twice.
* The Deep Survey collections (`spherex_dr1_deep`, `spherex_qr3_deep`) hold many more images
  (tens of thousands near the ecliptic poles); add them deliberately.

## Project layout

| Path | What it is |
|---|---|
| `app.py` | Flask backend: IRSA search and cutouts, frame building, caches, Gaia from MAST (endpoints listed at the top) |
| `static/index.html` | The page: both screens (Pick, Explore) |
| `static/style.css` | Styles |
| `static/app.js` | Everything interactive (layout of the file listed at the top) |
| `tests/test_backend.py` | Offline backend tests (no network) |
| `tests/test_live.py` | Live checks against IRSA and MAST (opt-in) |
| `tests/e2e/ui.test.mjs` | Browser test of every part of the page |

## Tests

Backend tests (offline, about a second):

```bash
pip install -r requirements-dev.txt
```
```bash
python -m pytest -q tests
```

Live checks against IRSA and MAST (internet needed; macOS/Linux shown, on Windows PowerShell
first run `$env:ANVIS_LIVE=1`, then the pytest command):

```bash
ANVIS_LIVE=1 python -m pytest -q tests/test_live.py
```

Browser test of every part of the page (needs Node.js; start `python app.py` first, then in
`tests/e2e`):

```bash
npm install
```
```bash
npx playwright install chromium
```
```bash
npm test
```

It prints PASS / FAIL for about 50 checks (both pages, presets, slide to search, playback,
BLINK, GAIA, the About pop-up, simulated IRSA / MAST failures, and layouts down to phone size).

## Make it public

Deploy the folder to any host that runs Python or Docker (Render, Railway, Fly.io,
Google Cloud Run, a VPS, …):

* Python hosts: they pick up `requirements.txt` and the `Procfile`
  (`gunicorn app:app ...`).
* Docker hosts: `docker build -t anvis . && docker run -p 8000:8000 anvis`.

Use one worker process (as in the Procfile) so the in-memory cutout cache is shared.
