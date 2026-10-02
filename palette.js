// FieldSight's own crop colors and icons. The official USDA palette (cdl-classes.js) is still used
// to *read* the map servers' images; this palette is what people see. Bright, friendly, and chosen
// so neighbouring crops that are common together (corn / soybeans / wheat / hay) look clearly different.
import { prettyName, isAg } from './data.js';

// code -> [color, emoji]
const CROPS = {
  1: ['#ffc928', '🌽'], 12: ['#ffe27a', '🌽'], 13: ['#ffd66b', '🍿'],
  5: ['#22c55e', '🫘'], 26: ['#9be15d', '🌾'], 254: ['#7fd98a', '🫘'], 241: ['#c9d84a', '🌽'],
  24: ['#fb7a24', '🌾'], 23: ['#f7c08a', '🌾'], 22: ['#e8914a', '🌾'], 225: ['#f4b942', '🌾'],
  236: ['#f08a5d', '🌾'], 238: ['#f59ac0', '🌾'],
  21: ['#f6b26b', '🌾'], 28: ['#d7a6f0', '🌾'], 27: ['#c58cf0', '🌾'], 29: ['#e0b0ff', '🌾'],
  25: ['#e4b4d8', '🌾'], 205: ['#d9a6e8', '🌾'], 39: ['#c9a27a', '🌾'],
  2: ['#f472b6', '☁️'], 3: ['#38bdf8', '🍚'], 4: ['#ff7a59', '🌾'], 6: ['#ffe14d', '🌻'],
  10: ['#d9a066', '🥜'], 11: ['#9ccf6a', '🍂'], 31: ['#e8f06a', '🌼'], 33: ['#ffe066', '🌼'],
  32: ['#8ab4ff', '🌸'], 41: ['#e070ff', '🍬'], 42: ['#b07a5a', '🫘'], 43: ['#b08968', '🥔'],
  45: ['#29d3c7', '🎋'], 46: ['#d4705a', '🍠'], 53: ['#9ee37d', '🫛'], 52: ['#7ccf9e', '🫘'],
  36: ['#a78bfa', '🌿'], 37: ['#c4b0ff', '🌾'], 58: ['#ff9fd8', '🍀'], 59: ['#86e3a8', '🌱'],
  60: ['#7fd6b3', '🌾'], 61: ['#8f8574', '🟫'],
  44: ['#6fd6c9', '🌱'], 47: ['#ff6b6b', '🥬'], 49: ['#c8a2ff', '🧅'], 54: ['#ff5d5d', '🍅'],
  48: ['#ff7b7b', '🍉'], 50: ['#7bd67b', '🥒'], 206: ['#ff9f45', '🥕'], 208: ['#d6b3ff', '🧄'],
  209: ['#ffb07a', '🍈'], 213: ['#ffb07a', '🍈'], 214: ['#5ed36a', '🥦'], 216: ['#ff5a5a', '🌶️'],
  219: ['#62d26f', '🥬'], 221: ['#ff5a7a', '🍓'], 222: ['#ffb84d', '🎃'], 227: ['#7ee07e', '🥬'],
  229: ['#ff9d3d', '🎃'], 243: ['#8ad46f', '🥬'], 244: ['#e6f0b0', '🥦'], 245: ['#b8e986', '🥬'],
  246: ['#ff7aa8', '🌱'], 247: ['#ffd27a', '🥬'], 248: ['#a77bff', '🍆'], 249: ['#ffa64d', '🎃'],
  250: ['#ff4f6d', '🍒'], 242: ['#6f7bff', '🫐'],
  66: ['#ff4f6d', '🍒'], 67: ['#ff9f80', '🍑'], 68: ['#ff6b6b', '🍎'], 69: ['#a070ff', '🍇'],
  70: ['#2fbf71', '🎄'], 71: ['#d8a080', '🌳'], 72: ['#ffa13d', '🍊'], 74: ['#c49a6c', '🌰'],
  75: ['#ffb3c7', '🌰'], 76: ['#b8925f', '🌰'], 77: ['#d4e06a', '🍐'], 204: ['#a6e06a', '🥜'],
  210: ['#ff9e8a', '🍑'], 211: ['#7fae5a', '🫒'], 212: ['#ff9a3d', '🍊'], 217: ['#ff8f6b', '🍎'],
  218: ['#ffa07a', '🍑'], 220: ['#c77dff', '🍑'], 223: ['#ffc48a', '🍑'], 215: ['#7bd17b', '🥑'],
  14: ['#6fe3c0', '🌿'], 57: ['#6fe3c0', '🌿'], 56: ['#9ad05a', '🍺'],
  176: ['#cdb98a', '🐄'], 171: ['#cdb98a', '🐄'],
};

// Non-farm cover: muted, so farmland stands out.
const COVER = {
  forest: ['#5f8a6e', '🌲'], shrub: ['#a8a07a', '🌵'], water: ['#4a86c5', '💧'], wetland: ['#5fa3a3', '🪷'],
  developed: ['#8b8f98', '🏘️'], barren: ['#b9ab90', '🪨'],
};
function coverOf(code) {
  if ([63, 141, 142, 143].includes(code)) return COVER.forest;
  if ([64, 152].includes(code)) return COVER.shrub;
  if ([83, 111, 112].includes(code)) return COVER.water;
  if ([87, 190, 195].includes(code)) return COVER.wetland;
  if ([82, 121, 122, 123, 124].includes(code)) return COVER.developed;
  if ([65, 131].includes(code)) return COVER.barren;
  return null;
}

// Stable pleasant color for anything not listed, so every crop still gets its own look.
function fallbackColor(code) {
  const hue = (code * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 70%, 68%)`;
}

// One color per broad category everywhere (fields, cards, chips), so the map always matches the
// key and never turns into a rainbow where many crops grow side by side. The crop's own name and
// emoji tell crops apart within a category.
let CAT_OF = new Map();   // filled in once CATEGORIES is defined below
export function cropColor(code) {
  if (code == null) return '#3a414c';
  const cat = CAT_OF.get(code) ?? (isAg(code) && code !== 61 && code !== 176 && code !== 171 ? CATEGORIES.find((c) => c.id === 'other') : null);
  if (cat) return cat.color;
  return CROPS[code]?.[0] ?? coverOf(code)?.[0] ?? fallbackColor(code);
}

export function cropEmoji(code) {
  if (code == null) return '';
  return CROPS[code]?.[1] ?? coverOf(code)?.[1] ?? (isAg(code) ? '🌱' : '');
}

// "🌽 Corn"
export const cropLabel = (code) => `${cropEmoji(code)} ${prettyName(code)}`.trim();

// Rough recent U.S. average yields, for a fun "what's in this field" number. Not a forecast.
export const TYPICAL_YIELD = {
  1: [180, 'bushels'], 5: [51, 'bushels'], 24: [50, 'bushels'], 23: [45, 'bushels'], 22: [40, 'bushels'],
  21: [75, 'bushels'], 28: [70, 'bushels'], 4: [70, 'bushels'], 3: [7500, 'lb'], 2: [850, 'lb of lint'],
  6: [1600, 'lb'], 10: [4000, 'lb'], 36: [3.3, 'tons of hay'], 37: [2, 'tons of hay'],
  41: [31, 'tons'], 43: [450, 'cwt'], 31: [1800, 'lb'],
};

// Very short names for tight spaces (history tiles).
const SHORT = {
  5: 'Soy', 1: 'Corn', 24: 'W. wheat', 23: 'S. wheat', 22: 'Durum', 26: 'Wht/Soy', 176: 'Pasture', 171: 'Grass',
  36: 'Alfalfa', 37: 'Hay', 61: 'Fallow', 2: 'Cotton', 3: 'Rice', 4: 'Sorghum', 47: 'Veg', 44: 'Other',
  121: 'Town', 122: 'Town', 123: 'Town', 124: 'City', 141: 'Forest', 142: 'Forest', 143: 'Forest', 111: 'Water',
  190: 'Wetland', 195: 'Wetland', 152: 'Shrub',
};
export const shortName = (code) => SHORT[code] ?? prettyName(code);

// Broad categories: the zoomed-out map and the color key use these, so the big picture reads as a
// handful of regions (corn country, wheat country, cotton country...) instead of 100 crop shades.
export const CATEGORIES = [
  { id: 'corn', name: 'Corn', emoji: '🌽', color: '#e8b931', codes: [1, 12, 13, 241] },
  { id: 'soy', name: 'Soybeans', emoji: '🫘', color: '#57b36b', codes: [5, 254, 239, 240] },
  { id: 'grain', name: 'Wheat & grains', emoji: '🌾', color: '#d9813a', codes: [24, 23, 22, 21, 28, 27, 29, 25, 205, 39, 4, 26, 225, 226, 236, 237, 238, 234, 235] },
  { id: 'cotton', name: 'Cotton', emoji: '☁️', color: '#e7a0bf', codes: [2, 232] },
  { id: 'rice', name: 'Rice', emoji: '🍚', color: '#5b9fd6', codes: [3] },
  { id: 'hay', name: 'Hay & alfalfa', emoji: '🌿', color: '#9a8ad8', codes: [36, 37, 58, 59, 60] },
  { id: 'orchard', name: 'Orchards & vines', emoji: '🍇', color: '#b467a8', codes: [66, 67, 68, 69, 70, 71, 72, 74, 75, 76, 77, 204, 210, 211, 212, 215, 217, 218, 220, 223, 242, 250] },
  { id: 'veg', name: 'Vegetables & melons', emoji: '🥕', color: '#cf5b4f', codes: [47, 48, 49, 50, 54, 206, 207, 208, 209, 213, 214, 216, 219, 221, 222, 224, 227, 229, 230, 231, 233, 243, 244, 245, 246, 247, 248, 249] },
  { id: 'other', name: 'Other crops', emoji: '🌻', color: '#3aa6a0', codes: [6, 10, 11, 31, 32, 33, 41, 42, 43, 44, 45, 46, 52, 53, 14, 57, 56, 38, 35, 34] },
  { id: 'pasture', name: 'Grass & pasture', emoji: '🐄', color: '#a89a76', codes: [176, 171] },
];
CAT_OF = new Map(CATEGORIES.flatMap((c) => c.codes.map((code) => [code, c])));
export const categoryOf = (code) => CAT_OF.get(code) ?? (isAg(code) && code !== 61 ? CATEGORIES.find((c) => c.id === 'other') : null);
