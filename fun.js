// The fun layer: sounds, haptics, Kernel the mascot, lifetime stats and milestone badges.
import { prettyName, isAg } from './data.js';
import { cropEmoji, categoryOf } from './palette.js';
import { isNative, nativeHaptic } from './native.js';

const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private */ } };

// ---------- settings ----------

export const settings = {
  sound: get('fs.sound', true),
  buzz: get('fs.buzz', true),
  mascot: get('fs.mascot', true),
  set(k, v) { this[k] = v; put(`fs.${k}`, v); },
};

// ---------- sounds (synthesized, no audio files) ----------

let ctx = null;
function audio() {
  if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
function tone(freq, start, dur, { type = 'sine', vol = 0.12, slide = 0 } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + start, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
const SOUNDS = {
  pop: () => tone(520, 0, 0.12, { type: 'triangle', slide: 1.6 }),
  flip: () => { tone(380, 0, 0.07, { type: 'square', vol: 0.05 }); tone(640, 0.06, 0.08, { type: 'square', vol: 0.05 }); },
  ding: () => { tone(880, 0, 0.35, { vol: 0.1 }); tone(1320, 0.08, 0.4, { vol: 0.07 }); },
  card: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.07, 0.25, { type: 'triangle', vol: 0.09 })),
  win: () => [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.3, { type: 'triangle', vol: 0.1 })),
  right: () => { tone(660, 0, 0.12, { type: 'triangle' }); tone(990, 0.1, 0.25, { type: 'triangle' }); },
  wrong: () => tone(220, 0, 0.3, { type: 'sawtooth', vol: 0.05, slide: 0.7 }),
};
const BUZZ = { pop: 12, flip: 8, ding: [20, 40, 20], card: [30, 50, 30, 50, 60], win: [40, 60, 40, 60, 120], right: 25, wrong: [60, 40, 60] };

export function fx(kind) {
  if (settings.sound) SOUNDS[kind]?.();
  // iPhone app: real haptics (iPhone browsers don't support vibration at all).
  if (settings.buzz && isNative) nativeHaptic(kind);
  else if (settings.buzz && navigator.vibrate) navigator.vibrate(BUZZ[kind] ?? 10);
}

// ---------- Kernel, the mascot ----------

const KERNEL = `<svg viewBox="0 0 64 72" aria-hidden="true">
  <path d="M10 46 C2 34 6 18 14 12 C14 26 20 38 30 46 Z" fill="#3fbf6a"/>
  <path d="M54 46 C62 34 58 18 50 12 C50 26 44 38 34 46 Z" fill="#2ea85a"/>
  <ellipse cx="32" cy="34" rx="16" ry="24" fill="#ffc928"/>
  <g fill="#ffdd6b" opacity=".9">
    <circle cx="25" cy="20" r="3"/><circle cx="32" cy="18" r="3"/><circle cx="39" cy="20" r="3"/>
    <circle cx="22" cy="28" r="3"/><circle cx="42" cy="28" r="3"/><circle cx="24" cy="48" r="3"/><circle cx="40" cy="48" r="3"/><circle cx="32" cy="52" r="3"/>
  </g>
  <circle cx="26" cy="33" r="3.6" fill="#1a1408"/><circle cx="38" cy="33" r="3.6" fill="#1a1408"/>
  <circle cx="27.2" cy="31.8" r="1.2" fill="#fff"/><circle cx="39.2" cy="31.8" r="1.2" fill="#fff"/>
  <path d="M26 41 Q32 46 38 41" stroke="#1a1408" stroke-width="2.6" fill="none" stroke-linecap="round"/>
  <circle cx="21" cy="39" r="2.6" fill="#ff8a65" opacity=".55"/><circle cx="43" cy="39" r="2.6" fill="#ff8a65" opacity=".55"/>
  <path d="M10 46 C16 60 26 68 32 68 C38 68 48 60 54 46 C46 52 38 54 32 54 C26 54 18 52 10 46 Z" fill="#46c776"/>
</svg>`;

let mascotEl = null, mascotTimer = null;
export function kernel(text, { ms = 5200, speak = null, mood = '' } = {}) {
  if (!settings.mascot) return;
  if (!mascotEl) {
    mascotEl = document.createElement('div');
    mascotEl.className = 'kernel';
    mascotEl.innerHTML = `<div class="kbub"></div><div class="kbody">${KERNEL}</div>`;
    mascotEl.addEventListener('click', () => mascotEl.classList.remove('show'));
    document.body.appendChild(mascotEl);
  }
  mascotEl.querySelector('.kbub').innerHTML = text;
  mascotEl.className = `kernel show ${mood}`;
  clearTimeout(mascotTimer);
  mascotTimer = setTimeout(() => mascotEl?.classList.remove('show'), ms);
  speak?.(text.replace(/<[^>]+>/g, ''));
}
export const KERNEL_SVG = KERNEL;

// ---------- lifetime stats ----------

const STATS_KEY = 'fs.stats';
export const stats = get(STATS_KEY, {
  miles: {}, totalMiles: 0, fieldsTapped: 0, guessBest: 0, guessRight: 0, bingos: 0, daysDriven: [], nightDrive: false, earlyDrive: false,
});
export const saveStats = () => put(STATS_KEY, stats);

// Miles of roadside past each category (for "100 miles of corn" and friends).
export function addMiles(code, meters) {
  const cat = categoryOf(code)?.id ?? 'none';
  stats.miles[cat] = (stats.miles[cat] || 0) + meters / 1609.34;
}

// ---------- milestone badges ----------

export const BADGES = [
  { id: 'first-card', emoji: '🃏', name: 'First Card', desc: 'Collect your first crop card', test: (a) => cards(a) >= 1 },
  { id: 'ten-cards', emoji: '🗂️', name: 'Collector', desc: 'Collect 10 crop cards', test: (a) => cards(a) >= 10 },
  { id: 'twentyfive', emoji: '💼', name: 'Card Shark', desc: 'Collect 25 crop cards', test: (a) => cards(a) >= 25 },
  { id: 'set', emoji: '🏆', name: 'Full Set', desc: 'Complete any card set', test: (a, x) => x.setsDone >= 1 },
  { id: 'corn100', emoji: '🌽', name: 'Corn Hauler', desc: 'Drive past 100 miles of corn', test: () => (stats.miles.corn || 0) >= 100 },
  { id: 'soy50', emoji: '🫘', name: 'Bean Counter', desc: 'Drive past 50 miles of soybeans', test: () => (stats.miles.soy || 0) >= 50 },
  { id: 'wheat50', emoji: '🌾', name: 'Amber Waves', desc: 'Drive past 50 miles of wheat & grains', test: () => (stats.miles.grain || 0) >= 50 },
  { id: 'long', emoji: '🛣️', name: 'Long Hauler', desc: 'Drive 300 miles with FieldSight', test: () => stats.totalMiles >= 300 },
  { id: 'states3', emoji: '🗺️', name: 'State Hopper', desc: 'Collect 3 state stamps', test: (a) => Object.keys(a.states).length >= 3 },
  { id: 'states10', emoji: '🧭', name: 'Road Warrior', desc: 'Collect 10 state stamps', test: (a) => Object.keys(a.states).length >= 10 },
  { id: 'vines', emoji: '🍇', name: 'Vine Spotter', desc: 'Spot a vineyard', test: (a) => !!a.cards[69] },
  { id: 'rice', emoji: '🍚', name: 'Paddy Pal', desc: 'Spot a rice field', test: (a) => !!a.cards[3] },
  { id: 'xmas', emoji: '🎄', name: 'Tree Hunter', desc: 'Spot a Christmas tree farm', test: (a) => !!a.cards[70] },
  { id: 'night', emoji: '🦉', name: 'Night Owl', desc: 'Drive with FieldSight after 9 pm', test: () => stats.nightDrive },
  { id: 'early', emoji: '🌅', name: 'Early Bird', desc: 'Drive with FieldSight before 6 am', test: () => stats.earlyDrive },
  { id: 'explorer', emoji: '🔎', name: 'Field Explorer', desc: 'Tap 25 fields on the map', test: () => stats.fieldsTapped >= 25 },
  { id: 'bingo', emoji: '🎯', name: 'Bingo!', desc: 'Get a road-trip bingo', test: () => stats.bingos >= 1 },
  { id: 'guess5', emoji: '🧠', name: 'Crop Whisperer', desc: 'Guess 5 crops in a row', test: () => stats.guessBest >= 5 },
  { id: 'guess10', emoji: '🔮', name: 'Crop Oracle', desc: 'Guess 10 crops in a row', test: () => stats.guessBest >= 10 },
];
const cards = (a) => Object.keys(a.cards).filter((c) => isAg(+c)).length;

const EARNED_KEY = 'fs.badges';
export const earned = get(EARNED_KEY, {});

/** Check every badge; returns the ones newly earned (and records them). */
export function checkBadges(album, extra = {}) {
  const fresh = [];
  for (const b of BADGES) {
    if (earned[b.id]) continue;
    try { if (b.test(album, extra)) { earned[b.id] = Date.now(); fresh.push(b); } } catch { /* ignore */ }
  }
  if (fresh.length) put(EARNED_KEY, earned);
  return fresh;
}

export function badgesHtml() {
  return `<div class="badges-grid">${BADGES.map((b) => `<div class="badge-tile${earned[b.id] ? ' got' : ''}" title="${b.desc}">
    <span class="bemo">${earned[b.id] ? b.emoji : '🔒'}</span><b>${b.name}</b><small>${b.desc}</small></div>`).join('')}</div>`;
}

export const cropLine = (code) => `${cropEmoji(code)} ${prettyName(code)}`;
