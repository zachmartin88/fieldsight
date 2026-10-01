// "What's ahead": scan a planned route and summarize what you'll drive past.
//
// FieldSight can't read the route inside Google Maps or Apple Maps (they don't share it with other
// apps), so you plan the drive here: type a destination, or on Android share a place from Google Maps
// to FieldSight. The route comes from OSRM (the same free OpenStreetMap router the offline feature uses).
import { quickRead, isAg } from './data.js';

const STEP_M = 800;   // one reading every ~half mile

function along(coords) {
  // Cumulative distance (m) at each vertex.
  const d = [0];
  for (let i = 1; i < coords.length; i++) {
    const [a0, b0] = coords[i - 1], [a1, b1] = coords[i];
    const dy = (a1 - a0) * 111320, dx = (b1 - b0) * 111320 * Math.cos(a0 * Math.PI / 180);
    d.push(d[i - 1] + Math.hypot(dx, dy));
  }
  return d;
}

function pointAt(coords, cum, m) {
  let i = cum.findIndex((v) => v >= m);
  if (i === -1) i = coords.length - 1;
  if (i === 0) i = 1;
  const t = (m - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  const [a0, b0] = coords[i - 1], [a1, b1] = coords[i];
  const lat = a0 + (a1 - a0) * t, lon = b0 + (b1 - b0) * t;
  const heading = (Math.atan2((b1 - b0) * Math.cos(a0 * Math.PI / 180), a1 - a0) * 180 / Math.PI + 360) % 360;
  return { lat, lon, heading };
}

/**
 * Scan a route. Returns { stops: [{ m, left, right }], total } and reports progress as it goes.
 * Long routes are sampled more sparsely so a scan stays around 250 readings.
 */
export async function scanRoute(coords, onProgress, signal) {
  const cum = along(coords), total = cum.at(-1);
  const step = Math.max(STEP_M, total / 250);
  const marks = [];
  for (let m = step / 2; m < total; m += step) marks.push(m);
  const stops = new Array(marks.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < marks.length) {
      if (signal?.aborted) return;
      const k = next++, p = pointAt(coords, cum, marks[k]);
      const r = await quickRead(p.lat, p.lon, p.heading).catch(() => ({}));
      stops[k] = { m: marks[k], lat: p.lat, lon: p.lon, left: r.left ?? null, right: r.right ?? null };
      onProgress?.(++done, marks.length, stops);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return { stops: stops.filter(Boolean), total, step };
}

// Share of roadside by crop over a stretch of stops (both sides).
export function summarize(stops) {
  const counts = new Map();
  let n = 0;
  for (const s of stops) for (const c of [s.left, s.right]) {
    n++;
    const k = c != null && isAg(c) ? c : 'other';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts].map(([code, k]) => ({ code: code === 'other' ? null : code, share: k / (n || 1) }))
    .sort((a, b) => b.share - a.share);
}

// Index of the stop nearest the car (so "the next 10 miles" starts from here).
export function nearestStop(stops, lat, lon) {
  let best = 0, bd = Infinity;
  stops.forEach((s, i) => {
    const d = (s.lat - lat) ** 2 + ((s.lon - lon) * Math.cos(lat * Math.PI / 180)) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return { index: best, offRouteKm: Math.sqrt(bd) * 111.32 };
}
