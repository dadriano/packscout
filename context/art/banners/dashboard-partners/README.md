# Dashboard partner banner review

This folder contains the six approved 1600×300 WebP design comps and a lightweight local review panel. The dashboard runtime uses the selected compact 1600×225 exports from `apps/frontend/public/partner-banners/`.

## Selected production pair

- `03-underdog-yellow-impact` → `/?underdog`
- `06-collector-crypt-market-signal` → `/?collector`

The compact production assets preserve the supplied partner marks, PackScout trust seal, typography, and real slab geometry at their native proportions. They were recomposed at 3200×450 and uniformly reduced to 1600×225; no brand element was redrawn or stretched.

## Review all six comps

Serve this directory locally:

```bash
cd context/art/banners/dashboard-partners
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8765/review-panel.html`. Use the Preview client's built-in comments for annotations; the page intentionally stores no custom pins, notes, or browser state.
