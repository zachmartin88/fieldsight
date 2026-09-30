// Save a route for offline use: geocode the endpoints, get a driving route, work out which crop
// tiles line the road, and store them in the browser's Cache Storage. The service worker (sw.js)
// answers tile requests from that cache when there's no signal.
import { discoverLayers, lookupSources, tileIndex, tileSpec, tileQuery, wmsFetch, TILE } from './data.js';

export const SAVED_CACHE = 'fs-tiles-saved';
const ROUTES_KEY = 'fs.routes';
const MAX_MILES = 400;
const HISTORY_YEARS_OFFLINE = 3;   // live map + last 3 annual maps keeps downloads reasonable
const TILE_KB = { live: 28, annual: 9 };

// Same normalisation as sw.js: tiles are stored by service + query, whichever host served them.
export function tileCacheKey(service, query) {
  const q = new URLSearchParams(query);
  q.sort();
  return `https://fieldsight.tiles/${service}?${q}`;
}

export function loadRoutes() {
  try { return JSON.parse(localStorage.getItem(ROUTES_KEY) || '[]'); } catch { return []; }
}
function saveRoutes(routes) {
  try { localStorage.setItem(ROUTES_KEY, JSON.stringify(routes)); } catch { /* full or private mode */ }
}

export async function geocode(q) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=us&limit=1&q=${encodeURIComponent(q)}`);
  const [hit] = await res.json();
  if (!hit) throw new Error(`Couldn't find “${q}”`);
  return { lat: +hit.lat, lon: +hit.lon, name: hit.display_name.split(',').slice(0, 2).join(',') };
}

export async function route(from, to) {
  const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`);
  const j = await res.json();
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error('No driving route found');
  const r = j.routes[0];
  return { miles: r.distance / 1609.34, minutes: r.duration / 60, coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]) };
}

// Tiles within ~150 m either side of the route line.
export function corridorTiles(coords) {
  const tiles = new Map();
  const addAt = (lat, lon) => { const [i, j] = tileIndex(lat, lon); tiles.set(`${i}|${j}`, [i, j]); };
  for (let k = 0; k < coords.length - 1; k++) {
    const [a0, b0] = coords[k], [a1, b1] = coords[k + 1];
    const mLat = 111320, mLon = 111320 * Math.cos(a0 * Math.PI / 180);
    const dy = (a1 - a0) * mLat, dx = (b1 - b0) * mLon, len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(len / 150));
    const nx = len ? -dy / len : 0, ny = len ? dx / len : 0;   // unit normal (east, north)
    for (let s = 0; s <= steps; s++) {
      const lat = a0 + (a1 - a0) * s / steps, lon = b0 + (b1 - b0) * s / steps;
      for (const off of [-150, 0, 150]) addAt(lat + (ny * off) / mLat, lon + (nx * off) / mLon);
    }
  }
  return [...tiles.values()];
}

export async function planRoute(fromText, toText, here) {
  const from = fromText ? await geocode(fromText) : here ? { ...here, name: 'Current location' } : null;
  if (!from) throw new Error('Enter a starting point, or allow location access');
  const to = await geocode(toText);
  const r = await route(from, to);
  if (r.miles > MAX_MILES) throw new Error(`That route is ${Math.round(r.miles)} miles. Save up to ${MAX_MILES} miles at a time.`);
  const layers = await discoverLayers();
  const sources = lookupSources(layers, HISTORY_YEARS_OFFLINE);
  const tiles = corridorTiles(r.coords);
  const kb = tiles.length * sources.reduce((s, src) => s + (src.rgb ? TILE_KB.live : TILE_KB.annual), 0);
  return { from, to, ...r, tiles, sources, mb: kb / 1024 };
}

// Download every tile for every layer. onProgress(done, total). Returns the saved route record.
export async function downloadRoute(plan, onProgress, signal) {
  const cache = await caches.open(SAVED_CACHE);
  const jobs = [];
  for (const src of plan.sources) for (const [i, j] of plan.tiles) jobs.push({ src, i, j });
  const keys = [];
  let done = 0, failed = 0, cursor = 0;
  const service = (src) => (src.rgb ? 'icrop' : 'cdlall');

  async function worker() {
    while (cursor < jobs.length) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const { src, i, j } = jobs[cursor++];
      const q = tileQuery(src.layer, tileSpec(i, j));
      const k = tileCacheKey(service(src), q);
      try {
        if (!(await cache.match(k))) {
          const res = await wmsFetch(src.base, q, 20000);
          if (!res.ok) throw new Error(res.status);
          await cache.put(k, res);
        }
        keys.push(k);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        failed++;
      }
      onProgress?.(++done, jobs.length);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));

  const record = {
    id: Date.now().toString(36),
    name: `${plan.from.name} → ${plan.to.name}`,
    miles: Math.round(plan.miles), saved: new Date().toISOString(), tiles: plan.tiles.length,
    failed, keys,
    // A light copy of the line, for drawing on the map.
    line: plan.coords.filter((_, n) => n % Math.max(1, Math.floor(plan.coords.length / 400)) === 0),
  };
  saveRoutes([record, ...loadRoutes()]);
  return record;
}

export async function deleteRoute(id) {
  const routes = loadRoutes();
  const gone = routes.find((r) => r.id === id);
  const rest = routes.filter((r) => r.id !== id);
  saveRoutes(rest);
  if (!gone) return;
  const stillUsed = new Set(rest.flatMap((r) => r.keys));
  const cache = await caches.open(SAVED_CACHE);
  await Promise.all(gone.keys.filter((k) => !stillUsed.has(k)).map((k) => cache.delete(k)));
}

export { TILE };
