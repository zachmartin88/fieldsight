// Field overlay: fetches the crop map for the current view as one image, cleans up speckle,
// groups pixels into fields (connected areas of one crop), then draws each field as a tinted,
// outlined shape with a name label. Replaces the raw pixel tiles when zoomed in.
import { rgbToCode, isAg, prettyName, colorOf } from './data.js';

export const FIELD_MIN_ZOOM = 13;
const METERS_PER_PX = 7;   // request resolution; source data is 10-30 m
const MAX_PX = 900;

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

export class FieldLayer {
  constructor(map, { onLoading, insets } = {}) {
    this.map = map;
    this.insets = insets || (() => ({ top: 0, bottom: 0 }));
    this.onLoading = onLoading || (() => {});
    this.source = null;        // { url, layer }
    this.grid = null;          // last decoded view
    this.selected = null;      // component id
    this.image = null;
    this.labels = L.layerGroup().addTo(map);
    this.enabled = true;
    this.req = 0;
    let t;
    map.on('moveend zoomend', () => { clearTimeout(t); t = setTimeout(() => this.refresh(), 200); });
  }

  // Re-place labels, e.g. when a panel opens over the map.
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

  clear() {
    if (this.image) { this.map.removeLayer(this.image); this.image = null; }
    this.labels.clearLayers();
    this.grid = null;
  }

  // Refetch only when the view leaves the area we already have or the zoom changes.
  needsFetch() {
    const g = this.grid, z = this.map.getZoom();
    if (!g) return true;
    if (Math.abs(g.zoom - z) >= 1) return true;
    const b = this.map.getBounds();
    return !(b.getWest() >= g.minx && b.getEast() <= g.maxx && b.getSouth() >= g.miny && b.getNorth() <= g.maxy);
  }

  async refresh(force = false) {
    if (!this.enabled || !this.source || this.map.getZoom() < FIELD_MIN_ZOOM) {
      if (this.image || this.labels.getLayers().length) this.clear();
      return;
    }
    if (!force && !this.needsFetch()) { this.placeLabels(); return; }

    const b = this.map.getBounds().pad(0.35);
    const minx = b.getWest(), maxx = b.getEast(), miny = b.getSouth(), maxy = b.getNorth();
    const midLat = (miny + maxy) / 2;
    const wM = (maxx - minx) * 111320 * Math.cos(midLat * Math.PI / 180), hM = (maxy - miny) * 111320;
    const scale = Math.max(1, Math.max(wM, hM) / METERS_PER_PX / MAX_PX);
    const W = Math.max(32, Math.round(wM / METERS_PER_PX / scale)), H = Math.max(32, Math.round(hM / METERS_PER_PX / scale));

    const id = ++this.req;
    this.onLoading(true);
    try {
      const url = `${this.source.url}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${this.source.layer}&STYLES=&SRS=EPSG:4326` +
        `&BBOX=${minx.toFixed(6)},${miny.toFixed(6)},${maxx.toFixed(6)},${maxy.toFixed(6)}&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/png`;
      const res = await fetch(url);
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
        codes[i] = c != null && isAg(c) ? c : 0;   // only farmland is drawn
      }
      despeckle(codes, W, H);
      const { comp, comps } = components(codes, W, H);
      const depth = labelPoints(comp, comps, W, H);

      const prevSel = this.selected != null && this.grid ? this.grid.comps[this.selected] : null;
      this.grid = { minx, maxx, miny, maxy, W, H, codes, comp, comps, depth, zoom: this.map.getZoom() };
      withLatLng(this.grid);
      // Keep the selection when the view is refetched (match by the selected field's label point).
      this.selected = prevSel ? this.hitIndex(prevSel.lat, prevSel.lng) : null;
      this.draw();
    } catch {
      /* keep whatever is shown; next move retries */
    } finally {
      if (id === this.req) this.onLoading(false);
    }
  }

  // Draw fills + outlines at a higher resolution than the data so outlines stay thin.
  draw() {
    const g = this.grid;
    if (!g) return;
    const k = 3;
    const cv = document.createElement('canvas');
    cv.width = g.W * k; cv.height = g.H * k;
    const ctx = cv.getContext('2d');

    const fill = new ImageData(g.W, g.H);
    const rgbOf = new Map();
    for (let i = 0; i < g.W * g.H; i++) {
      const c = g.codes[i];
      if (!c) continue;
      let rgb = rgbOf.get(c);
      if (!rgb) { rgb = hexRgb(colorOf(c)); rgbOf.set(c, rgb); }
      const sel = g.comp[i] === this.selected;
      fill.data.set([rgb[0], rgb[1], rgb[2], sel ? 150 : 95], i * 4);
    }
    const small = document.createElement('canvas');
    small.width = g.W; small.height = g.H;
    small.getContext('2d').putImageData(fill, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, g.W * k, g.H * k);

    // Outlines between different fields, colored by the field on each side.
    const paths = new Map();
    const seg = (code, x1, y1, x2, y2) => {
      if (!code) return;
      let p = paths.get(code);
      if (!p) { p = new Path2D(); paths.set(code, p); }
      p.moveTo(x1, y1); p.lineTo(x2, y2);
    };
    for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) {
      const i = y * g.W + x, a = g.comp[i];
      if (x + 1 < g.W && g.comp[i + 1] !== a) {
        seg(g.codes[i], (x + 1) * k - 0.75, y * k, (x + 1) * k - 0.75, (y + 1) * k);
        seg(g.codes[i + 1], (x + 1) * k + 0.75, y * k, (x + 1) * k + 0.75, (y + 1) * k);
      }
      if (y + 1 < g.H && g.comp[i + g.W] !== a) {
        seg(g.codes[i], x * k, (y + 1) * k - 0.75, (x + 1) * k, (y + 1) * k - 0.75);
        seg(g.codes[i + g.W], x * k, (y + 1) * k + 0.75, (x + 1) * k, (y + 1) * k + 0.75);
      }
    }
    ctx.lineWidth = 1.5;
    for (const [code, p] of paths) { ctx.strokeStyle = colorOf(code); ctx.stroke(p); }

    // Selected field: gold outline on top.
    if (this.selected != null) {
      const p = new Path2D();
      for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) {
        const i = y * g.W + x;
        if (g.comp[i] !== this.selected) continue;
        if (x === 0 || g.comp[i - 1] !== this.selected) { p.moveTo(x * k, y * k); p.lineTo(x * k, (y + 1) * k); }
        if (x === g.W - 1 || g.comp[i + 1] !== this.selected) { p.moveTo((x + 1) * k, y * k); p.lineTo((x + 1) * k, (y + 1) * k); }
        if (y === 0 || g.comp[i - g.W] !== this.selected) { p.moveTo(x * k, y * k); p.lineTo((x + 1) * k, y * k); }
        if (y === g.H - 1 || g.comp[i + g.W] !== this.selected) { p.moveTo(x * k, (y + 1) * k); p.lineTo((x + 1) * k, (y + 1) * k); }
      }
      ctx.lineWidth = 4; ctx.strokeStyle = '#e8c170'; ctx.lineCap = 'square';
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 4;
      ctx.stroke(p);
    }

    const bounds = [[g.miny, g.minx], [g.maxy, g.maxx]];
    const url = cv.toDataURL();
    if (this.image) { this.image.setUrl(url); this.image.setBounds(L.latLngBounds(bounds)); }
    else this.image = L.imageOverlay(url, bounds, { pane: 'fields', interactive: false }).addTo(this.map);
    this.placeLabels();
  }

  // Name labels on the biggest visible fields, each at the point deepest inside the field's
  // visible part, skipping any that would overlap or run off screen.
  placeLabels() {
    const g = this.grid;
    this.labels.clearLayers();
    if (!g) return;
    const map = this.map, size = map.getSize(), b = map.getBounds();
    const toX = (lng) => Math.floor((lng - g.minx) / (g.maxx - g.minx) * g.W);
    const toY = (lat) => Math.floor((g.maxy - lat) / (g.maxy - g.miny) * g.H);
    const x0 = Math.max(0, toX(b.getWest())), x1 = Math.min(g.W - 1, toX(b.getEast()));
    const y0 = Math.max(0, toY(b.getNorth())), y1 = Math.min(g.H - 1, toY(b.getSouth()));
    const n = g.comps.length;
    const seen = new Int32Array(n), bestI = new Int32Array(n).fill(-1), bestD = new Float32Array(n).fill(-1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * g.W + x, c = g.comp[i];
      if (c < 0) continue;
      seen[c]++;
      // Distance to the field edge, capped by distance to the screen edge so labels stay on screen.
      const dd = Math.min(g.depth[i], x - x0, x1 - x, y - y0, y1 - y);
      if (dd > bestD[c]) { bestD[c] = dd; bestI[c] = i; }
    }
    const pxArea = (() => {
      const a = map.latLngToContainerPoint([g.miny, g.minx]), c = map.latLngToContainerPoint([g.maxy, g.maxx]);
      return Math.abs((c.x - a.x) / g.W * (c.y - a.y) / g.H);
    })();
    const cands = [];
    for (let id = 0; id < n; id++) if (seen[id] * pxArea > 2500 && bestI[id] >= 0) cands.push(id);
    cands.sort((a, c) => (c === this.selected) - (a === this.selected) || seen[c] - seen[a]);

    const taken = [], inset = this.insets();
    for (const id of cands) {
      if (taken.length >= 40) break;
      const i = bestI[id], x = i % g.W, y = (i - x) / g.W;
      const lat = g.maxy - (y + 0.5) / g.H * (g.maxy - g.miny), lng = g.minx + (x + 0.5) / g.W * (g.maxx - g.minx);
      const p = map.latLngToContainerPoint([lat, lng]);
      const code = g.comps[id].code, name = prettyName(code);
      const w = name.length * 7.2 + 30, h = 24;
      const r = [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2];
      if (r[0] < 6 || r[1] < inset.top + 6 || r[2] > size.x - 6 || r[3] > size.y - inset.bottom - 6) continue;
      if (taken.some((t) => r[0] < t[2] + 6 && r[2] > t[0] - 6 && r[1] < t[3] + 6 && r[3] > t[1] - 6)) continue;
      taken.push(r);
      L.marker([lat, lng], {
        pane: 'fieldLabels', interactive: false, keyboard: false,
        icon: L.divIcon({
          className: `field-label${id === this.selected ? ' sel' : ''}`, iconSize: null,
          html: `<span class="dot" style="background:${colorOf(code)}"></span>${name}`,
        }),
      }).addTo(this.labels);
    }
  }

  hitIndex(lat, lng) {
    const g = this.grid;
    if (!g || lat < g.miny || lat > g.maxy || lng < g.minx || lng > g.maxx) return null;
    const x = Math.min(g.W - 1, Math.floor((lng - g.minx) / (g.maxx - g.minx) * g.W));
    const y = Math.min(g.H - 1, Math.floor((g.maxy - lat) / (g.maxy - g.miny) * g.H));
    const id = g.comp[y * g.W + x];
    return id >= 0 ? id : null;
  }

  // The field under a point: { id, code, acres, lat, lng } or null.
  fieldAt(lat, lng) {
    const id = this.hitIndex(lat, lng);
    if (id == null) return null;
    const g = this.grid, c = g.comps[id];
    const pxM2 = ((g.maxx - g.minx) * 111320 * Math.cos(((g.miny + g.maxy) / 2) * Math.PI / 180) / g.W) * ((g.maxy - g.miny) * 111320 / g.H);
    return { id, code: c.code, acres: Math.round(c.count * pxM2 / 4046.86), lat: c.lat, lng: c.lng };
  }

  select(id) {
    if (this.selected === id) return;
    this.selected = id;
    this.draw();
  }
}

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
    comps.push({ code, count });
  }
  return { comp, comps };
}

// Put each label at the point deepest inside its field (chamfer distance to the field's edge),
// so it never lands in a neighbouring field for L-shaped or irregular fields.
function labelPoints(comp, comps, W, H) {
  const d = new Float32Array(W * H);
  const edge = (i, x, y) => x === 0 || y === 0 || x === W - 1 || y === H - 1
    || comp[i - 1] !== comp[i] || comp[i + 1] !== comp[i] || comp[i - W] !== comp[i] || comp[i + W] !== comp[i];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    d[i] = comp[i] < 0 || edge(i, x, y) ? 0 : 1e9;
  }
  const D = 1, DD = 1.414;
  for (let y = 1; y < H; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (d[i]) d[i] = Math.min(d[i], d[i - 1] + D, d[i - W] + D, d[i - W - 1] + DD, d[i - W + 1] + DD);
  }
  for (let y = H - 2; y >= 0; y--) for (let x = W - 2; x >= 1; x--) {
    const i = y * W + x;
    if (d[i]) d[i] = Math.min(d[i], d[i + 1] + D, d[i + W] + D, d[i + W + 1] + DD, d[i + W - 1] + DD);
  }
  const best = new Int32Array(comps.length).fill(-1), bestD = new Float32Array(comps.length).fill(-1);
  for (let i = 0; i < W * H; i++) {
    const c = comp[i];
    if (c >= 0 && d[i] > bestD[c]) { bestD[c] = d[i]; best[c] = i; }
  }
  comps.forEach((c, id) => { c.px = best[id]; c.depth = bestD[id]; });
  return d;
}

// Convert label pixel indexes to lat/lng once the grid bounds are known.
export function withLatLng(grid) {
  for (const c of grid.comps) {
    const x = c.px % grid.W, y = (c.px - x) / grid.W;
    c.lng = grid.minx + (x + 0.5) / grid.W * (grid.maxx - grid.minx);
    c.lat = grid.maxy - (y + 0.5) / grid.H * (grid.maxy - grid.miny);
  }
}
