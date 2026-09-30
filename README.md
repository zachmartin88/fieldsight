# FieldSight

See what's growing in the fields beside you as you drive, anywhere in the lower 48.

Static web app (no backend, no build step). Full-screen map; tap **Start driving** and a bar across the top
names the crop on your **left** and **right** from GPS position + heading. Tap any field on the map for a
detail panel. Fields are drawn as outlined, labeled shapes when zoomed in (zoom 13+).

## Data, and how each reading is labeled

| Badge | Source | Meaning |
|---|---|---|
| **Live** (gold) | In-season Crop-type Data Layer (ICDL), 10 m, monthly Jun–Aug of the current year | This season's satellite crop map (~98% accurate for major crops by August). Gold = the field reads clearly (≥60% one crop, ≥50% farmland in the strip). |
| **Was … / NEW?** | ICDL vs. history | Live map disagrees with a steady multi-year cover (e.g. vineyard after 5 years of almonds). Replant or misread. |
| **Mixed** | ICDL | Field edge / farmstead / two crops in the strip. |
| **USDA 2025 map** | USDA NASS Cropland Data Layer (annual, released each Feb) | Used where the live map has a gap; headline is this year's prediction from the last 5 years (rotations, perennials). |

Both are served by George Mason University CSISS WMS endpoints (CORS-enabled):

- `https://cat.csiss.gmu.edu/cgi-bin/wms_cdl_icrop`: layers `cdl_YYYY_MM`, RGB, matched to classes by color
- `https://cat.csiss.gmu.edu/cgi-bin/wms_cdlall`: layers `cdl_YYYY`, raw class codes via `FORMAT=image/tiff`

Layers are discovered from GetCapabilities at startup, so new monthly/annual maps are picked up automatically.
Note: the server doesn't send its intermediate TLS cert. Browsers cope; Node needs `NODE_EXTRA_CA_CERTS`.

## Run locally

```bash
python3 -m http.server 5178 -d ~/fieldsight
```

- `?sim=1` simulates a drive through central Iowa (no GPS needed)
- `?at=42.05,-93.75` opens and inspects a specific spot (shareable)

GPS needs HTTPS (or localhost).

## Files

- `data.js`: layer discovery, TIFF reader, point/strip sampling, voting, rotation prediction, tiers
- `fields.js`: field overlay (view image → despeckle → connected fields → outlines + labels, hit-testing)
- `app.js`: map, GPS/heading, drive strip, detail sheet, voice, wake lock
- `cdl-classes.js`: CDL class codes → names/colors
