// America's famous farm regions, called out on the zoomed-out map. Tap one for a fun fact, then
// spotlight its crop or fly there. Facts are rounded on purpose ("about a third", "most of").
import { CATEGORIES } from './palette.js';

const cat = (id) => CATEGORIES.find((c) => c.id === id);

export const BELTS = [
  {
    id: 'corn', name: 'The Corn Belt', emoji: '🌽', cat: 'corn', at: [41.6, -91.8], rot: -6, size: 1.15, minZ: 3, maxZ: 6,
    fact: 'The U.S. grows roughly a third of the world’s corn, and most of it comes from right here: Iowa, Illinois, Nebraska, Minnesota, and Indiana lead the way.',
    sub: 'Iowa · Illinois · Indiana · Nebraska', fly: [41.8, -92.5, 7],
  },
  {
    id: 'wheat', name: 'The Wheat Belt', emoji: '🌾', cat: 'grain', at: [38.4, -99.6], rot: 4, size: 1.05, minZ: 3, maxZ: 6,
    fact: 'Kansas is called the Wheat State. Winter wheat is planted in fall, sleeps under the snow, and is harvested in early summer, a sea of gold by June.',
    sub: 'Kansas · Oklahoma · Nebraska', fly: [38.4, -99.0, 7],
  },
  {
    id: 'spring', name: 'Spring Wheat Country', emoji: '🌾', cat: 'grain', at: [47.6, -101.2], rot: -3, size: 0.85, minZ: 4, maxZ: 6,
    fact: 'North Dakota grows more spring wheat and durum (the pasta wheat) than anywhere else in the country.',
    sub: 'North Dakota · Montana', fly: [47.6, -100.5, 7],
  },
  {
    id: 'cotton', name: 'Cotton Country', emoji: '☁️', cat: 'cotton', at: [33.4, -101.9], rot: -4, size: 0.95, minZ: 3, maxZ: 6,
    fact: 'The plains around Lubbock, Texas are one of the largest cotton-growing patches on Earth. Fields turn snowy white just before the fall harvest.',
    sub: 'West Texas', fly: [33.6, -101.8, 8],
  },
  {
    id: 'rice', name: 'The Rice Bowl', emoji: '🍚', cat: 'rice', at: [34.9, -91.0], rot: 5, size: 0.85, minZ: 4, maxZ: 6,
    fact: 'Arkansas grows about half of America’s rice in flooded, perfectly leveled fields along the Mississippi Delta.',
    sub: 'Arkansas Delta', fly: [34.8, -91.2, 8],
  },
  {
    id: 'fruit', name: 'America’s Fruit Basket', emoji: '🍇', cat: 'orchard', at: [36.6, -120.4], rot: -8, size: 0.95, minZ: 3, maxZ: 6,
    fact: 'California’s Central Valley grows nearly all of America’s almonds and pistachios, plus most of its grapes, tomatoes, and a long list of fruit.',
    sub: 'Central Valley, California', fly: [36.7, -119.8, 8],
  },
  {
    id: 'citrus', name: 'The Citrus Belt', emoji: '🍊', cat: 'orchard', at: [27.6, -81.6], rot: 0, size: 0.8, minZ: 4, maxZ: 6,
    fact: 'Central Florida’s orange groves have long supplied much of America’s orange juice.',
    sub: 'Central Florida', fly: [27.6, -81.6, 8],
  },
  {
    id: 'potato', name: 'Potato Country', emoji: '🥔', cat: 'other', at: [43.0, -114.3], rot: 3, size: 0.8, minZ: 4, maxZ: 6,
    fact: 'Idaho grows about a third of America’s potatoes, mostly along the Snake River Plain.',
    sub: 'Snake River Plain, Idaho', fly: [42.8, -114.4, 8],
  },
  {
    id: 'palouse', name: 'The Palouse', emoji: '🌾', cat: 'grain', at: [46.9, -117.6], rot: -5, size: 0.75, minZ: 5, maxZ: 6,
    fact: 'Rolling, wind-built hills in eastern Washington and Idaho that grow wheat, lentils, and chickpeas, some of the most photographed farmland in the world.',
    sub: 'Eastern Washington & Idaho', fly: [46.8, -117.4, 9],
  },
  {
    id: 'beets', name: 'Sugarbeet Valley', emoji: '🍬', cat: 'other', at: [47.6, -96.9], rot: 2, size: 0.72, minZ: 6, maxZ: 6,
    fact: 'The Red River Valley of Minnesota and North Dakota is the country’s biggest sugarbeet region. A lot of America’s sugar starts here.',
    sub: 'Red River Valley', fly: [47.6, -96.8, 8],
  },
];

export class BeltLayer {
  constructor(map, { onTap, pane = 'markerPane' } = {}) {
    this.map = map;
    this.onTap = onTap || (() => {});
    this.layer = L.layerGroup();
    this.pane = pane;
    this.enabled = true;
    map.on('zoomend', () => this.update());
    this.update();
  }

  setEnabled(on) { this.enabled = on; this.update(); }

  // Screen rectangles of the visible callouts (so state bubbles stay clear of them).
  rects() {
    if (!this.enabled) return [];
    const z = this.map.getZoom();
    return BELTS.filter((b) => z >= b.minZ && z <= b.maxZ).map((b) => {
      const p = this.map.latLngToContainerPoint(b.at), s = b.size * (z <= 4 ? 0.82 : z >= 6 ? 1.12 : 1);
      const w = (b.name.length * 10.5 + 52) * s, h = 40 * s;
      return [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2];
    });
  }

  update() {
    const z = this.map.getZoom();
    this.layer.clearLayers();
    if (!this.enabled) { this.map.removeLayer(this.layer); return; }
    for (const b of BELTS) {
      if (z < b.minZ || z > b.maxZ) continue;
      const c = cat(b.cat).color, scale = b.size * (z <= 4 ? 0.82 : z >= 6 ? 1.12 : 1);
      L.marker(b.at, {
        pane: this.pane, keyboard: false, zIndexOffset: -500,
        icon: L.divIcon({
          className: 'field-label-anchor', iconSize: [0, 0],
          html: `<span class="belt" style="--c:${c};--rot:${b.rot}deg;--s:${scale}"><span class="be">${b.emoji}</span><span class="bn">${b.name}</span></span>`,
        }),
      }).on('click', (e) => { L.DomEvent.stop(e); this.onTap(b); }).addTo(this.layer);
    }
    this.layer.addTo(this.map);
  }
}
