// Builds data/states.json and data/counties.json: simplified outlines plus how many acres of each
// crop each state/county has on the latest in-season (live) crop map. Used for the zoomed-out map.
//
//   NODE_EXTRA_CA_CERTS=proxy/incommon-rsa-server-ca-2.pem node tools/build-regions.mjs
//
// Method: read the crop map for the lower 48 at 0.01° (~1 km) resolution, rasterize county
// outlines onto the same grid, and count pixels. ~1 km sampling is plenty for county shares.
import fs from 'node:fs';
import { discoverLayers, rgbToCode, isAg, wmsFetch, LIVE_WMS, ANNUAL_WMS } from '../data.js';

const OUT = new URL('../data/', import.meta.url);
const ESRI = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services';
const RES = 0.01;
const X0 = -125, X1 = -66, Y0 = 24, Y1 = 50;
const W = Math.round((X1 - X0) / RES), H = Math.round((Y1 - Y0) / RES);
const SKIP_STATES = new Set(['02', '15', '72', '60', '66', '69', '78']);

async function geojson(service, fields, offset) {
  const feats = [];
  for (let start = 0; ; start += 2000) {
    const q = new URLSearchParams({
      where: '1=1', outFields: fields, outSR: '4326', f: 'geojson', resultOffset: start, resultRecordCount: 2000,
      maxAllowableOffset: String(offset), geometryPrecision: '3',
    });
    const j = await (await fetch(`${ESRI}/${service}/FeatureServer/0/query?${q}`)).json();
    feats.push(...j.features);
    if (j.features.length < 2000) break;
  }
  return feats;
}

function readTiff(buf) {
  const dv = new DataView(buf);
  const le = dv.getUint16(0) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const ifd = u32(4), n = u16(ifd), tags = {};
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const size = type === 3 ? 2 : 4, at = count * size > 4 ? u32(e + 8) : e + 8;
    const vals = [];
    for (let j = 0; j < count; j++) vals.push(size === 2 ? u16(at + j * 2) : u32(at + j * 4));
    tags[tag] = vals;
  }
  const w = tags[256][0], h = tags[257][0], spp = (tags[277] || [1])[0];
  const out = new Uint8Array(w * h * spp);
  let p = 0;
  tags[273].forEach((off, i) => { out.set(new Uint8Array(buf, off, tags[279][i]), p); p += tags[279][i]; });
  return { w, h, spp, px: out };
}

// Crop codes for the whole grid, fetched in 10°×10° pieces.
async function cropGrid(src) {
  const codes = new Uint8Array(W * H);
  const step = 1000;
  for (let ty = 0; ty < H; ty += step) for (let tx = 0; tx < W; tx += step) {
    const w = Math.min(step, W - tx), h = Math.min(step, H - ty);
    const minx = X0 + tx * RES, maxy = Y1 - ty * RES;
    const q = `SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${src.layer}&STYLES=&SRS=EPSG:4326` +
      `&BBOX=${minx.toFixed(2)},${(maxy - h * RES).toFixed(2)},${(minx + w * RES).toFixed(2)},${maxy.toFixed(2)}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/tiff`;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await wmsFetch(src.base, q, 120000);
        const t = readTiff(await res.arrayBuffer());
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const k = y * w + x;
          const c = t.spp >= 3 ? rgbToCode(t.px[k * t.spp], t.px[k * t.spp + 1], t.px[k * t.spp + 2]) : t.px[k];
          codes[(ty + y) * W + tx + x] = c ?? 0;
        }
        process.stdout.write('.');
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  console.log();
  return codes;
}

// Scanline-fill each feature's polygons onto the grid (even-odd).
function rasterize(features) {
  const idx = new Int16Array(W * H).fill(-1);
  features.forEach((f, n) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const rings of polys) {
      let ymin = 90, ymax = -90;
      for (const r of rings) for (const [, y] of r) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
      const r0 = Math.max(0, Math.floor((Y1 - ymax) / RES)), r1 = Math.min(H - 1, Math.ceil((Y1 - ymin) / RES));
      for (let row = r0; row <= r1; row++) {
        const lat = Y1 - (row + 0.5) * RES, xs = [];
        for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const [xi, yi] = r[i], [xj, yj] = r[j];
          if ((yi > lat) !== (yj > lat)) xs.push(xi + (lat - yi) / (yj - yi) * (xj - xi));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.ceil((xs[k] - X0) / RES - 0.5)), c1 = Math.min(W - 1, Math.floor((xs[k + 1] - X0) / RES - 0.5));
          for (let c = c0; c <= c1; c++) idx[row * W + c] = n;
        }
      }
    }
  });
  return idx;
}

function summarize(features, idx, codes) {
  const stats = features.map(() => ({ crops: new Map(), ag: 0, area: 0, sx: 0, sy: 0, n: 0 }));
  for (let row = 0; row < H; row++) {
    const lat = Y1 - (row + 0.5) * RES;
    const acres = (RES * 111320) * (RES * 111320 * Math.cos(lat * Math.PI / 180)) / 4046.86;
    for (let col = 0; col < W; col++) {
      const k = row * W + col, f = idx[k];
      if (f < 0) continue;
      const s = stats[f], c = codes[k];
      s.sx += col; s.sy += row; s.n++; s.area += acres;
      if (c && isAg(c)) { s.ag += acres; s.crops.set(c, (s.crops.get(c) || 0) + acres); }
    }
  }
  return stats.map((s) => ({
    area: Math.round(s.area),
    ag: Math.round(s.ag),
    // Planted cropland: farmland minus grassland/pasture.
    crop: Math.round(s.ag - (s.crops.get(176) || 0) - (s.crops.get(171) || 0)),
    top: [...s.crops].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, a]) => [c, Math.round(a)]),
    // Label point: middle of the county's own pixels (stays inside odd shapes better than a bbox).
    at: s.n ? [+(Y1 - (s.sy / s.n + 0.5) * RES).toFixed(3), +(X0 + (s.sx / s.n + 0.5) * RES).toFixed(3)] : null,
  }));
}

const layers = await discoverLayers();
const src = layers.live ? { base: LIVE_WMS, layer: layers.live.layer } : { base: ANNUAL_WMS, layer: `cdl_${layers.years[0]}` };
console.log('crop map:', src.layer, `${W}×${H}`);
const codes = await cropGrid(src);

fs.mkdirSync(OUT, { recursive: true });
for (const [name, service, fields, offset, key] of [
  ['states', 'USA_States_Generalized_Boundaries', 'STATE_ABBR,STATE_FIPS,STATE_NAME', 0.02, 'STATE_FIPS'],
  ['counties', 'USA_Counties_Generalized_Boundaries', 'FIPS,NAME,STATE_ABBR,STATE_FIPS', 0.006, 'STATE_FIPS'],
]) {
  const feats = (await geojson(service, fields, offset)).filter((f) => f.geometry && !SKIP_STATES.has(f.properties[key]));
  const sums = summarize(feats, rasterize(feats), codes);
  const out = {
    type: 'FeatureCollection',
    source: src.layer,
    features: feats.map((f, i) => ({
      type: 'Feature',
      properties: {
        id: f.properties.FIPS || f.properties.STATE_FIPS,
        name: f.properties.NAME || f.properties.STATE_NAME,
        st: f.properties.STATE_ABBR, ...sums[i],
      },
      geometry: f.geometry,
    })),
  };
  fs.writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify(out));
  console.log(name, feats.length, `${(fs.statSync(new URL(`${name}.json`, OUT)).size / 1e6).toFixed(2)} MB`);
}
