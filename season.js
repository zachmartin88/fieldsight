// Seasons: the map follows the calendar. Gentle falling leaves / snow / petals / sparkles over the
// zoomed-out map, and in harvest season little tractors working the biggest corn and soybean fields.
export const SEASONS = {
  spring: { name: 'Planting season', emoji: '🌱', bits: ['🌸', '🌱', '🌼'], months: [3, 4, 5] },
  summer: { name: 'Growing season', emoji: '☀️', bits: ['✨', '🌿', '✨'], months: [6, 7, 8] },
  fall: { name: 'Harvest season', emoji: '🍂', bits: ['🍂', '🍁', '🌾'], months: [9, 10, 11] },
  winter: { name: 'Winter rest', emoji: '❄️', bits: ['❄️', '❅', '❄️'], months: [12, 1, 2] },
};
export function season(d = new Date()) {
  const m = d.getMonth() + 1;
  return Object.entries(SEASONS).find(([, s]) => s.months.includes(m));
}

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class SeasonLayer {
  constructor(map, { isDriving }) {
    this.map = map;
    this.isDriving = isDriving;
    [this.id, this.s] = season();
    this.box = document.createElement('div');
    this.box.className = 'season-fx';
    document.body.appendChild(this.box);
    this.tractors = L.layerGroup().addTo(map);
    map.on('zoomend', () => this.update());
    this.update();
  }

  // Drifting bits only when zoomed out and not driving (never distracting on the road).
  update() {
    const on = !calm() && !this.isDriving() && this.map.getZoom() <= 10;
    if (on && !this.box.children.length) {
      for (let i = 0; i < 14; i++) {
        const el = document.createElement('span');
        el.textContent = this.s.bits[i % this.s.bits.length];
        el.style.left = `${Math.random() * 100}%`;
        el.style.animationDuration = `${14 + Math.random() * 14}s`;
        el.style.animationDelay = `${-Math.random() * 28}s`;
        el.style.fontSize = `${12 + Math.random() * 10}px`;
        this.box.appendChild(el);
      }
    }
    this.box.hidden = !on;
    if (this.map.getZoom() < 13) this.tractors.clearLayers();
  }

  // Harvest season: a tractor driving back and forth in a few of the biggest corn/soy fields in view.
  placeTractors(fieldLayer) {
    this.tractors.clearLayers();
    if (this.id !== 'fall' || calm() || this.map.getZoom() < 13) return;
    const g = fieldLayer.grid;
    if (!g) return;
    const b = this.map.getBounds();
    const big = g.comps.map((c, id) => ({ c, id })).filter(({ c, id }) => (c.code === 1 || c.code === 5) && fieldLayer.polys[id])
      .sort((a, z) => z.c.count - a.c.count).slice(0, 12);
    let n = 0;
    for (const { id } of big) {
      if (n >= 3) break;
      const center = fieldLayer.polys[id].getBounds().getCenter();
      if (!b.contains(center)) continue;
      n++;
      L.marker(center, {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'field-label-anchor', iconSize: [0, 0], html: `<span class="tractor" style="--d:${8 + n * 2}s">🚜</span>` }),
      }).addTo(this.tractors);
    }
  }
}
