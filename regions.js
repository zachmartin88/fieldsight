// Zoomed-out map: instead of millions of 30 m squares, show summaries that break apart as you zoom.
//   zoom ≤ 6   states: tinted by their top planted crop, with a bubble ("🌽 45%")
//   zoom 7–10  counties: tinted by top planted crop, deeper where there's more cropland; bubbles from 8
// Data comes from data/states.json and data/counties.json (tools/build-regions.mjs).
import { prettyName } from './data.js';
import { cropColor, cropEmoji } from './palette.js';

export const STATE_MAX_ZOOM = 6;
export const COUNTY_MAX_ZOOM = 10;
// Not counted as "what's planted": grassland/pasture and idle fallow ground.
const GRASS = new Set([176, 171, 61]);

// Top planted crop (not grassland/pasture) and its share of planted cropland.
export const isPlanted = (c) => !GRASS.has(c);

export function topCrop(p) {
  const planted = p.top.filter(([c]) => !GRASS.has(c));
  if (!planted.length || !p.crop) return null;
  return { code: planted[0][0], share: planted[0][1] / p.crop };
}

const load = (name) => fetch(`data/${name}.json`).then((r) => r.json());

export class RegionLayer {
  constructor(map, { pane, labelPane = 'markerPane', onTap, insets, onUpdate } = {}) {
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
              l.on('mouseover', () => l.setStyle({ weight: 2.5, color: '#fff' }));
              l.on('mouseout', () => l.setStyle(this.style(f)));
            },
          });
        }
        if (this.level === level) this.layers[level].addTo(this.map);
      }
    }
    this.placeLabels();
    this.onUpdate();
  }

  style(f) {
    const p = f.properties, t = topCrop(p);
    const intensity = p.area ? Math.min(1, (p.crop / p.area) * 1.6) : 0;
    const dim = this.focus != null && t?.code !== this.focus;
    const has = this.focus != null ? p.top.find(([c]) => c === this.focus) : null;
    // When a crop is spotlighted, shade each region by how much of that crop it has.
    if (this.focus != null) {
      const share = has && p.crop ? has[1] / p.crop : 0;
      return {
        fillColor: cropColor(this.focus), fillOpacity: Math.min(0.9, share * 1.4),
        color: 'rgba(10,12,15,.65)', weight: this.level === 'states' ? 1.2 : 0.5, opacity: 1,
      };
    }
    return {
      fillColor: t ? cropColor(t.code) : '#3a414c',
      fillOpacity: t ? 0.12 + 0.68 * intensity : 0.05,
      color: this.level === 'states' ? 'rgba(255,255,255,.35)' : 'rgba(10,12,15,.55)',
      weight: this.level === 'states' ? 1.2 : 0.5,
      opacity: dim ? 0.4 : 1,
    };
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
    const taken = [];
    for (const f of feats) {
      const p = f.properties;
      const t = this.focus != null ? (() => { const h = p.top.find(([c]) => c === this.focus); return h ? { code: this.focus, share: h[1] / p.crop } : null; })() : topCrop(p);
      if (!t || t.share < 0.05) continue;
      if (level === 'counties' && p.crop / p.area < 0.08) continue;
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
          html: `<span class="region-bubble${compact ? ' compact' : ''}" style="--c:${cropColor(t.code)}" title="${prettyName(t.code)}">${text ? `<i>${text}</i>` : ''}<span class="emo">${cropEmoji(t.code)}</span>${compact ? '' : `${Math.round(t.share * 100)}%`}</span>`,
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
      for (const [c, a] of p.top) if (!GRASS.has(c)) sums.set(c, (sums.get(c) || 0) + a);
    }
    return [...sums].map(([code, acres]) => ({ code, acres })).sort((a, b) => b.acres - a.acres);
  }
}
