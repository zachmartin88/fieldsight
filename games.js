// Games and daily content: road-trip bingo, guess the crop, crop of the day, county fun facts.
import { prettyName, isAg, NOTES, lookup, cropsData, slowNet } from './data.js';
import { cropColor, cropEmoji, categoryOf } from './palette.js';
import { countyName } from './share.js';

const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } };
const today = () => new Date().toISOString().slice(0, 10);

// Small seeded RNG so "today's" picks are the same all day.
function rng(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
const shuffle = (a, r) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let statesP, countiesP;
export const statesData = () => (statesP ??= fetch('data/states.json').then((r) => r.json()));
export const countiesData = () => (countiesP ??= fetch(`data/${slowNet() ? 'counties-lite' : 'counties'}.json`).then((r) => r.json()));
const GRASS = new Set([176, 171, 61]);

// =====================================================================
// Road-trip bingo: a 3×3 card of crops to spot today, built around where you are.
// =====================================================================

const BINGO_KEY = 'fs.bingo';
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export async function bingoCard(st) {
  const saved = get(BINGO_KEY, null);
  if (saved && saved.day === today()) return saved;
  const states = (await statesData()).features, crops = await cropsData();
  const home = states.find((f) => f.properties.st === st)?.properties || states.find((f) => f.properties.st === 'IA').properties;
  const r = rng(`${today()}-${home.st}`);
  // Everything grown in the state, biggest first; a few common ones plus some you'll have to hunt for.
  const all = Object.entries(crops.states[home.st] || {}).map(([c, a]) => [+c, a]).filter(([c]) => isAg(c) && !GRASS.has(c)).sort((a, b) => b[1] - a[1]);
  const local = all.slice(0, 4).map(([c]) => c);
  const wider = shuffle(all.slice(4).filter(([, a]) => a > 2000).map(([c]) => c), r).slice(0, 6);
  const picks = [...local.slice(0, 5), ...wider].filter((c, i, a) => a.indexOf(c) === i);
  while (picks.length < 8) picks.push([1, 5, 24, 36, 2, 3, 4, 21][picks.length]);
  const cells = shuffle(picks.slice(0, 8), r);
  cells.splice(4, 0, 'free');
  const card = { day: today(), st: home.st, stateName: home.name, cells, marked: { 4: Date.now() }, won: [] };
  put(BINGO_KEY, card);
  return card;
}

/** Mark a spotted crop; returns { marked: bool, newLines: n, blackout: bool }. */
export function bingoSpot(code) {
  const card = get(BINGO_KEY, null);
  if (!card || card.day !== today()) return null;
  const i = card.cells.indexOf(code);
  if (i < 0 || card.marked[i]) return null;
  card.marked[i] = Date.now();
  const lines = LINES.map((l, k) => (l.every((x) => card.marked[x]) ? k : -1)).filter((k) => k >= 0);
  const fresh = lines.filter((k) => !card.won.includes(k));
  card.won.push(...fresh);
  put(BINGO_KEY, card);
  return { marked: true, newLines: fresh.length, blackout: Object.keys(card.marked).length === 9, code };
}

export function bingoHtml(card) {
  return `<div class="bingo-head"><b>${card.stateName}</b> · ${new Date(card.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
    <div class="bingo">${card.cells.map((c, i) => c === 'free'
      ? '<div class="bcell free on"><span>🌟</span><small>Free</small></div>'
      : `<div class="bcell${card.marked[i] ? ' on' : ''}" style="--c:${cropColor(c)}"><span>${cropEmoji(c)}</span><small>${prettyName(c)}</small>${card.marked[i] ? '<i>✓</i>' : ''}</div>`).join('')}</div>
    <p class="predict">Drive past each crop to stamp it. Three in a row wins${card.won.length ? ` · <b>${card.won.length} bingo${card.won.length > 1 ? 's' : ''} today! 🎉</b>` : ''}. A new card every day.</p>`;
}

// =====================================================================
// Guess the crop: a bird's-eye photo of a real field. What's growing?
// =====================================================================

const POOL = [1, 5, 24, 2, 3, 36, 176, 69, 75, 4, 21, 6, 43, 61, 28, 10, 72];

export async function guessRound(near) {
  const counties = (await countiesData()).features.filter((f) => f.properties.at && f.properties.crop > 20000);
  for (let attempt = 0; attempt < 8; attempt++) {
    // Mostly real farm country; sometimes near where you're looking.
    let lat, lon;
    if (near && attempt < 3) { lat = near.lat + (Math.random() - 0.5) * 0.08; lon = near.lng + (Math.random() - 0.5) * 0.1; }
    else {
      const total = counties.reduce((s, f) => s + f.properties.crop, 0);
      let x = Math.random() * total, pick = counties[0];
      for (const f of counties) { x -= f.properties.crop; if (x <= 0) { pick = f; break; } }
      [lat, lon] = pick.properties.at;
      lat += (Math.random() - 0.5) * 0.12; lon += (Math.random() - 0.5) * 0.16;
    }
    try {
      const res = await lookup(lat, lon, { tapped: true });
      const s = res.sides.point;
      if (s.code == null || !isAg(s.code) || GRASS.has(s.code) || !['live', 'annual'].includes(s.tier)) continue;
      if (s.live && s.live.share < 0.7) continue;
      const cat = categoryOf(s.code)?.id;
      const wrong = shuffle(POOL.filter((c) => c !== s.code && categoryOf(c)?.id !== cat), Math.random).slice(0, 3);
      return { lat, lon, code: s.code, choices: shuffle([s.code, ...wrong], Math.random) };
    } catch { /* try another spot */ }
  }
  throw new Error('Couldn’t find a field right now');
}

// A 3×3 block of satellite tiles centered on the point (Esri World Imagery, zoom 16).
export function satelliteHtml(lat, lon, z = 16) {
  const n = 2 ** z, x = (lon + 180) / 360 * n, latR = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  const tx = Math.floor(x), ty = Math.floor(y), ox = (x - tx) * 256, oy = (y - ty) * 256;
  let tiles = '';
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    tiles += `<img src="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty + dy}/${tx + dx}" style="left:${(dx + 1) * 256}px;top:${(dy + 1) * 256}px" alt="">`;
  }
  return `<div class="sat"><div class="sat-tiles" style="--ox:${256 + ox}px;--oy:${256 + oy}px">${tiles}</div><i class="sat-ring"></i></div>`;
}

// =====================================================================
// Crop of the day
// =====================================================================

const FEATURED = [1, 5, 24, 2, 3, 36, 69, 75, 43, 6, 10, 41, 4, 21, 28, 31, 72, 68, 66, 74, 45, 70, 242, 221, 229, 54, 206, 204, 23, 22, 12, 48, 49, 76, 77, 46, 42, 33, 32, 11];

export function cropOfTheDay() {
  const day = Math.floor(Date.now() / 86400000);
  const order = shuffle(FEATURED, rng('fieldsight-crops'));
  return order[day % order.length];
}

/** National acres, top state, and the nearest county where it's a big crop. */
export async function cropFacts(code, near) {
  const [st, crops] = await Promise.all([statesData(), cropsData()]);
  const total = crops.national[code] || 0;
  let topState = null, topA = 0;
  for (const [abbr, list] of Object.entries(crops.states)) {
    if ((list[code] || 0) > topA) { topA = list[code]; topState = st.features.find((f) => f.properties.st === abbr)?.properties.name || abbr; }
  }
  // Nearest county with a real patch of it (bigger patches win ties on distance).
  let best = null, bestScore = Infinity;
  const biggest = crops.top[code]?.[0]?.[1] || 0;
  for (const [, a, lat, lng, name, abbr] of crops.top[code] || []) {
    if (a < Math.min(3000, biggest * 0.2)) continue;
    const d = near ? Math.hypot(lat - near.lat, (lng - near.lng) * Math.cos(near.lat * Math.PI / 180)) * 69 : 0;
    const score = near ? d / Math.sqrt(a) : -a;
    if (score < bestScore) { bestScore = score; best = { name: `${countyName(name)}, ${abbr}`, at: [lat, lng], acres: a, miles: near ? Math.round(d) : null }; }
  }
  return { total, topState, topStateAcres: topA, nearest: best, counties: crops.top[code]?.length || 0 };
}

export const cropBlurb = (code) => NOTES[code] || '';

// =====================================================================
// County fun facts, generated from the county numbers
// =====================================================================

export async function countyFacts(p) {
  const planted = p.top.filter(([c]) => !GRASS.has(c));
  if (!planted.length) return [];
  const [code, acres] = planted[0];
  const crops = await cropsData();
  const list = crops.top[code] || [];
  const rankUS = list.findIndex(([fips]) => fips === p.id) + 1;
  const rankState = list.filter(([, , , , , abbr]) => abbr === p.st).findIndex(([fips]) => fips === p.id) + 1;
  const statesLess = Object.values(crops.states).filter((s) => (s[code] || 0) < acres).length;
  const name = prettyName(code).toLowerCase(), emo = cropEmoji(code);
  const facts = [];
  if (rankState && rankState <= 10) facts.push(`${emo} The <b>#${rankState}</b> ${name} county in ${p.st}${rankUS <= 100 ? ` and <b>#${rankUS}</b> in the whole country` : ''}.`);
  facts.push(`🏈 That's about <b>${Math.round(acres / 1.32).toLocaleString()}</b> football fields of ${name}.`);
  if (statesLess >= 3) facts.push(`🗺️ It grows more ${name} than <b>${statesLess}</b> entire states.`);
  const mi2 = acres / 640;
  facts.push(`📐 Put together, its ${name} would cover about <b>${mi2 < 10 ? mi2.toFixed(1) : Math.round(mi2)}</b> square miles.`);
  return facts;
}
