// The crop map layers.
//
// FieldLayer (zoomed in): fetches the crop map for the view as one image, cleans up speckle, groups
// pixels into fields (connected areas of one crop), traces each field's outline into a smooth shape,
// and draws every field as its own vector polygon, so fields stay crisp while zooming and can be
// hovered, tapped, highlighted, and filtered by crop.
//
// CropTiles (zoomed out): the same map as tiles, recolored into FieldSight's palette so colors match
// at every zoom.
import { rgbToCode, isAg, prettyName, wmsFetch } from './data.js';
import { cropColor, cropEmoji, cropLabel } from './palette.js';

export const FIELD_MIN_ZOOM = 12;
const METERS_PER_PX = 7;   // request resolution; source data is 10-30 m
const MAX_PX = 900;
const MIN_FIELD_PX = 5;    // ignore specks smaller than this (about a quarter acre)

// ---------- color helpers ----------

export function parseColor(c) {
  if (c.startsWith('#')) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const m = c.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (!m) return [128, 128, 128];
  const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
  const f = (n) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
const shade = (c, t) => `rgb(${parseColor(c).map((v) => Math.round(v * (1 - t))).join(',')})`;

// ---------- zoomed-out tiles ----------

export const CropTiles = L.GridLayer.extend({
  options: { tileSize: 512, opacity: 0.9, source: null, updateWhenZooming: false, keepBuffer: 1 },

  createTile(coords, done) {
    const size = this.getTileSize(), tile = document.createElement('canvas');
    tile.width = size.x; tile.height = size.y;
    const src = this.options.source;
    const b = this._tileCoordsToBounds(coords);
    const north = b.getNorth(), south = b.getSouth();
    const q = `SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${src.layer}&STYLES=&SRS=EPSG:4326` +
      `&BBOX=${b.getWest().toFixed(6)},${south.toFixed(6)},${b.getEast().toFixed(6)},${north.toFixed(6)}` +
      `&WIDTH=${size.x}&HEIGHT=${size.y}&FORMAT=image/png`;
    wmsFetch(src.url, q, 20000)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then((blob) => createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
      .then((bmp) => {
        const tmp = document.createElement('canvas');
        tmp.width = size.x; tmp.height = size.y;
        const tctx = tmp.getContext('2d', { willReadFrequently: true });
        tctx.drawImage(bmp, 0, 0);
        const inp = tctx.getImageData(0, 0, size.x, size.y).data;
        const out = new ImageData(size.x, size.y);
        // The server draws in lat/lon; the map is Web Mercator. Re-sample each row so they line up.
        const map = this._map, z = coords.z;
        for (let y = 0; y < size.y; y++) {
          const lat = map.unproject([coords.x * size.x, coords.y * size.y + y + 0.5], z).lat;
          const sy = Math.min(size.y - 1, Math.max(0, Math.floor((north - lat) / (north - south) * size.y)));
          for (let x = 0; x < size.x; x++) {
            const i = (sy * size.x + x) * 4, o = (y * size.x + x) * 4;
            const rgba = recolor(inp[i], inp[i + 1], inp[i + 2], inp[i + 3]);
            out.data[o] = rgba[0]; out.data[o + 1] = rgba[1]; out.data[o + 2] = rgba[2]; out.data[o + 3] = rgba[3];
          }
        }
        tile.getContext('2d').putImageData(out, 0, 0);
        done(null, tile);
      })
      .catch((e) => done(e, tile));
    return tile;
  },
});

const recolorCache = new Map();
const CLEAR = [0, 0, 0, 0];
function recolor(r, g, b, a) {
  if (a < 10) return CLEAR;
  const k = (r << 16) | (g << 8) | b;
  let v = recolorCache.get(k);
  if (!v) {
    const code = rgbToCode(r, g, b);
    v = code != null && isAg(code) ? [...parseColor(cropColor(code)), code === 176 || code === 171 ? 110 : 225] : CLEAR;
    recolorCache.set(k, v);
  }
  return v;
}

// ---------- zoomed-in fields ----------

export class FieldLayer {
  constructor(map, { onLoading, insets, onStats, pane = 'overlayPane', labelPane = 'markerPane' } = {}) {
    this.map = map;
    this.labelPane = labelPane;
    this.insets = insets || (() => ({ top: 0, bottom: 0 }));
    this.onLoading = onLoading || (() => {});
    this.onStats = onStats || (() => {});
    this.renderer = L.canvas({ pane, padding: 0.4, tolerance: 2 });
    this.group = L.layerGroup().addTo(map);
    this.labels = L.layerGroup().addTo(map);
    this.polys = [];
    this.source = null;
    this.grid = null;
    this.selected = null;
    this.hovered = null;
    this.focus = null;      // crop code to highlight; others are dimmed
    this.solid = false;     // more opaque fills on the dark map, so colors stay bright
    this.enabled = true;
    this.req = 0;
    this.tooltip = L.tooltip({ className: 'field-tip', direction: 'top', offset: [0, -12], opacity: 1 });

    let t;
    map.on('moveend', () => { clearTimeout(t); t = setTimeout(() => this.refresh(), 150); });
    // Hover (mouse only): light the field up and name it.
    map.on('mousemove', (e) => {
      if (e.originalEvent?.pointerType === 'touch') return;
      const id = this.hitIndex(e.latlng.lat, e.latlng.lng);
      if (id !== this.hovered) {
        const prev = this.hovered;
        this.hovered = id;
        if (prev != null) this.restyle(prev);
        if (id != null) this.restyle(id);
        map.getContainer().style.cursor = id != null ? 'pointer' : '';
      }
      if (id != null) {
        const f = this.fieldAt(e.latlng.lat, e.latlng.lng);
        this.tooltip.setLatLng(e.latlng).setContent(`${cropLabel(f.code)} · ${f.acres.toLocaleString()} ac`);
        if (!map.hasLayer(this.tooltip)) this.tooltip.addTo(map);
      } else if (map.hasLayer(this.tooltip)) map.removeLayer(this.tooltip);
    });
    map.on('mouseout', () => {
      if (map.hasLayer(this.tooltip)) map.removeLayer(this.tooltip);
      const prev = this.hovered;
      this.hovered = null;
      if (prev != null) this.restyle(prev);
    });
  }

  relabel() { this.placeLabels(); }

  setSource(source) {
    this.source = source;
    this.grid = null;
    this.selected = null;
    this.refresh(true);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.clear(); else this.refresh(true);
  }

  setSolid(on) {
    this.solid = on;
    this.polys.forEach((p, id) => p && this.restyle(id));
  }

  setFocus(code) {
    this.focus = code;
    this.polys.forEach((p, id) => p && this.restyle(id));
    this.placeLabels();
  }

  clear() {
    this.group.clearLayers();
    this.labels.clearLayers();
    this.polys = [];
    this.grid = null;
    this.onStats(null);
  }

  needsFetch() {
    const g = this.grid, z = this.map.getZoom();
    if (!g) return true;
    if (z - g.zoom >= 1 || g.zoom - z >= 1.5) return true;   // sharper when zooming in; coarser is fine for a bit
    const b = this.map.getBounds();
    return !(b.getWest() >= g.minx && b.getEast() <= g.maxx && b.getSouth() >= g.miny && b.getNorth() <= g.maxy);
  }

  async refresh(force = false) {
    if (!this.enabled || !this.source || this.map.getZoom() < FIELD_MIN_ZOOM) {
      if (this.grid) this.clear();
      return;
    }
    if (!force && !this.needsFetch()) { this.placeLabels(); return; }

    const b = this.map.getBounds().pad(0.4);
    const minx = b.getWest(), maxx = b.getEast(), miny = b.getSouth(), maxy = b.getNorth();
    const midLat = (miny + maxy) / 2;
    const wM = (maxx - minx) * 111320 * Math.cos(midLat * Math.PI / 180), hM = (maxy - miny) * 111320;
    const scale = Math.max(1, Math.max(wM, hM) / METERS_PER_PX / MAX_PX);
    const W = Math.max(32, Math.round(wM / METERS_PER_PX / scale)), H = Math.max(32, Math.round(hM / METERS_PER_PX / scale));

    const id = ++this.req;
    this.onLoading(true);
    try {
      const query = `SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${this.source.layer}&STYLES=&SRS=EPSG:4326` +
        `&BBOX=${minx.toFixed(6)},${miny.toFixed(6)},${maxx.toFixed(6)},${maxy.toFixed(6)}&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/png`;
      const res = await wmsFetch(this.source.url, query, 15000);
      if (!res.ok || !(res.headers.get('content-type') || '').includes('png')) throw new Error('crop image failed');
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      if (id !== this.req) return;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, W, H).data;

      const codes = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) {
        const c = rgbToCode(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
        codes[i] = c != null && isAg(c) ? c : 0;   // only farmland becomes fields
      }
      despeckle(codes, W, H);
      const { comp, comps } = components(codes, W, H);
      const depth = distanceToEdge(comp, W, H);
      traceOutlines(comp, comps, W, H);

      const prev = this.selected != null && this.grid ? this.grid.selPoint : null;
      this.grid = { minx, maxx, miny, maxy, W, H, codes, comp, comps, depth, zoom: this.map.getZoom() };
      this.hovered = null;
      this.build();
      // Keep the selection across refetches.
      this.selected = prev ? this.hitIndex(prev[0], prev[1]) : null;
      if (this.selected != null) { this.grid.selPoint = prev; this.restyle(this.selected); }
      this.placeLabels();
    } catch {
      /* keep what's shown; the next move retries */
    } finally {
      if (id === this.req) this.onLoading(false);
    }
  }

  // One polygon per field, swapped in all at once so the map never flashes empty.
  build() {
    const g = this.grid;
    const toLL = (x, y) => [g.maxy - y / g.H * (g.maxy - g.miny), g.minx + x / g.W * (g.maxx - g.minx)];
    const polys = [];
    const group = L.layerGroup();
    this.polys = polys;
    g.comps.forEach((c, id) => {
      if (c.count < MIN_FIELD_PX || !c.loops.length) return;
      const rings = c.loops.map((loop) => {
        const ring = [];
        for (let i = 0; i < loop.length; i += 2) ring.push(toLL(loop[i], loop[i + 1]));
        return ring;
      });
      const p = L.polygon(rings, { renderer: this.renderer, interactive: false, smoothFactor: 0.6, ...this.styleFor(id, c) });
      polys[id] = p;
      group.addLayer(p);
    });
    this.map.removeLayer(this.group);
    this.group = group.addTo(this.map);
  }

  styleFor(id, c = this.grid.comps[id]) {
    const col = cropColor(c.code);
    const sel = id === this.selected, hov = id === this.hovered;
    const dim = this.focus != null && c.code !== this.focus && !sel;
    const grassy = c.code === 176 || c.code === 171;
    return {
      fillColor: col,
      fillOpacity: dim ? 0.06 : sel ? 0.92 : hov ? 0.88 : grassy ? (this.solid ? 0.42 : 0.3) : this.solid ? 0.82 : 0.62,
      color: sel || hov ? '#ffffff' : shade(col, 0.55),
      weight: sel ? 3.5 : hov ? 2.5 : 1.3,
      opacity: dim ? 0.2 : 1,
    };
  }

  restyle(id) {
    const p = this.polys[id];
    if (!p || !this.grid) return;
    p.setStyle(this.styleFor(id));
    if (id === this.selected || id === this.hovered) p.bringToFront();
  }

  // Labels on the biggest visible fields (each at the deepest point of the uncovered part of the
  // field), plus the acreage of each crop in view for the legend.
  placeLabels() {
    const g = this.grid;
    this.labels.clearLayers();
    if (!g) return;
    const map = this.map, size = map.getSize(), inset = this.insets();
    const corners = [[0, inset.top], [size.x, inset.top], [0, size.y - inset.bottom], [size.x, size.y - inset.bottom]]
      .map(([x, y]) => map.containerPointToLatLng([x, y]));
    const lats = corners.map((c) => c.lat), lngs = corners.map((c) => c.lng);
    const toX = (lng) => Math.floor((lng - g.minx) / (g.maxx - g.minx) * g.W);
    const toY = (lat) => Math.floor((g.maxy - lat) / (g.maxy - g.miny) * g.H);
    const x0 = Math.max(0, toX(Math.min(...lngs))), x1 = Math.min(g.W - 1, toX(Math.max(...lngs)));
    const y0 = Math.max(0, toY(Math.max(...lats))), y1 = Math.min(g.H - 1, toY(Math.min(...lats)));
    const n = g.comps.length;
    const seen = new Int32Array(n), bestI = new Int32Array(n).fill(-1), bestD = new Float32Array(n).fill(-1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * g.W + x, c = g.comp[i];
      if (c < 0) continue;
      seen[c]++;
      const dd = Math.min(g.depth[i], x - x0, x1 - x, y - y0, y1 - y);
      if (dd > bestD[c]) { bestD[c] = dd; bestI[c] = i; }
    }

    // Crops in view, by area.
    const acresPerPx = this.pxAcres();
    const byCode = new Map();
    for (let id = 0; id < n; id++) {
      if (seen[id] && this.polys[id]) byCode.set(g.comps[id].code, (byCode.get(g.comps[id].code) || 0) + seen[id] * acresPerPx);
    }
    this.onStats([...byCode].map(([code, acres]) => ({ code, acres })).sort((a, b) => b.acres - a.acres));

    const a = map.latLngToContainerPoint([g.miny, g.minx]), c2 = map.latLngToContainerPoint([g.maxy, g.maxx]);
    const pxArea = Math.abs((c2.x - a.x) / g.W * (c2.y - a.y) / g.H) || 1;
    const cands = [];
    for (let id = 0; id < n; id++) {
      if (!this.polys[id] || !(seen[id] * pxArea > 2600 && bestI[id] >= 0)) continue;
      if (this.focus != null && g.comps[id].code !== this.focus && id !== this.selected) continue;
      cands.push(id);
    }
    cands.sort((p, q) => (q === this.selected) - (p === this.selected) || seen[q] - seen[p]);

    const taken = [];
    for (const id of cands) {
      if (taken.length >= 40) break;
      const i = bestI[id], x = i % g.W, y = (i - x) / g.W;
      const lat = g.maxy - (y + 0.5) / g.H * (g.maxy - g.miny), lng = g.minx + (x + 0.5) / g.W * (g.maxx - g.minx);
      const p = map.latLngToContainerPoint([lat, lng]);
      const code = g.comps[id].code, name = prettyName(code);
      const w = name.length * 7.2 + 48, h = 28;
      const r = [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2];
      if (r[0] < 6 || r[1] < inset.top + 6 || r[2] > size.x - 6 || r[3] > size.y - inset.bottom - 6) continue;
      if (taken.some((t) => r[0] < t[2] + 6 && r[2] > t[0] - 6 && r[1] < t[3] + 6 && r[3] > t[1] - 6)) continue;
      taken.push(r);
      L.marker([lat, lng], {
        pane: this.labelPane, interactive: false, keyboard: false,
        // Leaflet positions the outer element with a transform, so centering goes on an inner one.
        icon: L.divIcon({
          className: 'field-label-anchor', iconSize: [0, 0],
          html: `<span class="field-label${id === this.selected ? ' sel' : ''}" style="--c:${cropColor(code)}"><span class="emo">${cropEmoji(code)}</span>${name}</span>`,
        }),
      }).addTo(this.labels);
    }
  }

  pxAcres() {
    const g = this.grid;
    return ((g.maxx - g.minx) * 111320 * Math.cos(((g.miny + g.maxy) / 2) * Math.PI / 180) / g.W)
      * ((g.maxy - g.miny) * 111320 / g.H) / 4046.86;
  }

  hitIndex(lat, lng) {
    const g = this.grid;
    if (!g || lat < g.miny || lat > g.maxy || lng < g.minx || lng > g.maxx) return null;
    const x = Math.min(g.W - 1, Math.floor((lng - g.minx) / (g.maxx - g.minx) * g.W));
    const y = Math.min(g.H - 1, Math.floor((g.maxy - lat) / (g.maxy - g.miny) * g.H));
    const id = g.comp[y * g.W + x];
    return id >= 0 && this.polys[id] ? id : null;
  }

  // The field under a point: { id, code, acres } or null.
  fieldAt(lat, lng) {
    const id = this.hitIndex(lat, lng);
    if (id == null) return null;
    const c = this.grid.comps[id];
    return { id, code: c.code, acres: Math.max(1, Math.round(c.count * this.pxAcres())) };
  }

  select(id, at = null) {
    if (this.selected === id) return;
    const prev = this.selected;
    this.selected = id;
    if (this.grid) this.grid.selPoint = at;
    if (prev != null) this.restyle(prev);
    if (id != null) this.restyle(id);
    this.placeLabels();
  }
}

// ---------- image processing ----------

// Replace lone pixels with the crop that surrounds them.
function despeckle(codes, W, H) {
  const src = codes.slice();
  const counts = new Map();
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, self = src[i];
    counts.clear();
    let same = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const c = src[i + dy * W + dx];
      if (c === self) same++;
      else counts.set(c, (counts.get(c) || 0) + 1);
    }
    if (same >= 2) continue;
    let best = self, bn = 0;
    for (const [c, n] of counts) if (n > bn) { bn = n; best = c; }
    if (bn >= 5) codes[i] = best;
  }
}

// Connected areas of the same crop (4-neighbour). comp[i] = field id, or -1 for non-farmland.
function components(codes, W, H) {
  const comp = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!codes[s] || comp[s] !== -1) continue;
    const code = codes[s], id = comps.length;
    let count = 0;
    comp[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop(); count++;
      const x = i % W, y = (i - x) / W;
      if (x > 0 && comp[i - 1] === -1 && codes[i - 1] === code) { comp[i - 1] = id; stack.push(i - 1); }
      if (x < W - 1 && comp[i + 1] === -1 && codes[i + 1] === code) { comp[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && comp[i - W] === -1 && codes[i - W] === code) { comp[i - W] = id; stack.push(i - W); }
      if (y < H - 1 && comp[i + W] === -1 && codes[i + W] === code) { comp[i + W] = id; stack.push(i + W); }
    }
    comps.push({ code, count, loops: [] });
  }
  return { comp, comps };
}

// Chamfer distance from each pixel to its field's edge (0 outside fields).
function distanceToEdge(comp, W, H) {
  const d = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = comp[i];
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1
      || comp[i - 1] !== c || comp[i + 1] !== c || comp[i - W] !== c || comp[i + W] !== c;
    d[i] = c < 0 || edge ? 0 : 1e9;
  }
  for (let y = 1; y < H; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (d[i]) d[i] = Math.min(d[i], d[i - 1] + 1, d[i - W] + 1, d[i - W - 1] + 1.414, d[i - W + 1] + 1.414);
  }
  for (let y = H - 2; y >= 0; y--) for (let x = W - 2; x >= 1; x--) {
    const i = y * W + x;
    if (d[i]) d[i] = Math.min(d[i], d[i + 1] + 1, d[i + W] + 1, d[i + W + 1] + 1.414, d[i + W - 1] + 1.414);
  }
  return d;
}

// Trace every field's boundary (outer edge and holes) along pixel edges, then smooth it:
// edge midpoints turn staircases into diagonals, simplification keeps long straight edges
// straight, and corner-cutting rounds what's left. comps[id].loops = [[x,y,x,y,...], ...] (grid units).
function traceOutlines(comp, comps, W, H) {
  const V = W + 1;
  const next = new Map();
  const key = (v, c) => v * comps.length + c;
  const add = (c, from, to) => {
    const k = key(from, c);
    const a = next.get(k);
    if (a) a.push(to); else next.set(k, [to]);
  };
  const starts = comps.map(() => []);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = comp[i];
    if (c < 0 || comps[c].count < MIN_FIELD_PX) continue;
    const tl = y * V + x, tr = tl + 1, bl = tl + V, br = bl + 1;
    if (y === 0 || comp[i - W] !== c) { add(c, tl, tr); starts[c].push(tl); }
    if (x === W - 1 || comp[i + 1] !== c) { add(c, tr, br); starts[c].push(tr); }
    if (y === H - 1 || comp[i + W] !== c) { add(c, br, bl); starts[c].push(br); }
    if (x === 0 || comp[i - 1] !== c) { add(c, bl, tl); starts[c].push(bl); }
  }
  comps.forEach((f, c) => {
    for (const v0 of starts[c]) {
      if (!next.has(key(v0, c))) continue;
      const verts = [v0];
      let v = v0;
      for (;;) {
        const k = key(v, c), arr = next.get(k);
        if (!arr) break;
        const nv = arr.pop();
        if (!arr.length) next.delete(k);
        v = nv;
        if (v === v0) break;
        verts.push(v);
      }
      if (verts.length < 4) continue;
      const pts = [];
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        pts.push(((a % V) + (b % V)) / 2, (Math.floor(a / V) + Math.floor(b / V)) / 2);
      }
      const smooth = chaikin(chaikin(simplify(pts, 0.45)));
      if (smooth.length >= 6) f.loops.push(smooth);
    }
  });
}

// Douglas–Peucker on a closed ring of [x,y,...].
function simplify(pts, tol) {
  const n = pts.length / 2;
  if (n < 5) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[Math.floor(n / 2)] = 1;
  const stack = [[0, Math.floor(n / 2)], [Math.floor(n / 2), n]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const ex = pts[(e % n) * 2], ey = pts[(e % n) * 2 + 1], sx = pts[s * 2], sy = pts[s * 2 + 1];
    const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy) || 1;
    let far = -1, fd = tol;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dy * pts[i * 2] - dx * pts[i * 2 + 1] + ex * sy - ey * sx) / len;
      if (d > fd) { fd = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([s, far], [far, e]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

// One round of Chaikin corner-cutting on a closed ring.
function chaikin(pts) {
  const n = pts.length / 2, out = [];
  for (let i = 0; i < n; i++) {
    const x0 = pts[i * 2], y0 = pts[i * 2 + 1], j = (i + 1) % n, x1 = pts[j * 2], y1 = pts[j * 2 + 1];
    out.push(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1, 0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1);
  }
  return out;
}
