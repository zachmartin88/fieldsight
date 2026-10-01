// Crop Cards: a collectible album. Drive past a crop to earn its card; seeing it again adds stars.
// Cards come in themed sets; rarity comes from how many acres of that crop the country grows
// (from data/states.json), so a Christmas-tree farm really is a rare find. States you drive through
// become stamps.
import { prettyName, isAg, cropsData } from './data.js';
import { cropColor, cropEmoji } from './palette.js';

export const SETS = [
  { id: 'grain', name: 'Grain Belt', emoji: '🌾', codes: [1, 5, 24, 23, 22, 21, 28, 27, 4, 29, 3, 12, 13, 205, 25] },
  { id: 'fiber', name: 'Oil & Fiber', emoji: '🌻', codes: [2, 6, 31, 33, 32, 10, 11, 45, 41, 38] },
  { id: 'hay', name: 'Hay & Pasture', emoji: '🐄', codes: [36, 37, 58, 59, 60, 176, 61] },
  { id: 'orchard', name: 'Orchard', emoji: '🍎', codes: [66, 67, 68, 69, 72, 74, 75, 76, 77, 204, 211, 212, 242, 250] },
  { id: 'veggie', name: 'Veggie Patch', emoji: '🥕', codes: [43, 46, 47, 48, 49, 54, 206, 208, 216, 221, 222, 229, 227, 42, 53] },
  { id: 'rare', name: 'Rare Finds', emoji: '💎', codes: [70, 14, 57, 56, 39, 44, 215, 210, 218, 220] },
];
const SET_OF = new Map(SETS.flatMap((s) => s.codes.map((c) => [c, s])));
export const RARITY = [
  { id: 'common', name: 'Common', color: '#9aa3b2' },
  { id: 'uncommon', name: 'Uncommon', color: '#3fd98b' },
  { id: 'rare', name: 'Rare', color: '#47c6ff' },
  { id: 'epic', name: 'Epic', color: '#b388ff' },
  { id: 'legendary', name: 'Legendary', color: '#ffc53d' },
];
const STAR_AT = [1, 5, 20, 60, 150];   // sightings for ★1..★5
const KEY = 'fs.album';

// ---------- rarity from national acreage ----------

let national = null;
export async function loadRarity() {
  if (national) return national;
  try {
    const c = await cropsData();
    national = new Map(Object.entries(c.national).map(([k, v]) => [+k, v]));
  } catch { national = new Map(); }
  return national;
}
export function rarityOf(code) {
  const a = national?.get(code) || 0;
  const i = a > 20e6 ? 0 : a > 3e6 ? 1 : a > 4e5 ? 2 : a > 5e4 ? 3 : 4;
  return RARITY[i];
}

// ---------- the saved album ----------

export function loadAlbum() {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (a?.cards) return a;
  } catch { /* ignore */ }
  return { cards: {}, states: {}, started: Date.now() };
}
const save = (a) => { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* full */ } };

export const stars = (n) => STAR_AT.filter((t) => n >= t).length;

/**
 * Record a sighting. Returns { isNew, levelUp, card } so the app can celebrate.
 * Repeats only count once per ~2 km per crop, so one long field isn't 40 sightings.
 */
export function recordSighting(album, code, { lat, lon, place } = {}) {
  if (code == null || !isAg(code)) return null;
  const c = album.cards[code] || (album.cards[code] = { n: 0, first: Date.now(), where: place || null });
  if (c.lastLat != null && lat != null && Math.hypot(lat - c.lastLat, (lon - c.lastLon) * Math.cos(lat * Math.PI / 180)) < 0.018) return null;
  const before = stars(c.n);
  c.n++; c.lastLat = lat; c.lastLon = lon;
  if (!c.where && place) c.where = place;
  save(album);
  return { isNew: c.n === 1, levelUp: stars(c.n) > before && c.n > 1, card: { code, ...c } };
}

export function recordState(album, st) {
  if (!st || album.states[st]) return false;
  album.states[st] = Date.now();
  save(album);
  return true;
}

export function albumSummary(album) {
  const all = SETS.flatMap((s) => s.codes);
  const got = all.filter((c) => album.cards[c]);
  return { got: got.length, total: all.length, states: Object.keys(album.states).length, setsDone: SETS.filter((s) => s.codes.every((c) => album.cards[c])).length };
}

// ---------- rendering ----------

export function cardHtml(code, entry, { big = false } = {}) {
  const r = rarityOf(code);
  if (!entry) {
    return `<div class="ccard locked" style="--r:${r.color}" title="${r.name} · not found yet"><span class="q">?</span><span class="nm">???</span><i class="gem"></i></div>`;
  }
  const s = stars(entry.n);
  return `<div class="ccard ${big ? 'big' : ''} r-${r.id}" style="--c:${cropColor(code)};--r:${r.color}" data-code="${code}">
    <span class="art">${cropEmoji(code)}</span>
    <span class="nm">${prettyName(code)}</span>
    <span class="stars">${'★'.repeat(s)}<em>${'★'.repeat(5 - s)}</em></span>
    <i class="gem" title="${r.name}"></i>
  </div>`;
}

export function albumHtml(album, statesList) {
  const sum = albumSummary(album);
  const sets = SETS.map((s) => {
    const have = s.codes.filter((c) => album.cards[c]).length, done = have === s.codes.length;
    return `<section class="cset${done ? ' done' : ''}">
      <header><span>${s.emoji} ${s.name}</span><span class="cprog"><i style="width:${(have / s.codes.length * 100).toFixed(0)}%"></i></span><b>${have}/${s.codes.length}</b></header>
      <div class="cgrid">${s.codes.map((c) => cardHtml(c, album.cards[c])).join('')}</div>
    </section>`;
  }).join('');
  const stamps = statesList.map(([st, name]) => `<span class="stamp${album.states[st] ? ' got' : ''}" title="${name}">${st}</span>`).join('');
  return `<article class="detail album">
    <div class="lbl">Crop Cards</div>
    <div class="album-head">
      <div><b>${sum.got}</b><span>of ${sum.total} cards</span></div>
      <div><b>${sum.setsDone}</b><span>sets done</span></div>
      <div><b>${sum.states}</b><span>state stamps</span></div>
    </div>
    <p class="predict">Drive past a crop to collect its card. Rarer crops glow brighter. See it again to earn stars.</p>
    ${sets}
    <section class="cset"><header><span>🗺️ State stamps</span><b>${sum.states}/48</b></header><div class="stamps">${stamps}</div></section>
    <div class="sheet-actions"><button class="primary" data-act="sharealbum">✨ Share my album</button><button class="ghost" data-act="menu">Back</button></div>
  </article>`;
}

// Celebration when a new card drops (or levels up).
export function celebrate(container, code, entry, { levelUp = false } = {}) {
  const r = rarityOf(code);
  const el = document.createElement('div');
  el.className = `card-drop r-${r.id}`;
  el.style.setProperty('--c', cropColor(code));
  el.style.setProperty('--r', r.color);
  const s = stars(entry.n);
  el.innerHTML = `<div class="burst"></div>
    <div class="drop-card"><span class="art">${cropEmoji(code)}</span><span class="nm">${prettyName(code)}</span>
    <span class="rar">${r.name}</span><span class="stars">${'★'.repeat(s)}<em>${'★'.repeat(5 - s)}</em></span></div>
    <div class="drop-title">${levelUp ? `★ Level up!` : 'New card!'}</div>`;
  container.appendChild(el);
  const done = () => el.remove();
  el.addEventListener('click', done);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(done, 3100);
}
