// America's famous farm regions, called out on the zoomed-out map. Tap one for a fun fact, then
// spotlight its crop or fly there. Facts are rounded on purpose ("about a third", "most of").
import { CATEGORIES } from './palette.js';

const cat = (id) => CATEGORIES.find((c) => c.id === id);

export const BELTS = [
  {
    id: 'corn', name: 'The Corn Belt', emoji: '🌽', cat: 'corn', at: [41.6, -91.8], rot: -6, size: 1.15, minZ: 3, maxZ: 6,
    facts: [
      "The U.S. grows roughly a third of the world’s corn, and most of it comes from right here: Iowa, Illinois, Nebraska, Minnesota, and Indiana lead the way.",
      "Iowa is usually the #1 corn state in the country, with more corn than many entire nations grow.",
      "Most of this isn’t the corn you eat off the cob. It’s field corn, used for animal feed, ethanol, and ingredients like corn syrup and cornstarch.",
      "An ear of corn always has an even number of rows of kernels, usually somewhere around 16.",
      "In the heat of July, corn can shoot up a couple of inches a day. Old-timers say you can hear it grow on a still night.",
      "Farmers here often switch corn and soybeans every other year. Soybeans add nitrogen back to the soil, which the next corn crop loves.",
    ],
    sub: 'Iowa · Illinois · Indiana · Nebraska', fly: [41.8, -92.5, 7],
  },
  {
    id: 'wheat', name: 'The Wheat Belt', emoji: '🌾', cat: 'grain', at: [38.4, -99.6], rot: 4, size: 1.05, minZ: 3, maxZ: 6,
    facts: [
      "Kansas is called the Wheat State. Winter wheat is planted in fall, sleeps under the snow, and is harvested in early summer, a sea of gold by June.",
      "Most Kansas wheat is hard red winter wheat, the kind bakers love for bread.",
      "One bushel of wheat makes roughly 70 loaves of bread.",
      "Every summer, custom harvest crews follow the ripening wheat north, from Texas all the way up toward Canada.",
      "Winter wheat actually needs a cold spell to head out in spring. Farmers call it vernalization.",
    ],
    sub: 'Kansas · Oklahoma · Nebraska', fly: [38.4, -99.0, 7],
  },
  {
    id: 'spring', name: 'Spring Wheat Country', emoji: '🌾', cat: 'grain', at: [47.6, -101.2], rot: -3, size: 0.85, minZ: 4, maxZ: 6,
    facts: [
      "North Dakota grows more spring wheat and durum than anywhere else in the country.",
      "Durum is the extra-hard wheat used for pasta. A lot of America’s spaghetti starts up here.",
      "Winters here are too harsh for most fall-planted wheat, so it goes in the ground in spring and is harvested in late summer.",
      "North Dakota also leads the country in crops like canola and dry beans.",
    ],
    sub: 'North Dakota · Montana', fly: [47.6, -100.5, 7],
  },
  {
    id: 'cotton', name: 'Cotton Country', emoji: '☁️', cat: 'cotton', at: [33.4, -101.9], rot: -4, size: 0.95, minZ: 3, maxZ: 6,
    facts: [
      "The plains around Lubbock, Texas are one of the largest cotton-growing patches on Earth.",
      "Texas grows more cotton than any other state.",
      "Cotton fields turn snowy white in fall when the bolls burst open, right before harvest.",
      "A bale of cotton weighs about 500 pounds, enough for hundreds of T-shirts.",
      "Much of West Texas cotton is dryland, grown on whatever rain falls, so every storm matters.",
    ],
    sub: 'West Texas', fly: [33.6, -101.8, 8],
  },
  {
    id: 'rice', name: 'The Rice Bowl', emoji: '🍚', cat: 'rice', at: [34.9, -91.0], rot: 5, size: 0.85, minZ: 4, maxZ: 6,
    facts: [
      "Arkansas grows about half of America’s rice.",
      "Rice fields are leveled with laser-guided equipment and flooded behind low curving levees. That’s the stripey look from above.",
      "Stuttgart, Arkansas calls itself the Rice and Duck Capital of the World. Flooded winter fields are a magnet for ducks.",
      "Most rice grown in the South is long-grain, the fluffy kind.",
    ],
    sub: 'Arkansas Delta', fly: [34.8, -91.2, 8],
  },
  {
    id: 'fruit', name: 'America’s Fruit Basket', emoji: '🍇', cat: 'orchard', at: [36.6, -120.4], rot: -8, size: 0.95, minZ: 3, maxZ: 6,
    facts: [
      "California’s Central Valley grows nearly all of America’s almonds and pistachios, plus most of its grapes and processing tomatoes.",
      "California grows the majority of the world’s almonds.",
      "Every February, almond orchards bloom white and beekeepers truck in hives from across the country. It’s the biggest pollination event on the planet.",
      "The Central Valley stretches about 450 miles, longer than some states.",
      "Those long straight rows of green you see are often vineyards. Fresno-area grapes become raisins, table grapes, and wine.",
    ],
    sub: 'Central Valley, California', fly: [36.7, -119.8, 8],
  },
  {
    id: 'citrus', name: 'The Citrus Belt', emoji: '🍊', cat: 'orchard', at: [27.6, -81.6], rot: 0, size: 0.8, minZ: 4, maxZ: 6,
    facts: [
      "Central Florida’s orange groves have long supplied much of America’s orange juice.",
      "The orange blossom is Florida’s state flower, and in spring the groves smell amazing.",
      "A disease called citrus greening has shrunk Florida’s orange harvest a lot over the past two decades. Growers are fighting back with new trees and research.",
    ],
    sub: 'Central Florida', fly: [27.6, -81.6, 8],
  },
  {
    id: 'potato', name: 'Potato Country', emoji: '🥔', cat: 'other', at: [43.0, -114.3], rot: 3, size: 0.8, minZ: 4, maxZ: 6,
    facts: [
      "Idaho grows about a third of America’s potatoes, mostly along the Snake River Plain.",
      "The classic Idaho potato is the Russet Burbank, a french-fry favorite.",
      "Volcanic soil, warm days, cool nights, and mountain-fed irrigation make the Snake River Plain potato heaven.",
    ],
    sub: 'Snake River Plain, Idaho', fly: [42.8, -114.4, 8],
  },
  {
    id: 'palouse', name: 'The Palouse', emoji: '🌾', cat: 'grain', at: [46.9, -117.6], rot: -5, size: 0.75, minZ: 5, maxZ: 6,
    facts: [
      "The Palouse’s rolling hills were built by wind-blown silt piled up over thousands of years.",
      "Rolling, wind-built hills in eastern Washington and Idaho that grow wheat, lentils, and chickpeas, some of the most photographed farmland in the world.",
      "This area grows a big share of America’s lentils and chickpeas.",
      "The hills are so steep that self-leveling hillside combines were developed to harvest them.",
    ],
    sub: 'Eastern Washington & Idaho', fly: [46.8, -117.4, 9],
  },
  {
    id: 'beets', name: 'Sugarbeet Valley', emoji: '🍬', cat: 'other', at: [47.6, -96.9], rot: 2, size: 0.72, minZ: 6, maxZ: 6,
    facts: [
      "The Red River Valley of Minnesota and North Dakota is the country’s biggest sugarbeet region.",
      "Sugarbeets make about half of the sugar produced in the U.S.",
      "The valley is the floor of an ancient glacial lake, which is why it’s so flat and so fertile.",
      "After the fall harvest, beets are stacked into enormous piles and kept cold until the factories can process them all.",
    ],
    sub: 'Red River Valley', fly: [47.6, -96.8, 8],
  },
];

// Facts come in a shuffled deck per region, so you see them all before any repeat.
const DECK_KEY = 'fs.factDeck';
function shuffled(n) {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function nextFact(belt) {
  let decks = {};
  try { decks = JSON.parse(localStorage.getItem(DECK_KEY) || '{}'); } catch { /* fresh deck */ }
  let d = decks[belt.id];
  if (!d || d.order.length !== belt.facts.length || d.i >= d.order.length) {
    const order = shuffled(belt.facts.length);
    // Don't start a new round with the fact you just saw.
    if (d && order.length > 1 && order[0] === d.order[d.order.length - 1]) order.push(order.shift());
    d = { order, i: 0 };
  }
  const fact = belt.facts[d.order[d.i]];
  d.i++;
  decks[belt.id] = d;
  try { localStorage.setItem(DECK_KEY, JSON.stringify(decks)); } catch { /* fine */ }
  return { text: fact, n: d.i, of: belt.facts.length };
}
export const randomFact = () => {
  const b = BELTS[Math.floor(Math.random() * BELTS.length)];
  return { belt: b, ...nextFact(b) };
};

export class BeltLayer {
  constructor(map, { onTap, pane = 'markerPane' } = {}) {
    this.map = map;
    this.onTap = onTap || (() => {});
    this.layer = L.layerGroup();
    this.pane = pane;
    this.enabled = true;
    this.active = null;     // the region whose fact card is open (its pill wiggles)
    map.on('zoomend', () => this.update());
    this.update();
  }

  setEnabled(on) { this.enabled = on; this.update(); }

  setActive(id) {
    this.active = id;
    this.update();
  }

  // Screen rectangles of the visible callouts (so state bubbles stay clear of them).
  rects() {
    if (!this.enabled || !this.map.getSize().x) return [];
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
          html: `<span class="belt${b.id === this.active ? ' active' : ''}" style="--c:${c};--rot:${b.rot}deg;--s:${scale}"><span class="be">${b.emoji}</span><span class="bn">${b.name}</span></span>`,
        }),
      }).on('click', (e) => { L.DomEvent.stop(e); this.onTap(b); }).addTo(this.layer);
    }
    this.layer.addTo(this.map);
  }
}
