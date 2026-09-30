// Field overlay: fetches the crop map for the current view as one image, cleans up speckle,
// groups pixels into fields (connected areas of one crop), traces each field's outline into a
// smooth shape, and draws it tinted and outlined with a name label. Replaces the raw pixel
// tiles when zoomed in.
import { rgbToCode, isAg, prettyName, colorOf, wmsFetch } from './data.js';

export const FIELD_MIN_ZOOM = 13;
const METERS_PER_PX = 7;   // request resolution; source data is 10-30 m
const MAX_PX = 900;
const MAX_CANVAS = 4096;

// An image overlay whose "image" is a canvas we draw on (avoids encoding big PNGs).
const CanvasOverlay = L.ImageOverlay.extend({
  _initImage() {
    const c = this._image = this._url;
    L.DomUtil.addClass(c, 'leaflet-image-layer');
    if (this._zoomAnimated) L.DomUtil.addClass(c, 'leaflet-zoom-animated');
    if (this.options.className) L.DomUtil.addClass(c, this.options.className);
    c.onselectstart = L.Util.falseFn;
    c.onmousemove = L.Util.falseFn;
  },
});

export class FieldLayer {
  constructor(map, { onLoading, insets, pane = 'overlayPane', labelPane = 'markerPane' } = {}) {
    this.map = map;
    this.pane = pane;
    this.labelPane = labelPane;
    this.insets = insets || (() => ({ top: 0, bottom: 0 }));
    this.onLoading = onLoading || (() => {});
    this.source = null;        // { url, layer }
    this.grid = null;          // last decoded view
    this.selected = null;      // field id
    this.overlay = null;
    this.labels = L.layerGroup().addTo(map);
    this.enabled = true;
    this.req = 0;
    let t;
    map.on('moveend zoomend', () => { clearTimeout(t); t = setTimeout(() => this.refresh(), 200); });
  }

  // Re-place labels, e.g. when a panel opens over the map or the map rotates.
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
    if (this.overlay) { this.map.removeLayer(this.overlay); this.overlay = null; }
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
      if (this.overlay || this.labels.getLayers().length) this.clear();
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
        codes[i] = c != null && isAg(c) ? c : 0;   // only farmland is drawn
      }
      despeckle(codes, W, H);
      const { comp, comps } = components(codes, W, H);
      const depth = distanceToEdge(comp, W, H);
      traceOutlines(comp, comps, W, H);

      const prev = this.selected != null && this.grid ? this.grid.selPoint : null;
      this.grid = { minx, maxx, miny, maxy, W, H, codes, comp, comps, depth, zoom: this.map.getZoom() };
      // Keep the selection when the view is refetched.
      this.selected = prev ? this.hitIndex(prev[0], prev[1]) : null;
      this.draw();
    } catch {
      /* keep whatever is shown; next move retries */
    } finally {
      if (id === this.req) this.onLoading(false);
    }
  }

  draw() {
    const g = this.grid;
    if (!g) return;
    // Size the canvas to roughly the screen resolution it will be shown at.
    const a = this.map.latLngToContainerPoint([g.maxy, g.minx]), b = this.map.latLngToContainerPoint([g.miny, g.maxx]);
    const screenW = Math.hypot(b.x - a.x, b.y - a.y) || g.W;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const k = Math.max(1, Math.min(8, (screenW / g.W) * dpr * 0.75, MAX_CANVAS / g.W, MAX_CANVAS / g.H));
    const cv = document.createElement('canvas');
    cv.width = Math.round(g.W * k); cv.height = Math.round(g.H * k);
    const ctx = cv.getContext('2d');
    ctx.scale(k, k);
    ctx.lineJoin = 'round';

    const pathOf = (c) => {
      const p = new Path2D();
      for (const loop of c.loops) {
        p.moveTo(loop[0], loop[1]);
        for (let i = 2; i < loop.length; i += 2) p.lineTo(loop[i], loop[i + 1]);
        p.closePath();
      }
      return p;
    };
    g.comps.forEach((c, id) => {
      if (!c.loops.length) return;
      const p = pathOf(c), col = colorOf(c.code), dark = luminance(col) < 0.3;
      ctx.globalAlpha = id === this.selected ? 0.55 : dark ? 0.42 : 0.34;
      ctx.fillStyle = col;
      ctx.fill(p, 'evenodd');
      // Thin dark edge under a colored line, so outlines read on both the dark map and
      // satellite; dark crop colors (soybeans, forest greens) get a lighter line.
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3.2 / k * dpr;
      ctx.stroke(p);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = dark ? mix(col, '#ffffff', 0.45) : col;
      ctx.lineWidth = 1.7 / k * dpr;
      ctx.stroke(p);
    });
    if (this.selected != null && g.comps[this.selected]) {
      const p = pathOf(g.comps[this.selected]);
      ctx.globalAlpha = 1;
      ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 6 * dpr;
      ctx.strokeStyle = '#e8c170';
      ctx.lineWidth = 3.5 / k * dpr;
      ctx.stroke(p);
    }

    const bounds = L.latLngBounds([[g.miny, g.minx], [g.maxy, g.maxx]]);
    const old = this.overlay;
    this.overlay = new CanvasOverlay(cv, bounds, { pane: this.pane, interactive: false, className: 'field-canvas' }).addTo(this.map);
    if (old) this.map.removeLayer(old);
    this.placeLabels();
  }

  // Name labels on the biggest visible fields, each at the point deepest inside the field's
  // visible part, skipping any that would overlap or run under the HUD / panels.
  placeLabels() {
    const g = this.grid;
    this.labels.clearLayers();
    if (!g) return;
    const map = this.map, size = map.getSize(), inset = this.insets();
    // The part of the map not covered by the HUD or a panel (its bounding box if the map is rotated).
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
    const a = map.latLngToContainerPoint([g.miny, g.minx]), c2 = map.latLngToContainerPoint([g.maxy, g.maxx]);
    const pxArea = Math.abs(Math.hypot(c2.x - a.x, 0) / g.W * Math.hypot(0, c2.y - a.y) / g.H) || 1;
    const cands = [];
    for (let id = 0; id < n; id++) if (seen[id] * pxArea > 2500 && bestI[id] >= 0) cands.push(id);
    cands.sort((p, q) => (q === this.selected) - (p === this.selected) || seen[q] - seen[p]);

    const taken = [];
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
        pane: this.labelPane, interactive: false, keyboard: false,
        // Leaflet positions the outer element with a transform, so centering goes on an inner one.
        icon: L.divIcon({
          className: 'field-label-anchor', iconSize: [0, 0],
          html: `<span class="field-label${id === this.selected ? ' sel' : ''}"><span class="dot" style="background:${colorOf(code)}"></span>${name}</span>`,
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

  // The field under a point: { id, code, acres } or null.
  fieldAt(lat, lng) {
    const id = this.hitIndex(lat, lng);
    if (id == null) return null;
    const g = this.grid, c = g.comps[id];
    const pxM2 = ((g.maxx - g.minx) * 111320 * Math.cos(((g.miny + g.maxy) / 2) * Math.PI / 180) / g.W) * ((g.maxy - g.miny) * 111320 / g.H);
    return { id, code: c.code, acres: Math.round(c.count * pxM2 / 4046.86) };
  }

  // Select the field at a point (or clear with null).
  select(id, at = null) {
    if (this.selected === id) return;
    this.selected = id;
    if (this.grid) this.grid.selPoint = at;
    this.draw();
  }
}

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function luminance(hex) {
  const [r, g, b] = rgbOf(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
function mix(a, b, t) {
  const A = rgbOf(a), B = rgbOf(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`;
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
// straight, and corner-cutting rounds what's left. Result: comps[id].loops = [[x,y,x,y,...], ...]
// in grid units.
function traceOutlines(comp, comps, W, H) {
  const V = W + 1;
  const next = new Map();      // (vertex, field) -> end vertices of directed boundary edges
  const key = (v, c) => v * comps.length + c;
  const add = (c, from, to) => {
    const k = key(from, c);
    const a = next.get(k);
    if (a) a.push(to); else next.set(k, [to]);
  };
  const starts = comps.map(() => []);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = comp[i];
    if (c < 0) continue;
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
      // Midpoints of the unit edges.
      const pts = [];
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        pts.push(((a % V) + (b % V)) / 2, (Math.floor(a / V) + Math.floor(b / V)) / 2);
      }
      const simple = simplify(pts, 0.45);
      const smooth = chaikin(chaikin(simple));
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
