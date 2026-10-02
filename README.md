# FieldSight

See what's growing in the fields beside you as you drive, anywhere in the lower 48.

Static web app (no build step) plus an optional small proxy. Full-screen map. Tap **Start driving** and a
bar across the top names the crop on your **left** and **right** from GPS position + heading, with what's
coming up ~300 m ahead. Tap any field for a detail panel. The ☰ menu has the trip log, offline routes and
data notes.

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
Lookups read fixed 0.01° tiles (~1 km, 10 m pixels), so consecutive lookups reuse loaded tiles and identical
URLs can be cached by the proxy and the offline cache.

## Map at every zoom

- **≤ 6**: states, tinted by top planted crop, with a bubble (`IA 🌽 53%`)
- **7–10**: counties, tinted by top planted crop (deeper = more cropland); emoji bubbles from 8, % from 9
- **11**: the crop map itself, recolored into the app palette
- **12+**: fields as vector shapes (hover, tap, spotlight a crop from the legend); **13+** uses USDA Crop
  Sequence Boundaries (official field outlines + per-field history) where available, traced shapes elsewhere

State/county numbers are precomputed from the live crop map (`node tools/build-regions.mjs`), with gaps
filled from the latest annual map. **This refreshes itself**: `.github/workflows/refresh-data.yml` runs on the
8th of each month, rebuilds when USDA has published a newer map (`tools/check-data.mjs` compares against
`data/meta.json`), and publishes. Run it by hand from the Actions tab (with "force" to rebuild anyway). It also
opens an issue the first time USDA's national field-boundary service is back online.

## More

- **Share cards** (`share.js`): Instagram-sized image of a field or your album, via the share sheet.
- **Crop Cards** (`album.js`): collectible cards earned while driving, sets, rarity by national acreage, state stamps.
- **Plan a drive** (`ahead.js`): route forecast ribbon, "next 10 mi" while driving; Android share target from Google Maps.
- **Harvest color**: fields fade toward straw as USDA's weekly report shows harvest progress (needs proxy + key).
- **Parcels** (`parcels.js`): owner/parcel from free statewide layers (WI, NC, AR, FL, CO, VT, CT; lines only for OH, IN, ND, CA, UT, NJ).

## Proxy (optional, `proxy/server.js`)

Caches tiles (the upstream server has been flaky) and serves weekly USDA crop progress/condition for the
state you're in. Deploy on Render: **New ▸ Blueprint ▸ this repo** (`render.yaml`), then:

1. Set `QUICKSTATS_KEY` in Render (free key: https://quickstats.nass.usda.gov/api) to turn on crop progress.
2. Put the service URL in `config.js` (`proxy: 'https://…onrender.com'`) and push.

The free plan sleeps when idle; the app goes direct to the map server while it wakes. Without a proxy
configured, everything except crop progress works.

The upstream server doesn't send its intermediate TLS cert. Browsers cope; Node needs
`NODE_EXTRA_CA_CERTS=proxy/incommon-rsa-server-ca-2.pem` (set in `render.yaml`).

## Offline

`sw.js` caches the app and every lookup tile it sees. **☰ ▸ Save a route for offline** geocodes the ends
(OpenStreetMap Nominatim), routes (OSRM), and downloads the live map + last 3 annual maps for a corridor
along the road (up to 400 miles). Left/right readings then work with no signal; the base map needs signal.

## Run locally

```bash
python3 ~/fieldsight/tools/devserver.py 5178
```

(No-cache static server so edits always load.) Proxy: `NODE_EXTRA_CA_CERTS=proxy/incommon-rsa-server-ca-2.pem node proxy/server.js`.

- `?sim=1` simulates a drive through central Iowa (no GPS needed)
- `?at=42.05,-93.75` opens and inspects a specific spot (shareable)
- `?debug` exposes `fsMap`, `fsFields`, `fsState` in the console

GPS needs HTTPS (or localhost).

## Files

- `data.js`: layer discovery, proxy/direct fetching, tile grid, TIFF reader, sampling, voting, rotation prediction, tiers
- `fields.js`: field overlay (view image → despeckle → connected fields → smoothed outlines + labels, hit-testing)
- `app.js`: map (heading-up), GPS, drive strip, detail sheet, crop progress, trip log, menu, voice
- `offline.js`: route planning and offline downloads; `sw.js`: service worker
- `cdl-classes.js`: CDL class codes → names/colors; `config.js`: proxy URL
- `proxy/`: caching proxy + USDA crop progress; `render.yaml`: Render blueprint
