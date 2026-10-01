// Zoomed-out map: instead of millions of 30 m squares, show summaries that break apart as you zoom.
//   zoom ≤ 6   states: tinted by their top planted crop, with a bubble ("🌽 45%")
//   zoom 7–10  counties: tinted by top planted crop, deeper where there's more cropland; bubbles from 8
// Data comes from data/states.json and data/counties.json (tools/build-regions.mjs).
import { prettyName } from './data.js';
import { cropColor, cropEmoji, categoryOf } from './palette.js';
import { mixColor } from './fields.js';

export const STATE_MAX_ZOOM = 6;
export const COUNTY_MAX_ZOOM = 10;
// Not counted as "what's planted": grassland/pasture and idle fallow ground.
const GRASS = new Set([176, 171, 61]);

// Top planted crop (not grassland/pasture) and its share of planted cropland.
export const isPlanted = (c) => !GRASS.has(c);

// Zoomed out, crops count by broad category (corn, soybeans, wheat & grains, cotton, ...), so the
// map shows a few big crop regions instead of a patchwork. A category is represented by its first code.
const family = (c) => categoryOf(c)?.codes[0] ?? c;

export function topCrop(p) {
  if (!p.crop) return null;
  const sums = new Map();
  for (const [c, a] of p.top) if (!GRASS.has(c)) sums.set(family(c), (sums.get(family(c)) || 0) + a);
  const [best] = [...sums].sort((a, b) => b[1] - a[1]);
  return best ? { code: best[0], cat: categoryOf(best[0]), share: best[1] / p.crop } : null;
}
const catColor = (code) => categoryOf(code)?.color ?? cropColor(code);
const catEmoji = (code) => categoryOf(code)?.emoji ?? cropEmoji(code);

// A region only gets colored when it's real farm country with a clear leading crop.
const MIN_CROPLAND = { states: 0.06, counties: 0.12 };
const MIN_SHARE = 0.25;
const farmShare = (p) => (p.area ? p.crop / p.area : 0);

const load = (name) => fetch(`data/${name}.json`).then((r) => r.json());

export class RegionLayer {
  constructor(map, { pane, outlinePane, labelPane = 'markerPane', onTap, insets, onUpdate, reserved } = {}) {
    this.reserved = reserved || (() => []);
    this.outlineRenderer = outlinePane ? L.canvas({ pane: outlinePane, padding: 0.3 }) : null;
    this.onUpdate = onUpdate || (() => {});
    this.map = map;
    this.labelPane = labelPane;
    this.onTap = onTap || (() => {});
    this.insets = insets || (() => ({ top: 0, bottom: 0 }));
    this.renderer = L.canvas({ pane, padding: 0.3, tolerance: 0 });
    this.data = {};
    this.fc = {};
    this.layers = {};
    this.labels = L.layerGroup().addTo(map);
    this.level = null;
    this.enabled = true;
    this.focus = null;
    map.on('zoomend moveend', () => this.update());
    map.on('zoomend', () => { if (this.level === 'counties') this.layers.counties?.setStyle((f) => this.style(f)); });
  }

  setEnabled(on) { this.enabled = on; this.update(); }

  setFocus(code) {
    this.focus = code;
    for (const l of Object.values(this.layers)) l.setStyle((f) => this.style(f));
    this.placeLabels();
  }

  levelFor(z) {
    if (!this.enabled) return null;
    if (z <= STATE_MAX_ZOOM) return 'states';
    if (z <= COUNTY_MAX_ZOOM) return 'counties';
    return null;
  }

  async update() {
    const level = this.levelFor(this.map.getZoom());
    if (level !== this.level) {
      for (const [k, l] of Object.entries(this.layers)) if (k !== level) this.map.removeLayer(l);
      this.level = level;
      if (level) {
        if (!this.layers[level]) {
          this.data[level] ??= load(level);
          const fc = await this.data[level];
          this.fc[level] = fc;
          if (this.layers[level]) return;
          this.layers[level] = L.geoJSON(fc, {
            renderer: this.renderer, style: (f) => this.style(f), interactive: true, bubblingMouseEvents: false,
            onEachFeature: (f, l) => {
              l.on('click', (e) => { L.DomEvent.stop(e); this.onTap(level, f.properties, e.latlng); });
              l.on('mouseover', () => l.setStyle({ stroke: true, weight: 2, color: '#fff', opacity: 0.9 }));
              l.on('mouseout', () => l.setStyle(this.style(f)));
            },
          });
        }
        if (this.level === level) this.layers[level].addTo(this.map);
      }
      // A soft glow around the country (states drawn with a wide stroke under the fills).
      if (level && this.outlineRenderer) {
        if (!this.glow) {
          this.data.states ??= load('states');
          const st = await this.data.states;
          this.glow ??= L.featureGroup([
            L.geoJSON(st, { renderer: this.outlineRenderer, interactive: false, style: { fill: false, color: '#ffd76b', weight: 14, opacity: 0.12 } }),
            L.geoJSON(st, { renderer: this.outlineRenderer, interactive: false, style: { fill: false, color: '#fff2c4', weight: 4, opacity: 0.55 } }),
          ]);
        }
        if (this.level) this.glow.addTo(this.map);
      } else if (this.glow) this.map.removeLayer(this.glow);
      // Thin state lines over the borderless county view, for orientation.
      if (level === 'counties') {
        if (!this.stateLines) {
          this.data.states ??= load('states');
          const st = await this.data.states;
          this.stateLines ??= L.geoJSON(st, { renderer: this.renderer, interactive: false, style: { fill: false, color: '#ffffff', weight: 1.5, opacity: 0.6 } });
        }
        if (this.level === 'counties') this.stateLines.addTo(this.map);
      } else if (this.stateLines) this.map.removeLayer(this.stateLines);
    }
    this.placeLabels();
    this.onUpdate();
  }

  style(f) {
    const p = f.properties, t = topCrop(p), level = this.level;
    const farm = farmShare(p), min = MIN_CROPLAND[level] ?? 0.1;
    // States keep a thin outline; counties have none, so same-crop neighbours merge into regions.
    const line = level === 'states'
      ? { stroke: true, color: '#ffffff', weight: 1.6, opacity: 0.7 }
      : { stroke: false, weight: 0 };
    // Spotlight: shade each region by how much of that crop it grows.
    if (this.focus != null) {
      const fam = family(this.focus);
      const share = p.crop ? p.top.filter(([c]) => family(c) === fam).reduce((s, [, a]) => s + a, 0) / p.crop : 0;
      const v = farm < min ? 0 : Math.min(1, share * 1.5);
      const col = mixColor(catColor(fam), '#1b1e24', 1 - v);
      return v ? { ...(level === 'counties' ? { stroke: true, color: col, weight: 1, opacity: 1 } : line), fillColor: col, fillOpacity: 1 } : { ...line, fillOpacity: 0 };
    }
    if (!t || farm < 0.005) return { ...line, fillOpacity: 0 };
    // Every region gets its top crop's color; how deep the color is shows how much of the land is
    // farmed (pale = a little farming, full color = farm country). Mixed counties are a touch muted.
    // Painted solid; the whole pane is see-through (CSS), so neighbours blend with no seams.
    const strength = (0.3 + 0.7 * Math.sqrt(Math.min(1, farm / 0.55))) * (t.share < MIN_SHARE ? 0.8 : 1);
    const col = mixColor(catColor(t.code), '#1b1e24', 1 - strength);
    // Counties: an edge in the fill color hides seams; from zoom 8 a faint dark line shows each county.
    const seam = level !== 'counties' ? line
      : this.map.getZoom() >= 8 ? { stroke: true, color: '#0d0f12', weight: 0.7, opacity: 0.55 }
        : { stroke: true, color: col, weight: 1, opacity: 1 };
    return { ...seam, fillColor: col, fillOpacity: 1 };
  }

  // Bubbles like "🌽 45%": every state; counties from zoom 8, biggest cropland first, no overlaps.
  placeLabels() {
    this.labels.clearLayers();
    const level = this.level, z = this.map.getZoom();
    if (!level || (level === 'counties' && z < 8)) return;
    const fc = this.fc[level];
    if (!fc) return;
    const size = this.map.getSize(), inset = this.insets();
    const feats = fc.features.filter((f) => f.properties.at && f.properties.crop > 0)
      .sort((a, b) => b.properties.crop - a.properties.crop);
    const taken = [...this.reserved()];
    for (const f of feats) {
      const p = f.properties;
      const t = this.focus != null ? (() => {
        const fam = family(this.focus);
        const a = p.top.filter(([c]) => family(c) === fam).reduce((s2, [, x]) => s2 + x, 0);
        return a ? { code: fam, share: a / p.crop } : null;
      })() : topCrop(p);
      if (!t || t.share < (this.focus != null ? 0.05 : MIN_SHARE)) continue;
      // Every state gets a bubble; counties only where farming dominates (keeps the map calm).
      if (level === 'counties' && farmShare(p) < MIN_CROPLAND.counties) continue;
      const pt = this.map.latLngToContainerPoint(p.at);
      const text = level === 'states' ? `${p.st}` : '';
      // Counties thin out when zoomed out: emoji only and well spaced at 8, percentages from 9.
      const compact = level === 'counties' && z < 9;
      const gap = level === 'states' ? 4 : compact ? 34 : z < 10 ? 18 : 8;
      const w = level === 'states' ? 92 : compact ? 26 : 58, h = 26;
      const r = [pt.x - w / 2, pt.y - h / 2, pt.x + w / 2, pt.y + h / 2];
      if (r[0] < 4 || r[2] > size.x - 4 || r[1] < inset.top + 4 || r[3] > size.y - inset.bottom - 4) continue;
      if (taken.some((q) => r[0] < q[2] + gap && r[2] > q[0] - gap && r[1] < q[3] + gap && r[3] > q[1] - gap)) continue;
      taken.push(r);
      L.marker(p.at, {
        pane: this.labelPane, keyboard: false, interactive: true, bubblingMouseEvents: false,
        icon: L.divIcon({
          className: 'field-label-anchor', iconSize: [0, 0],
          html: `<span class="region-bubble${compact ? ' compact' : ''}" style="--c:${catColor(t.code)}" title="${categoryOf(t.code)?.name ?? prettyName(t.code)}">${text ? `<i>${text}</i>` : ''}<span class="emo">${catEmoji(t.code)}</span>${compact ? '' : `${Math.round(t.share * 100)}%`}</span>`,
        }),
      }).on('click', (e) => { L.DomEvent.stop(e); this.onTap(level, p, L.latLng(p.at)); }).addTo(this.labels);
    }
  }

  // Region totals for the legend: planted crops in the visible regions.
  statsInView() {
    const level = this.level;
    const fc = level && this.fc[level];
    if (!fc) return null;
    const b = this.map.getBounds(), sums = new Map();
    for (const f of fc.features) {
      const p = f.properties;
      if (!p.at || !b.contains(p.at)) continue;
      for (const [c, a] of p.top) if (!GRASS.has(c)) sums.set(family(c), (sums.get(family(c)) || 0) + a);
    }
    return [...sums].map(([code, acres]) => ({ code, acres })).sort((a, b) => b.acres - a.acres);
  }
}
