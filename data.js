// Crop lookups against the public CDL map services hosted by George Mason Univ. (CSISS).
//  - In-season layer (ICDL): current-year 10 m crop map from Sentinel-2/Landsat, monthly Jun-Aug.
//    Served as RGB, so pixels are matched back to CDL classes by color.
//  - Annual layer (USDA NASS CDL): official end-of-season map, released ~Feb of the next year.
//    Served as raw single-band class codes.
import { CDL } from './cdl-classes.js';

const ICROP = 'https://cat.csiss.gmu.edu/cgi-bin/wms_cdl_icrop';
const ANNUAL = 'https://cat.csiss.gmu.edu/cgi-bin/wms_cdlall';
const HISTORY_YEARS = 5;
const TIMEOUT_MS = 9000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- class helpers ----------

const NON_CROP = new Set([0, 63, 64, 65, 81, 82, 83, 87, 88, 92, 111, 112, 121, 122, 123, 124, 131, 141, 142, 143, 152, 190, 195]);
const PASTURE = new Set([171, 176]);
const DEVELOPED = new Set([82, 121, 122, 123, 124]);
const NO_DATA = new Set([0, 81]);
const DOUBLE_CROP = new Set([26, 225, 226, 228, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 254]);
// Crops that stay in place year to year (hay, orchards, vines, sod...).
const PERENNIAL = new Set([36, 37, 58, 59, 60, 66, 67, 68, 69, 70, 71, 72, 74, 75, 76, 77, 204, 210, 211, 212, 215, 217, 218, 220, 223, 242, 250, 171, 176]);

// Pasture, hay and grass seed swap back and forth constantly; don't treat that as a change.
const GRASSY = new Set([37, 58, 59, 60, 171, 176]);
const family = (c) => (GRASSY.has(c) ? 'grass' : colorOf(c));

export const isCrop = (c) => c != null && !NON_CROP.has(c) && !PASTURE.has(c);
export const isAg = (c) => isCrop(c) || PASTURE.has(c);
export const isDeveloped = (c) => DEVELOPED.has(c);
export const className = (c) => (CDL[c] ? CDL[c][0] : 'Unknown');
export const classColor = (c) => (CDL[c] ? CDL[c][1] : '#555');

// Friendlier display names for the codes people see most from the road.
const PRETTY = {
  47: 'Vegetables & fruit', 44: 'Other crops', 176: 'Grass / pasture', 37: 'Hay', 61: 'Fallow / idle',
  121: 'Developed (open)', 122: 'Developed', 123: 'Developed', 124: 'Developed (dense)',
  141: 'Forest', 142: 'Forest', 143: 'Forest', 152: 'Shrubland', 190: 'Wetland', 195: 'Wetland',
  111: 'Water', 131: 'Barren', 26: 'Winter wheat → soybeans', 225: 'Winter wheat → corn',
  238: 'Winter wheat → cotton', 236: 'Winter wheat → sorghum',
};
export const prettyName = (c) => PRETTY[c] || className(c);

// Short "what you're looking at" notes for major crops, keyed by code.
export const NOTES = {
  1: 'Tall stalks, tassels on top. Harvested Sep–Nov.',
  5: 'Knee-to-waist-high bushy rows. Leaves turn yellow, then brown, before harvest.',
  24: 'Planted in fall, harvested Jun–Jul. Stubble or bare ground after that.',
  23: 'Planted in spring. Harvest Aug–Sep.',
  2: 'Shrubby plants. White bolls open before the Sep–Nov harvest.',
  3: 'Grown in flooded, leveled fields with levees.',
  4: 'Shorter than corn, with reddish-bronze grain heads.',
  36: 'Low, dense, blue-green. Cut and baled several times a season.',
  37: 'Grass hay, cut and baled.',
  6: 'Big yellow flower heads that turn brown before harvest.',
  41: 'Broad dark-green leaves. Roots are dug in the fall.',
  31: 'Bright yellow flowers in early summer.',
  10: 'Low vines. Nuts dug up in the fall.',
  176: 'Grazing land or grass.',
  61: 'Cropland left unplanted this season.',
  69: 'Vineyard rows on trellises.',
  75: 'Orchard rows.',
  45: 'Tall canes, often burned or cut in the fall and winter.',
  43: 'Low leafy rows. Dug Aug–Oct.',
};

// ---------- color -> class matching (for the RGB in-season layer) ----------

// Several classes share a color (e.g. double crops). Map each color to the first, most generic code.
const colorToCode = new Map([['#e9ffbe', 176], ['#00af4d', 44]]);
for (const [code, [, hex]] of Object.entries(CDL)) {
  const key = hex.toLowerCase();
  if (!colorToCode.has(key)) colorToCode.set(key, +code);
}
const palette = [...colorToCode.entries()].map(([hex, code]) => ({
  code, r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16),
}));
const rgbCache = new Map();
export function rgbToCode(r, g, b) {
  const k = (r << 16) | (g << 8) | b;
  if (rgbCache.has(k)) return rgbCache.get(k);
  let best = null, bestD = 40; // tolerate small rendering differences only
  for (const p of palette) {
    const d = Math.abs(p.r - r) + Math.abs(p.g - g) + Math.abs(p.b - b);
    if (d < bestD) { bestD = d; best = p.code; }
  }
  if (NO_DATA.has(best)) best = null;
  rgbCache.set(k, best);
  return best;
}
export const colorOf = (code) => classColor(code).toLowerCase();

// ---------- minimal uncompressed TIFF reader ----------

function readTiff(buf) {
  const dv = new DataView(buf);
  const le = dv.getUint16(0) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const ifd = u32(4), n = u16(ifd);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const size = type === 3 ? 2 : 4;
    const at = count * size > 4 ? u32(e + 8) : e + 8;
    const vals = [];
    for (let j = 0; j < count; j++) vals.push(size === 2 ? u16(at + j * 2) : u32(at + j * 4));
    tags[tag] = vals;
  }
  const w = tags[256][0], h = tags[257][0], spp = (tags[277] || [1])[0];
  if ((tags[259] || [1])[0] !== 1) throw new Error('compressed tiff');
  const offs = tags[273], counts = tags[279];
  const out = new Uint8Array(w * h * spp);
  let p = 0;
  // The last strip can be padded past the image height; copy only what fits.
  for (let i = 0; i < offs.length && p < out.length; i++) {
    const n = Math.min(counts[i], out.length - p, buf.byteLength - offs[i]);
    if (n > 0) { out.set(new Uint8Array(buf, offs[i], n), p); p += n; }
  }
  return { w, h, spp, px: out };
}

// ---------- network: optional caching proxy, with direct fallback ----------

const CFG = globalThis.FIELDSIGHT_CONFIG || {};
const PROXY = (CFG.proxy || '').replace(/\/$/, '');
const SERVICE_NAME = { [ICROP]: 'icrop', [ANNUAL]: 'cdlall' };
let proxyDownUntil = 0;

async function timedFetch(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal }); } finally { clearTimeout(timer); }
}

// Try the proxy (cached, closer, survives upstream hiccups); if it's asleep or down, go direct
// and leave the proxy alone for a minute.
export async function wmsFetch(base, query, timeout = TIMEOUT_MS) {
  if (PROXY && Date.now() > proxyDownUntil) {
    try {
      const res = await timedFetch(`${PROXY}/wms/${SERVICE_NAME[base]}?${query}`, 4000);
      if (res.ok) return res;
    } catch { /* fall through */ }
    proxyDownUntil = Date.now() + 60000;
  }
  return timedFetch(`${base}?${query}`, timeout);
}

// A sleeping free-tier proxy takes ~30 s to start; poke it early so it's up by the first lookup.
export function wakeProxy() {
  if (PROXY) fetch(`${PROXY}/health`).catch(() => {});
}
export const proxyUrl = PROXY;

// ---------- fixed tile grid ----------
// Lookups read 0.01° tiles (~1.1 km × 0.8 km, ~10 m pixels). Fixed tiles mean consecutive lookups
// reuse what's already loaded, and identical URLs can be cached by the proxy and for offline use.

const M_PER_DEG = 111320;
export const TILE = 0.01;
const TILE_CACHE_MAX = 600;

export const tileIndex = (lat, lon) => [Math.floor(lon / TILE + 1e-9), Math.floor(lat / TILE + 1e-9)];

export function tileSpec(i, j) {
  const minx = i * TILE, miny = j * TILE;
  return {
    minx, miny, maxx: minx + TILE, maxy: miny + TILE,
    w: Math.max(20, Math.round(111.32 * Math.cos((miny + TILE / 2) * Math.PI / 180))), h: 111,
    bbox: [minx, miny, minx + TILE, miny + TILE].map((v) => v.toFixed(2)).join(','),
  };
}

export const tileQuery = (layer, t) =>
  `SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layer}&STYLES=&SRS=EPSG:4326&BBOX=${t.bbox}&WIDTH=${t.w}&HEIGHT=${t.h}&FORMAT=image/tiff`;

const tileCache = new Map();   // "layer|i|j" -> Promise<grid>

function getTile(src, i, j) {
  const key = `${src.layer}|${i}|${j}`;
  let p = tileCache.get(key);
  if (p) { tileCache.delete(key); tileCache.set(key, p); return p; }   // LRU touch
  const t = tileSpec(i, j);
  p = (async () => {
    const res = await wmsFetch(src.base, tileQuery(src.layer, t));
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('tiff')) throw new Error(`${src.layer}: ${res.status}`);
    const tif = readTiff(await res.arrayBuffer());
    const codes = new Uint8Array(tif.w * tif.h);   // 0 = no data
    for (let k = 0; k < codes.length; k++) {
      if (src.rgb || tif.spp >= 3) {
        const o = k * tif.spp;
        codes[k] = rgbToCode(tif.px[o], tif.px[o + 1], tif.px[o + 2]) ?? 0;
      } else {
        const c = tif.px[k];
        codes[k] = NO_DATA.has(c) ? 0 : c;
      }
    }
    return { ...t, w: tif.w, h: tif.h, codes };
  })();
  p.catch(() => tileCache.delete(key));
  tileCache.set(key, p);
  while (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return p;
}

function sampleTiles(tiles, lat, lon) {
  const [i, j] = tileIndex(lat, lon);
  const g = tiles.get(`${i}|${j}`);
  if (!g) return null;
  const col = Math.min(g.w - 1, Math.floor((lon - g.minx) / TILE * g.w));
  const row = Math.min(g.h - 1, Math.floor((g.maxy - lat) / TILE * g.h));
  return g.codes[row * g.w + col] || null;
}

// ---------- layer discovery ----------

const LAYERS_KEY = 'fs.layers';
let layersPromise;
export function discoverLayers() {
  layersPromise ??= (async () => {
    const cap = (base) => wmsFetch(base, 'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetCapabilities', 12000).then((r) => r.text()).catch(() => '');
    const [ic, an] = await Promise.all([cap(ICROP), cap(ANNUAL)]);
    const inseason = [...ic.matchAll(/<Name>cdl_(\d{4})_(\d{2})<\/Name>/g)]
      .map((m) => ({ layer: `cdl_${m[1]}_${m[2]}`, year: +m[1], month: +m[2] }))
      .sort((a, b) => b.year - a.year || b.month - a.month);
    const annual = [...an.matchAll(/<Name>cdl_(\d{4})<\/Name>/g)].map((m) => +m[1]).sort((a, b) => b - a);
    if (!inseason.length && !annual.length) {
      // Offline or server down: use what we saw last time, if anything.
      try {
        const saved = JSON.parse(globalThis.localStorage?.getItem(LAYERS_KEY) || 'null');
        if (saved) return saved;
      } catch { /* ignore */ }
      layersPromise = null; // try again on the next lookup
      throw new Error('Could not reach the crop map server');
    }
    const latestAnnual = annual[0] ?? new Date().getFullYear() - 1;
    // Only use an in-season map if it is newer than the latest official annual map.
    const live = inseason.find((l) => l.year > latestAnnual) || null;
    if (live) live.label = `${MONTHS[live.month - 1]} ${live.year}`;
    const out = { live, years: annual.slice(0, HISTORY_YEARS) };
    try { globalThis.localStorage?.setItem(LAYERS_KEY, JSON.stringify(out)); } catch { /* ignore */ }
    return out;
  })();
  return layersPromise;
}

export const LIVE_WMS = ICROP;
export const ANNUAL_WMS = ANNUAL;

// Layers a lookup reads: the live map (RGB) plus the annual history (raw codes).
export function lookupSources(layers, historyYears = layers.years.length) {
  return [
    ...(layers.live ? [{ base: ICROP, layer: layers.live.layer, rgb: true, live: true }] : []),
    ...layers.years.slice(0, historyYears).map((y) => ({ base: ANNUAL, layer: `cdl_${y}`, rgb: false, year: y })),
  ];
}

// Fetch tiles just so they land in the offline cache (the service worker stores them).
export async function prefetchTile(src, i, j) {
  const res = await wmsFetch(src.base, tileQuery(src.layer, tileSpec(i, j)), 20000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.arrayBuffer();
}

// ---------- the lookup ----------

const toDeg = (lat, east, north) => ({
  dLat: north / M_PER_DEG,
  dLon: east / (M_PER_DEG * Math.cos(lat * Math.PI / 180)),
});

// Sample points for a side of the road (or a disk around the point when there's no heading).
// lead shifts the road strips forward, e.g. to cover lookup latency or to look ahead.
function patchPoints(lat, lon, heading, side, lead = 0) {
  const pts = [];
  if (side === 'here') {
    for (let e = -120; e <= 120; e += 20) for (let n = -120; n <= 120; n += 20) {
      const r = Math.hypot(e, n);
      if (r < 15 || r > 125) continue;
      const d = toDeg(lat, e, n); pts.push([lat + d.dLat, lon + d.dLon]);
    }
    return pts;
  }
  if (side === 'point') { // a tapped spot: tight patch
    for (let e = -30; e <= 30; e += 10) for (let n = -30; n <= 30; n += 10) {
      const d = toDeg(lat, e, n); pts.push([lat + d.dLat, lon + d.dLon]);
    }
    return pts;
  }
  const th = heading * Math.PI / 180;
  const fwd = [Math.sin(th), Math.cos(th)];           // east, north
  const right = [Math.cos(th), -Math.sin(th)];
  const s = side === 'right' ? 1 : -1;
  // Skip the first ~30 m (road, ditch, shoulder); look 30-130 m out, a bit ahead and behind.
  for (const out of [30, 50, 70, 90, 110, 130]) for (const along of [-40, -20, 0, 20, 40, 60]) {
    const a = along + lead;
    const e = right[0] * out * s + fwd[0] * a, n = right[1] * out * s + fwd[1] * a;
    const d = toDeg(lat, e, n); pts.push([lat + d.dLat, lon + d.dLon]);
  }
  return pts;
}

// Outline of the sampled strip, for drawing on the map.
export function sideArea(lat, lon, heading, side, lead = 0) {
  const th = heading * Math.PI / 180, s = side === 'right' ? 1 : -1;
  const fwd = [Math.sin(th), Math.cos(th)], right = [Math.cos(th), -Math.sin(th)];
  return [[25, -45], [135, -45], [135, 65], [25, 65]].map(([out, along]) => {
    const a = along + lead;
    const d = toDeg(lat, right[0] * out * s + fwd[0] * a, right[1] * out * s + fwd[1] * a);
    return [lat + d.dLat, lon + d.dLon];
  });
}

// Majority vote. Roads/farmsteads show up as "developed" at the edges of every field,
// so prefer agricultural classes when they make up a meaningful part of the patch.
function vote(codes) {
  const counts = new Map(); let valid = 0;
  for (const c of codes) if (c != null) { counts.set(c, (counts.get(c) || 0) + 1); valid++; }
  if (!valid) return null;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const agTotal = ranked.filter(([c]) => isAg(c)).reduce((s, [, n]) => s + n, 0);
  let pool = ranked;
  if (agTotal / valid >= 0.3) pool = ranked.filter(([c]) => isAg(c));
  const [code, n] = pool[0];
  const base = pool === ranked ? valid : agTotal;
  const runner = pool[1] ? { code: pool[1][0], share: pool[1][1] / base } : null;
  return { code, share: n / base, agShare: agTotal / valid, coverage: valid / codes.length, runner };
}

const ROTATION_PAIRS = [[1, 5], [3, 5], [2, 5], [1, 4], [2, 4], [2, 1], [24, 5], [24, 61], [23, 61]];

// Guess this year's crop from the recent sequence (oldest -> newest), used when no live map covers it.
function predict(seq) {
  const s = seq.filter((c) => c != null);
  if (!s.length) return null;
  const last = s[s.length - 1];
  if (PERENNIAL.has(last) || !isCrop(last)) {
    const steady = s.slice(-3).every((c) => c === last);
    return { code: last, why: steady ? 'Same cover for 3+ years' : 'Usually stays the same year to year', strength: steady ? 'high' : 'medium' };
  }
  // Clean alternation, e.g. corn / soy / corn / soy
  if (s.length >= 3) {
    const a = s[s.length - 1], b = s[s.length - 2];
    const alternating = a !== b && s.every((c, i) => c === ((s.length - 1 - i) % 2 === 0 ? a : b));
    if (alternating) return { code: b, why: `${prettyName(b)} / ${prettyName(a)} rotation every other year`, strength: 'high' };
    if (s.slice(-3).every((c) => c === a)) return { code: a, why: `${prettyName(a)} ${s.length >= 4 && s.slice(-4).every((c) => c === a) ? 'four' : 'three'} years running`, strength: 'high' };
  }
  const pair = ROTATION_PAIRS.find(([x, y]) => x === last || y === last);
  if (pair && s.length >= 2 && s[s.length - 2] !== last) {
    const other = pair[0] === last ? pair[1] : pair[0];
    if (s.includes(other)) return { code: other, why: `Rotates between ${prettyName(pair[0])} and ${prettyName(pair[1])}`, strength: 'medium' };
  }
  return { code: last, why: `Same as last year's crop`, strength: 'low' };
}

export const AHEAD_M = 300;

/**
 * Look up what's growing around a point.
 * mode: { heading, speed } -> left/right of the road, plus the fields ~300 m ahead;
 *       { tapped: true } -> that spot; otherwise -> all around.
 */
export async function lookup(lat, lon, mode = {}) {
  const layers = await discoverLayers();
  const road = mode.heading != null && !mode.tapped;
  // Results arrive a moment after the GPS fix, so read a little ahead to be beside the car on arrival.
  const lead = road ? Math.min(90, (mode.speed || 0) * 1.5) : 0;
  const groups = mode.tapped ? [['point', 'point', 0]] : road
    ? [['left', 'left', lead], ['right', 'right', lead], ['aheadLeft', 'left', lead + AHEAD_M], ['aheadRight', 'right', lead + AHEAD_M]]
    : [['here', 'here', 0]];
  const patches = groups.map(([key, side, ld]) => ({ key, pts: patchPoints(lat, lon, mode.heading, side, ld) }));

  const need = new Map();
  for (const { pts } of patches) for (const [a, b] of pts) {
    const [i, j] = tileIndex(a, b);
    need.set(`${i}|${j}`, [i, j]);
  }
  const sources = lookupSources(layers);
  const grids = await Promise.all(sources.map(async (src) => {
    const got = new Map();
    await Promise.all([...need].map(async ([k, [i, j]]) => {
      try { got.set(k, await getTile(src, i, j)); } catch { /* missing tile -> no data there */ }
    }));
    return got;
  }));
  if (grids.every((g) => g.size === 0)) throw new Error('The crop map server did not respond');

  const liveIdx = layers.live ? 0 : -1;
  const yearIdx = layers.years.map((_, n) => n + (layers.live ? 1 : 0));
  const result = { lat, lon, lead, at: Date.now(), layers, sides: {}, ahead: {} };

  for (const { key, pts } of patches) {
    const pick = (g) => (g.size ? vote(pts.map(([a, b]) => sampleTiles(g, a, b))) : null);
    const history = layers.years.map((y, n) => ({ year: y, ...(pick(grids[yearIdx[n]]) || { code: null }) })).reverse();
    let live = liveIdx >= 0 ? pick(grids[liveIdx]) : null;
    if (live && live.coverage < 0.4) live = null; // gap in the in-season map (clouds / missing tile)

    // The live map is rendered by color, so shared-color classes come back as the generic one.
    // If recent annual maps put a specific crop with that same color here, use that name.
    if (live) {
      const recent = [...history].reverse().find((h) => h.code != null && h.code !== live.code
        && !DOUBLE_CROP.has(h.code) && colorOf(h.code) === colorOf(live.code));
      if (recent) live.code = recent.code;
    }

    const prediction = predict(history.map((h) => h.code));
    const latest = [...history].reverse().find((h) => h.code != null);

    // A live reading that contradicts a long, steady history (e.g. 5 years of orchard) might be a
    // replant — or a misread. Show it, but don't present it as certain.
    const steady = prediction?.strength === 'high' && prediction.code === latest?.code;
    const changed = live && steady && family(live.code) !== family(prediction.code);

    let tier;
    const clear = live && isAg(live.code) && live.share >= 0.6 && live.agShare >= 0.5;
    if (clear && !changed) tier = 'live';
    else if (clear) tier = 'live-changed';
    else if (live && !isAg(live.code) && live.share >= 0.6) tier = 'live-cover'; // forest/town/water etc.
    else if (live) tier = 'live-mixed';
    else tier = 'annual';

    const shown = live ? live.code : prediction?.code ?? latest?.code ?? null;
    const out = {
      tier, code: shown, live, history, prediction,
      agrees: live && prediction ? live.code === prediction.code : null,
    };
    if (key === 'aheadLeft') result.ahead.left = out;
    else if (key === 'aheadRight') result.ahead.right = out;
    else result.sides[key] = out;
  }
  return result;
}

// ---------- quick reads (for scanning a whole route) ----------

/**
 * Left/right crop at a point using only the current-season map (or the latest annual map when
 * there's no live one): one layer instead of six, so a whole route can be scanned.
 */
export async function quickRead(lat, lon, heading) {
  const layers = await discoverLayers();
  const src = lookupSources(layers, 1)[0];
  const out = {};
  for (const side of ['left', 'right']) {
    const pts = patchPoints(lat, lon, heading, side, 0);
    const tiles = new Map();
    for (const [a, b] of pts) {
      const [i, j] = tileIndex(a, b);
      const k = `${i}|${j}`;
      if (!tiles.has(k)) tiles.set(k, await getTile(src, i, j).catch(() => null));
    }
    for (const [k, v] of tiles) if (!v) tiles.delete(k);
    const v = tiles.size ? vote(pts.map(([a, b]) => sampleTiles(tiles, a, b))) : null;
    out[side] = v && v.coverage > 0.4 ? v.code : null;
  }
  return out;
}

// ---------- connection quality ----------

// Weak signal (or the phone's data saver): load lighter maps.
export function slowNet() {
  const c = navigator.connection;
  return !!(c && (c.saveData || ['slow-2g', '2g', '3g'].includes(c.effectiveType)));
}

// Every crop everywhere (tools/build-regions.mjs): { national: {code: acres}, states: {ST: {code: acres}},
// top: {code: [[fips, acres, lat, lng, name, st], ...top 100 counties]} }.
let cropsP;
export const cropsData = () => (cropsP ??= fetch('data/crops.json').then((r) => r.json()));
