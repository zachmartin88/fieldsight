import {
  lookup, discoverLayers, prettyName, isAg, NOTES, sideArea, LIVE_WMS, ANNUAL_WMS,
  wakeProxy, proxyUrl,
} from './data.js';
import { FieldLayer, CropTiles, FIELD_MIN_ZOOM } from './fields.js';
import { RegionLayer, COUNTY_MAX_ZOOM, topCrop, isPlanted } from './regions.js';
import { cropColor, cropEmoji, shortName, TYPICAL_YIELD, CATEGORIES, categoryOf } from './palette.js';
import { planRoute, downloadRoute, loadRoutes, deleteRoute } from './offline.js';
import { scanRoute, summarize, nearestStop } from './ahead.js';
import { parcelAt } from './parcels.js';
import { BeltLayer, BELTS, nextFact, randomFact } from './belts.js';
import { fieldCard, albumCard, shareCanvas, placeName, countyName } from './share.js';
import { loadAlbum, loadRarity, recordSighting, recordState, albumHtml, albumSummary, celebrate, rarityOf } from './album.js';
import { fx, kernel, settings, stats, saveStats, addMiles, checkBadges, badgesHtml } from './fun.js';
import { bingoCard, bingoSpot, bingoHtml, guessRound, satelliteHtml, cropOfTheDay, cropFacts, cropBlurb, countyFacts } from './games.js';
import { SeasonLayer, season } from './season.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), statusText: $('statusText'), strip: $('strip'), welcome: $('welcome'),
  startBtn: $('startBtn'), exploreBtn: $('exploreBtn'), voiceBtn: $('voiceBtn'), menuBtn: $('menuBtn'),
  about: $('about'), recenter: $('recenterBtn'), layerToggle: $('layerToggle'), baseBtn: $('baseBtn'),
  headBtn: $('headBtn'), legend: $('legend'), keyBtn: $('keyBtn'), mapHint: $('mapHint'), sheet: $('sheet'), sheetBody: $('sheetBody'), sheetClose: $('sheetClose'),
};

const state = {
  mode: 'idle',          // idle | drive | explore
  fix: null,             // latest GPS fix {lat, lon, speed, heading, t}
  prevFix: null,
  heading: null,
  following: true,
  headingUp: localGet('fs.headingUp') === '1',
  lastQuery: null,       // {lat, lon, heading, mode, t}
  lastDrive: null,       // latest left/right (or "around you") result
  inFlight: false,
  sheet: null,           // null | 'drive' | 'tap' | 'menu' | 'trip' | 'offline' | 'routes'
  tapSeq: 0,             // latest tap, so a slow earlier tap can't overwrite it
  serverDown: false,
  lastSpoken: {},
  voice: localGet('fs.voice') === '1',
  layers: null,
  focus: null,           // crop code spotlighted from the legend
  harvest: {},           // crop code -> share harvested (USDA weekly report, via the proxy)
  trip: loadTrip(),
  album: loadAlbum(),
  lastPlaceAt: null,     // where we last looked up the county/state (for cards and stamps)
  place: null,
};

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- map ----------

const map = L.map('map', {
  zoomControl: false, attributionControl: true, zoomSnap: 1,
  rotate: true, bearing: 0, touchRotate: false, shiftKeyRotate: false, rotateControl: false, compassBearing: false,
}).setView([39.5, -96.5], 5);
map.attributionControl.setPrefix(false);

// Fields and road labels turn with the map in heading-up mode; field name labels stay upright.
for (const [name, z] of [['outline', 330], ['regions', 340], ['fields', 350], ['labels', 420]]) {
  map.createPane(name, map._rotatePane || undefined);
  map.getPane(name).style.zIndex = z;
  // Only the state/county layer takes taps itself; fields are hit-tested from the map click.
  map.getPane(name).style.pointerEvents = name === 'regions' ? 'auto' : 'none';
}

const esri = (path, opts = {}) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, ...opts });
const BASES = {
  dark: [
    esri('Canvas/World_Dark_Gray_Base', { maxNativeZoom: 16, attribution: 'Esri' }),
    esri('Canvas/World_Dark_Gray_Reference', { maxNativeZoom: 16, pane: 'labels' }),
  ],
  satellite: [
    esri('World_Imagery', { maxNativeZoom: 19, attribution: 'Esri, Maxar' }),
    esri('Reference/World_Transportation', { pane: 'labels', opacity: 0.7 }),
    esri('Reference/World_Boundaries_and_Places', { pane: 'labels', opacity: 0.85 }),
  ],
};
let base = localGet('fs.base') === 'satellite' ? 'satellite' : 'dark';
let fields = null;   // the field layer (created below; setBase runs first)
function setBase(which) {
  base = which;
  localSet('fs.base', which);
  for (const [k, layers] of Object.entries(BASES)) for (const l of layers) (k === which ? l.addTo(map) : map.removeLayer(l));
  els.baseBtn.setAttribute('aria-pressed', String(which === 'satellite'));
  els.baseBtn.title = which === 'satellite' ? 'Switch to dark map' : 'Switch to satellite';
  fields?.setSolid(which === 'dark');
}
setBase(base);
els.baseBtn.addEventListener('click', () => setBase(base === 'dark' ? 'satellite' : 'dark'));
map.attributionControl.addAttribution('Crops: USDA NASS, GMU CSISS');

// Crops: pixel tiles when zoomed out, outlined + labeled fields when zoomed in.
// Keep map labels out from under the top bar, bottom panels and the map buttons.
function mapInsets() {
  const top = document.querySelector('.hud').getBoundingClientRect().bottom;
  const panels = [els.sheet, els.welcome, els.legend].filter((e) => !e.hidden && e.offsetParent)
    .map((e) => e.getBoundingClientRect()).filter((r) => r.width > window.innerWidth * 0.9);
  return { top, bottom: Math.max(76, ...panels.map((r) => window.innerHeight - r.top)) };
}

fields = new FieldLayer(map, {
  pane: 'fields', labelPane: 'markerPane',
  onLoading: (on) => {
    document.body.classList.toggle('loading', on);
    if (state.mode !== 'drive') setStatus(on ? 'Loading fields…' : 'Ready', on ? 'busy' : '');
  },
  // Only the layer that's showing drives the legend (fields here, regions when zoomed out).
  onStats: (st) => { if (map.getZoom() >= FIELD_MIN_ZOOM) { renderLegend(st); seasons?.placeTractors(fields); } },
  insets: mapInsets,
});
fields.setSolid(base === 'dark');
const regions = new RegionLayer(map, {
  pane: 'regions', outlinePane: 'outline', insets: mapInsets,
  reserved: () => belts?.rects() ?? [],
  onTap: (level, p, at) => openRegion(level, p, at),
  onUpdate: () => { if (map.getZoom() < FIELD_MIN_ZOOM) renderLegend(regions.statsInView()); },
});
// Famous farm regions ("The Corn Belt 🌽") on the zoomed-out map.
let belts = null;
let seasons = null;
belts = new BeltLayer(map, { onTap: (b) => openBelt(b) });
seasons = new SeasonLayer(map, { isDriving: () => state.mode === 'drive' });
const crop = { which: localGet('fs.layer') || 'live', tiles: null };

function cropSource(which) {
  const ly = state.layers;
  if (!ly || which === 'none') return null;
  if (which === 'live' && ly.live) return { url: LIVE_WMS, layer: ly.live.layer };
  return { url: ANNUAL_WMS, layer: `cdl_${ly.years[0]}` };
}

function setCrop(which) {
  crop.which = which;
  localSet('fs.layer', which);
  for (const b of els.layerToggle.querySelectorAll('button')) b.classList.toggle('on', b.dataset.layer === which);
  const src = cropSource(which);
  if (crop.tiles) { map.removeLayer(crop.tiles); crop.tiles = null; }
  if (src) {
    crop.tiles = new CropTiles({ source: src, pane: 'fields', opacity: 0.9 });
    fields.setSource(src);
  }
  fields.setEnabled(!!src);
  regions.setEnabled(!!src);
  belts.setEnabled(!!src);
  syncCropZoom();
}
// Zoom tiers: state/county summaries (≤10), crop-colored detail (11), individual fields (≥12).
function syncCropZoom() {
  const z = map.getZoom();
  const detail = z > COUNTY_MAX_ZOOM && z < FIELD_MIN_ZOOM;
  if (crop.tiles) (detail ? crop.tiles.addTo(map) : map.removeLayer(crop.tiles));
  els.mapHint.hidden = !(z < FIELD_MIN_ZOOM && crop.which !== 'none');
  els.mapHint.textContent = z <= COUNTY_MAX_ZOOM ? 'Tap a state or county · zoom in for fields' : 'Zoom in a little more for fields';
  if (z < FIELD_MIN_ZOOM) renderLegend(regions.statsInView());
}

// ---------- color key: what each color means (broad categories) ----------

async function renderKey() {
  // Share of U.S. cropland per category (from the state summaries), for a little "how big is it" bar.
  const share = new Map();
  try {
    const st = await (await fetch('data/states.json')).json();
    let total = 0;
    for (const f of st.features) for (const [c, a] of f.properties.top) {
      const cat = categoryOf(c);
      if (!cat || cat.id === 'pasture') continue;
      share.set(cat.id, (share.get(cat.id) || 0) + a); total += a;
    }
    for (const [k, v] of share) share.set(k, v / total);
  } catch { /* key still works without the numbers */ }
  const max = Math.max(...share.values(), 0.01);
  $('keyBody').innerHTML = CATEGORIES.map((c) => `<button data-code="${c.codes[0]}" style="--c:${c.color}">
      <span class="kemo">${c.emoji}</span><span class="kname">${esc(c.name)}</span>
      ${share.has(c.id) ? `<span class="kbar"><i style="width:${(share.get(c.id) / max * 100).toFixed(0)}%"></i></span><em>${Math.max(1, Math.round(share.get(c.id) * 100))}%</em>` : '<span class="kbar"></span><em></em>'}
    </button>`).join('');
  $('keyBody').insertAdjacentHTML('beforeend', '<p class="key-note"><b class="ramp"></b>Deeper color = more of the land is farmed · % = share of U.S. cropland · tap a crop to spotlight it</p>');
}
$('keyBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-code]');
  if (!b) return;
  const code = +b.dataset.code;
  spotlight(state.focus === code ? null : code);
});
function setKey(open) {
  $('key').classList.toggle('open', open);
  els.keyBtn.setAttribute('aria-pressed', String(open));
  localSet('fs.key', open ? '1' : '0');
}
renderKey();
els.keyBtn.addEventListener('click', () => setKey(!$('key').classList.contains('open')));
$('keyClose').addEventListener('click', () => setKey(false));
// Open by default on big screens; on phones it's one tap away (and remembered).
setKey(localGet('fs.key') != null ? localGet('fs.key') === '1' : window.innerWidth >= 760);

// ---------- "in view" legend: crops on screen; tap one to spotlight it ----------

let lastLegendStats = null;
function renderLegend(stats) {
  lastLegendStats = stats;
  if (!stats || !stats.length || crop.which === 'none') {
    els.legend.hidden = true;
    if (state.focus != null) { state.focus = null; fields.setFocus(null); regions.setFocus(null); }
    return;
  }
  const total = stats.reduce((t, r) => t + r.acres, 0);
  // Zoomed out, keep the legend to the few crops that define the region.
  const top = stats.filter((r) => r.acres / total >= 0.01).slice(0, map.getZoom() < FIELD_MIN_ZOOM ? 4 : 8);
  if (state.focus != null && !top.some((r) => r.code === state.focus)) top.push({ code: state.focus, acres: 0 });
  const appeared = els.legend.hidden;
  els.legend.hidden = false;
  // Labels were placed before the legend showed up; place them again clear of it.
  if (appeared) requestAnimationFrame(() => fields.relabel());
  // Zoomed out, legend entries are broad categories ("Wheat & grains"); zoomed in, single crops.
  const broad = map.getZoom() < FIELD_MIN_ZOOM;
  const look = (code) => (broad && categoryOf(code)
    ? { color: categoryOf(code).color, emoji: categoryOf(code).emoji, name: categoryOf(code).name }
    : { color: cropColor(code), emoji: cropEmoji(code), name: prettyName(code) });
  els.legend.innerHTML = top.map((r) => `<button data-code="${r.code}" class="${r.code === state.focus ? 'on' : ''}" style="--c:${look(r.code).color}">
      <span class="emo">${look(r.code).emoji}</span>${esc(look(r.code).name)}<em>${r.acres ? `${Math.max(1, Math.round(r.acres / total * 100))}%` : ''}</em>${state.harvest[r.code] != null ? `<s class="cut">${Math.round(state.harvest[r.code] * 100)}% harvested</s>` : ''}</button>`).join('');
  updateHarvest(top.map((r) => r.code));
}

// Harvest progress (needs the proxy + USDA key): fields fade toward straw as the state's harvest of
// that crop advances, and the legend says how far along it is.
let harvestKey = '';
async function updateHarvest(codes) {
  if (!proxyUrl || map.getZoom() < 9) return;
  const c = map.getCenter();
  const want = codes.filter((code) => PROGRESS_CODES.has(code));
  const key = `${c.lat.toFixed(0)}:${c.lng.toFixed(0)}:${want.join(',')}`;
  if (key === harvestKey) return;
  harvestKey = key;
  const next = {};
  await Promise.all(want.map(async (code) => {
    const data = await getProgress(c.lat, c.lng, code);
    const h = data?.progress.now.find((r) => r.what === 'harvested');
    if (h) next[code] = h.pct / 100;
  }));
  if (harvestKey !== key) return;
  const changed = JSON.stringify(next) !== JSON.stringify(state.harvest);
  state.harvest = next;
  fields.setHarvest(next);
  if (changed && !els.legend.hidden) renderLegend(lastLegendStats);
}
function spotlight(code) {
  state.focus = code;
  fields.setFocus(code);
  regions.setFocus(code);
  els.legend.querySelectorAll('button').forEach((x) => x.classList.toggle('on', +x.dataset.code === code));
  $('keyBody').querySelectorAll('[data-code]').forEach((x) => x.classList.toggle('on', +x.dataset.code === code));
}
els.legend.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const code = +b.dataset.code;
  spotlight(state.focus === code ? null : code);
});
map.on('zoomend moveend', syncCropZoom);
els.layerToggle.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setCrop(b.dataset.layer);
});

const meIcon = L.divIcon({
  className: 'me-arrow', iconSize: [30, 30], iconAnchor: [15, 15],
  html: '<svg viewBox="0 0 30 30"><circle cx="15" cy="15" r="13" fill="#0d0f12" stroke="#e8c170" stroke-width="2.5"/><path class="dir" d="M15 6l6 14-6-3.5L9 20z" fill="#e8c170"/></svg>',
});
let meMarker = null;
const areaLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const driveRouteLayer = L.layerGroup().addTo(map);   // the planned route while driving it
const parcelLayer = L.layerGroup().addTo(map);
let tapPin = null;

map.on('dragstart', () => {
  if (state.mode === 'drive') { state.following = false; els.recenter.hidden = false; }
});
els.recenter.addEventListener('click', () => {
  state.following = true; els.recenter.hidden = true;
  if (state.fix) follow(true);
});
map.on('click', (e) => onMapTap(e.latlng.lat, e.latlng.lng));

// ---------- heading-up ----------

function setHeadingUp(on) {
  state.headingUp = on;
  localSet('fs.headingUp', on ? '1' : '0');
  els.headBtn.setAttribute('aria-pressed', String(on));
  els.headBtn.title = on ? 'Heading up (tap for north up)' : 'North up (tap for heading up)';
  if (!on) map.setBearing(0);
  else if (state.heading != null) map.setBearing(-state.heading);
  updateArrow();
  fields.relabel();
  if (state.fix && state.following) follow(false);
}
els.headBtn.addEventListener('click', () => setHeadingUp(!state.headingUp));

// The arrow points the way you're going on screen: straight up in heading-up mode.
function updateArrow() {
  const rot = state.headingUp ? 0 : state.heading ?? 0;
  meMarker?.getElement()?.querySelector('.dir')?.setAttribute('transform', `rotate(${rot} 15 15)`);
}

// ---------- data sources ----------

discoverLayers().then((layers) => {
  state.layers = layers;
  const annualYear = layers.years[0];
  if (layers.live) $('liveLayerBtn').textContent = `Live ${layers.live.label.split(' ')[0]}`;
  else {
    $('liveLayerBtn').hidden = true;
    if (crop.which === 'live') crop.which = 'annual';
  }
  $('annualLayerBtn').textContent = String(annualYear);
  for (const el of document.querySelectorAll('.live-label')) el.textContent = layers.live?.label ?? 'n/a';
  for (const el of document.querySelectorAll('.annual-label')) el.textContent = annualYear;
  setCrop(crop.which);
}).catch(() => setStatus('Crop map server unreachable', 'err'));
wakeProxy();

// ---------- status ----------

function setStatus(text, cls = '') {
  els.statusText.textContent = text;
  els.status.className = `status ${cls}`;
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (h) => COMPASS[Math.round(h / 45) % 8];

function driveStatus(busy) {
  const f = state.fix;
  if (!f) return setStatus('Finding GPS…', 'busy');
  const parts = [];
  if (f.speed != null) parts.push(`${Math.round(f.speed * 2.237)} mph`);
  if (state.heading != null && f.speed > 2.5) parts.push(compass(state.heading));
  if (!parts.length) parts.push('GPS');
  if (!navigator.onLine) return setStatus(`${parts.join(' · ')} · offline`, 'err');
  if (state.serverDown) return setStatus(`${parts.join(' · ')} · map slow`, 'err');
  setStatus(parts.join(' · '), `on${busy ? ' busy' : ''}`);
}

// ---------- geo helpers ----------

function distM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function bearing(a, b) {
  const toR = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * toR) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lon - a.lon) * toR);
  return (Math.atan2(y, x) / toR + 360) % 360;
}
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// ---------- driving ----------

// Keep the car below center so more of the road ahead is visible under the HUD.
function follow(animate) {
  const f = state.fix, z = map.getZoom() < 14 ? 16 : map.getZoom();
  if (state.headingUp && state.heading != null) map.setBearing(-state.heading);
  const h = (state.headingUp ? state.heading ?? 0 : 0) * Math.PI / 180, d = map.getSize().y * 0.18;
  const p = map.project([f.lat, f.lon], z).add([Math.sin(h) * d, -Math.cos(h) * d]);
  map.setView(map.unproject(p, z), z, { animate });
}

function onFix(f) {
  state.prevFix = state.fix;
  state.fix = f;
  if (f.speed == null && state.prevFix) {
    const dt = (f.t - state.prevFix.t) / 1000;
    if (dt > 0) f.speed = distM(state.prevFix, f) / dt;
  }
  // Prefer the device heading; otherwise derive it from movement.
  if (f.heading != null && !Number.isNaN(f.heading) && f.speed > 1.5) state.heading = f.heading;
  else if (state.prevFix && distM(state.prevFix, f) > 12) state.heading = bearing(state.prevFix, f);

  const ll = [f.lat, f.lon];
  if (!meMarker) meMarker = L.marker(ll, { icon: meIcon, interactive: false, zIndexOffset: 1000 }).addTo(map);
  else meMarker.setLatLng(ll);
  updateArrow();
  // Don't pull the map away while the user is looking at a tapped field or a route.
  if (state.following && !['tap', 'offline', 'routes'].includes(state.sheet)) follow(true);

  driveStatus(state.inFlight);
  maybeQuery();
}

function queryMode() {
  const f = state.fix;
  return f.speed != null && f.speed > 2.5 && state.heading != null ? 'road' : 'here';
}

function maybeQuery() {
  if (state.inFlight || !state.fix) return;
  const f = state.fix, mode = queryMode(), q = state.lastQuery;
  const due = !q || q.mode !== mode
    || distM(q, f) >= 90
    || (mode === 'road' && angleDiff(q.heading, state.heading) > 35)
    || Date.now() - q.t > 30000;
  if (due) driveQuery(f.lat, f.lon, mode === 'road' ? { heading: state.heading, speed: f.speed } : {});
}

async function driveQuery(lat, lon, opts) {
  state.inFlight = true;
  state.lastQuery = { lat, lon, heading: opts.heading, mode: opts.heading != null ? 'road' : 'here', t: Date.now() };
  driveStatus(true);
  try {
    const res = await lookup(lat, lon, opts);
    state.serverDown = false;
    state.lastDrive = { res, opts };
    renderStrip(res);
    drawSideAreas(res, opts);
    logTrip(res);
    collect(res);
    if (state.sheet === 'drive') openDriveSheet();
    announce(res);
  } catch {
    state.serverDown = true;
    if (!state.lastDrive) renderStripMessage(navigator.onLine ? 'Crop map server is slow. Retrying…' : 'No signal. Save routes ahead of time for offline use.');
    // Retry in ~5 s (or sooner if we move 90 m) rather than hammering the server every GPS fix.
    state.lastQuery.t = Date.now() - 25000;
  } finally {
    state.inFlight = false;
    driveStatus(false);
  }
}

// ---------- collecting cards while driving ----------

// Cards come from confident readings only: the live map, or the USDA map where there's no live data.
async function collect(res) {
  const here = { lat: res.lat, lon: res.lon };
  if (!state.lastPlaceAt || distM(state.lastPlaceAt, here) > 4000) {
    state.lastPlaceAt = here;
    placeName(res.lat, res.lon).then((p) => {
      state.place = p;
      const st = p ? Object.entries(STATE_ABBR).find(([, n]) => n === p.state)?.[0] : null;
      if (st && recordState(state.album, st)) {
        toast(`🗺️ New state stamp: ${p.state}!`);
        fx('ding');
        kernel(`Welcome to <b>${esc(p.state)}</b>! 🗺️ New stamp for your album.`);
        rewardBadges();
      }
    });
  }
  for (const s of Object.values(res.sides)) {
    if (!['live', 'live-changed', 'annual'].includes(s.tier)) continue;
    const r = recordSighting(state.album, s.code, { ...here, place: state.place?.short });
    if (r && (r.isNew || r.levelUp)) {
      celebrate(document.body, s.code, r.card, { levelUp: r.levelUp });
      fx('card');
      if (r.isNew) {
        speak(`New card: ${prettyName(s.code)}!`);
        const rar = rarityOf(s.code);
        if (rar.id !== 'common') setTimeout(() => kernel(`Whoa, a <b>${rar.name.toLowerCase()}</b> card! ${cropEmoji(s.code)} Not everyone finds one of those.`, { mood: 'excited' }), 3200);
      }
      rewardBadges();
    }
    // Road-trip bingo.
    const b = isAg(s.code) ? bingoSpot(s.code) : null;
    if (b) {
      fx(b.newLines ? 'win' : 'pop');
      toast(`🎯 Bingo square: ${cropEmoji(s.code)} ${prettyName(s.code)}`);
      if (b.newLines) {
        stats.bingos += b.newLines; saveStats();
        setTimeout(() => kernel(b.blackout ? '🌟 <b>BLACKOUT!</b> You found every crop on today\'s card!' : '🎯 <b>BINGO!</b> Three in a row!', { mood: 'excited', ms: 6000 }), 600);
        rewardBadges();
      }
    }
  }
}

let STATE_ABBR = {};
fetch('data/states.json').then((r) => r.json()).then((j) => {
  STATE_ABBR = Object.fromEntries(j.features.map((f) => [f.properties.st, f.properties.name]).sort());
}).catch(() => {});
loadRarity();

// Milestone badges: check after anything that could earn one.
function rewardBadges() {
  const fresh = checkBadges(state.album, albumSummary(state.album));
  fresh.forEach((b, i) => setTimeout(() => {
    fx('ding');
    toast(`🏅 Badge unlocked: ${b.emoji} ${b.name}`);
    kernel(`You earned the <b>${b.emoji} ${esc(b.name)}</b> badge! ${esc(b.desc)}.`, { mood: 'excited' });
  }, 1200 + i * 3500));
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2800);
  setTimeout(() => el.remove(), 3300);
}

function openAlbum() {
  showSheet('album', albumHtml(state.album, Object.entries(STATE_ABBR))
    .replace('<div class="sheet-actions">', `<section class="cset"><header><span>🏅 Badge locker</span></header>${badgesHtml()}</section><div class="sheet-actions">`));
}

// ---------- the top strip ----------

const SIDE_NAME = { left: 'Left', right: 'Right', here: 'Around you', point: 'This spot' };

function tierTag(s, layers) {
  switch (s.tier) {
    case 'live': return '<span class="tag live">LIVE</span>';
    case 'live-changed': return '<span class="tag changed">NEW?</span>';
    case 'live-mixed': return '<span class="tag mixed">MIXED</span>';
    case 'live-cover': return `<span class="tag soft">${layers.live?.year ?? ''}</span>`;
    default: return `<span class="tag annual">${s.history.filter((h) => h.code != null).at(-1)?.year ?? ''} MAP</span>`;
  }
}

function renderStrip(res) {
  const keys = Object.keys(res.sides);
  els.strip.hidden = false;
  els.strip.classList.toggle('single', keys.length === 1);
  els.strip.innerHTML = keys.map((k) => {
    const s = res.sides[k];
    const name = s.code != null ? prettyName(s.code) : 'No data';
    const label = k === 'left' ? '◂ Left' : k === 'right' ? 'Right ▸' : SIDE_NAME[k];
    // "Then …": the crop ~300 m ahead on this side, when it changes.
    const a = res.ahead?.[k];
    const then = a && a.code != null && a.code !== s.code && isAg(a.code)
      ? `<div class="then">then ${cropEmoji(a.code)} ${esc(prettyName(a.code))}</div>` : '';
    return `<div class="side-cell tier-${s.tier}">
      <div class="lbl"><span>${label}</span>${tierTag(s, res.layers)}</div>
      <div class="name"><span class="chipdot" style="--c:${cropColor(s.code)}">${cropEmoji(s.code) || '·'}</span><span>${esc(name)}</span></div>
      ${then}
    </div>`;
  }).join('') + comingUp(res);
}

// With a planned route: the mix over the next ~10 miles.
function comingUp(res) {
  const scan = state.route?.plan?.scan;
  if (!scan?.stops.length) return '';
  const { index, offRouteKm } = nearestStop(scan.stops, res.lat, res.lon);
  if (offRouteKm > 3) return '<div class="coming">Off your planned route</div>';
  const n = Math.max(1, Math.round(16093 / scan.step));
  const next = scan.stops.slice(index, index + n);
  if (!next.length) return '<div class="coming">🏁 Almost there</div>';
  const mix = summarize(next).filter((r) => r.code != null).slice(0, 3);
  return `<div class="coming"><span>Next 10 mi</span>${mix.map((r) => `<b>${cropEmoji(r.code)} ${Math.round(r.share * 100)}%</b>`).join('')}</div>`;
}

function renderStripMessage(text, pending = true) {
  els.strip.hidden = false;
  els.strip.classList.add('single');
  els.strip.innerHTML = `<div class="side-cell${pending ? ' pending' : ''}"><div class="lbl"><span>Driving</span></div><div class="name"><span>${esc(text)}</span></div></div>`;
}
els.strip.addEventListener('click', () => {
  if (!state.lastDrive) return;
  if (state.sheet === 'drive') closeSheet(); else openDriveSheet();
});

function drawSideAreas(res, opts) {
  areaLayer.clearLayers();
  if (opts.heading == null) return;
  for (const side of ['left', 'right']) {
    L.polygon(sideArea(res.lat, res.lon, opts.heading, side, res.lead), {
      color: '#ffffff', weight: 1.5, opacity: 0.7, dashArray: '4 5', fill: false, interactive: false,
    }).addTo(areaLayer);
  }
}

// ---------- crop progress (via the proxy) ----------

const PROGRESS_CODES = new Set([1, 5, 2, 3, 4, 21, 28, 24, 23, 22, 6, 10, 41, 31, 42]);
const progressCache = new Map();

function progressSlot(lat, lon, code) {
  if (!proxyUrl || !PROGRESS_CODES.has(code)) return '';
  return `<div class="progress" data-lat="${lat}" data-lon="${lon}" data-crop="${code}"></div>`;
}

function getProgress(lat, lon, code) {
  const key = `${code}:${(+lat).toFixed(0)}:${(+lon).toFixed(0)}`;
  let p = progressCache.get(key);
  if (!p) {
    p = fetch(`${proxyUrl}/progress?lat=${lat}&lon=${lon}&crop=${code}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    progressCache.set(key, p);
  }
  return p;
}

async function fillProgress() {
  for (const el of els.sheetBody.querySelectorAll('.progress:not([data-done])')) {
    el.dataset.done = '1';
    const { lat, lon, crop: code } = el.dataset;
    const data = await getProgress(lat, lon, code);
    if (!data || !el.isConnected) continue;
    const prev = Object.fromEntries((data.progress.prev || []).map((r) => [r.what, r.pct]));
    const rows = data.progress.now.map((r) => {
      const delta = prev[r.what] != null && r.pct !== prev[r.what] ? ` <em>${r.pct - prev[r.what] > 0 ? '+' : ''}${r.pct - prev[r.what]}</em>` : '';
      return `<div class="prow"><span>${esc(r.what)}</span><i><b style="width:${Math.max(0, Math.min(100, r.pct))}%"></b></i><span>${r.pct}%${delta}</span></div>`;
    });
    const cond = data.condition.now;
    const ge = cond.filter((r) => r.what === 'good' || r.what === 'excellent').reduce((s, r) => s + r.pct, 0);
    const week = data.progress.week || data.condition.week;
    el.innerHTML = `<div class="ptitle">${esc(data.state)} ${esc(data.commodity)} this week${week ? ` <span>(USDA, week ending ${esc(new Date(week + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))})</span>` : ''}</div>
      ${rows.join('')}${cond.length ? `<div class="pcond">Condition: <b>${ge}% good–excellent</b></div>` : ''}`;
  }
}

// ---------- detail sheet ----------

// "Corn ↔ Soybeans rotation", "Alfalfa every year", ...
function rotationSummary(history) {
  const c = history.map((h) => h.code).filter((x) => x != null);
  if (c.length < 2) return '';
  const kinds = [...new Set(c)];
  if (kinds.length === 1) return `${prettyName(kinds[0])} every year`;
  if (kinds.length === 2 && c.every((v, i) => i === 0 || v !== c[i - 1])) return `${prettyName(c.at(-1))} ↔ ${prettyName(c.at(-2))} rotation`;
  return `${kinds.length} different crops in ${c.length} years`;
}

function detail(sideKey, s, layers, { stats = [], lat, lon, field = null } = {}) {
  const liveLabel = layers.live?.label;
  const outside = s.code == null && !s.live && s.history.every((h) => h.code == null);
  const name = s.code != null ? prettyName(s.code) : outside ? 'Not mapped' : 'No data here';
  const badges = [];
  let extra = '';

  switch (s.tier) {
    case 'live':
      badges.push(`<span class="badge live">Live · ${liveLabel}</span>`);
      if (s.agrees) badges.push('<span class="badge agree">Matches past years</span>');
      break;
    case 'live-changed':
      badges.push(`<span class="badge live">Live · ${liveLabel}</span>`);
      badges.push(`<span class="badge changed">Was ${esc(prettyName(s.prediction.code))}</span>`);
      extra = `<p class="predict">New this year. The satellite map shows a change from ${esc(prettyName(s.prediction.code))}. It may have been replanted, or it may be a misread.</p>`;
      break;
    case 'live-mixed':
      badges.push(`<span class="badge mixed">Mixed · ${liveLabel}</span>`);
      break;
    case 'live-cover':
      badges.push(`<span class="badge soft">${liveLabel} satellite</span>`);
      break;
    default: {
      if (outside) {
        extra = '<p class="predict">Crop maps cover the lower 48 states only. Hawaii, Alaska, open water, Canada and Mexico aren\'t included.</p>';
        break;
      }
      const y = s.history.filter((h) => h.code != null).at(-1)?.year ?? layers.years[0];
      badges.push(`<span class="badge annual">USDA ${y} map</span>`);
      if (s.prediction) {
        const word = { high: 'Likely', medium: 'Probably', low: 'Possibly' }[s.prediction.strength];
        badges.push(`<span class="badge soft">${word} this year</span>`);
        extra = `<p class="predict">${esc(s.prediction.why)}. The live map has no clear reading here.</p>`;
      }
    }
  }

  const runner = s.tier === 'live-mixed' && s.live?.runner && s.live.runner.share > 0.15
    ? `<div class="runner">and <b>${esc(prettyName(s.live.runner.code))}</b></div>` : '';
  const note = NOTES[s.code] && s.tier !== 'live-cover' ? `<p class="note">${esc(NOTES[s.code])}</p>` : '';
  const factsHtml = stats.length ? `<div class="stats">${stats.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>` : '';

  // Crop history: one tile per season, this season last (live reading, or the prediction).
  const nowYear = layers.live?.year ?? (layers.years[0] + 1);
  const nowCode = s.live ? s.live.code : s.prediction?.code ?? null;
  // USDA field outlines carry the field's own record (up to 8 years); otherwise use the map history.
  let record = s.history;
  if (field?.history?.length) {
    const last = field.history.at(-1).year;
    record = [...field.history, ...s.history.filter((h) => h.year > last)].filter((h) => h.year < nowYear);
  }
  const seasons = [
    ...record.slice(-5).map((h) => ({ year: h.year, code: h.code, kind: '' })),
    { year: nowYear, code: nowCode, kind: s.live ? 'now live' : 'now guess' },
  ];
  const tiles = seasons.map((x) => `<div class="season ${x.kind}" style="--c:${cropColor(x.code)}" title="${x.year}: ${x.code != null ? esc(prettyName(x.code)) : 'no data'}">
      <span class="yr">${x.kind ? (s.live ? 'Now' : 'Next?') : `’${String(x.year).slice(2)}`}</span>
      <b>${x.code != null ? cropEmoji(x.code) || '•' : '–'}</b>
      <span class="nm">${x.code != null ? esc(shortName(x.code)) : 'No data'}</span></div>`).join('');
  const rot = rotationSummary(record);
  if (field?.src === 'usda') badges.push(`<span class="badge soft">USDA field · ${record.length} yr record</span>`);

  return `<article class="detail">
      <div class="lbl">${SIDE_NAME[sideKey]}</div>
      <div class="crop"><span class="big-emo" style="--c:${cropColor(s.code)}">${s.code != null ? cropEmoji(s.code) || '•' : '?'}</span><span class="crop-name">${esc(name)}</span></div>
      ${runner}
      <div class="badges">${badges.join('')}</div>
      ${factsHtml}${extra}${note}
      <div class="seasons-head"><span>Crop history</span>${rot ? `<span>${esc(rot)}</span>` : ''}</div>
      <div class="seasons">${tiles}</div>
      ${lat != null && s.code != null ? progressSlot(lat, lon, s.code) : ''}
    </article>`;
}

function showSheet(kind, html, two = false) {
  state.sheet = kind;
  // Only a farm-region card keeps its pill wiggling; anything else stops it.
  if (kind !== 'belt') belts?.setActive(null);
  els.sheetBody.className = `sheet-body${two ? ' two' : ''}`;
  els.sheetBody.innerHTML = html;
  els.sheet.hidden = false;
  document.body.classList.add('sheet-open');
  fields.relabel();
  fillProgress();
}

function openDriveSheet() {
  const { res } = state.lastDrive;
  const keys = Object.keys(res.sides);
  showSheet('drive', keys.map((k) => detail(k, res.sides[k], res.layers, { lat: res.lat, lon: res.lon })).join(''), keys.length === 2);
}

function closeSheet() {
  if (!state.sheet) return;
  const wasTap = state.sheet === 'tap';
  state.sheet = null;
  state.tapSeq++;
  els.sheet.hidden = true;
  document.body.classList.remove('sheet-open');
  if (tapPin) { map.removeLayer(tapPin); tapPin = null; }
  routeLayer.clearLayers();
  parcelLayer.clearLayers();
  fields.select(null);
  fields.relabel();
  belts?.setActive(null);
  if (wasTap && state.mode === 'drive' && state.fix) { state.following = true; els.recenter.hidden = true; follow(true); }
}
els.sheetClose.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ---------- road-trip bingo ----------

async function openBingo() {
  showSheet('bingo', '<article class="detail"><div class="lbl">Road-trip bingo</div><p class="predict">Dealing today\'s card…</p></article>');
  const c = map.getCenter();
  const place = await placeName(state.fix?.lat ?? c.lat, state.fix?.lon ?? c.lng).catch(() => null);
  const card = await bingoCard(place?.st);
  if (state.sheet !== 'bingo') return;
  showSheet('bingo', `<article class="detail"><div class="lbl">🎯 Road-trip bingo</div>${bingoHtml(card)}
    <div class="sheet-actions"><button class="primary" data-act="sharebingo">✨ Share my card</button><button class="ghost" data-act="menu">Back</button></div></article>`);
}

// ---------- guess the crop ----------

let guess = null, streak = 0;
async function openGuess() {
  showSheet('guess', `<article class="detail"><div class="lbl">🧩 Guess the crop</div>
    <div class="sat sat-loading"><span>🛰️ Finding a field…</span></div></article>`);
  try {
    guess = await guessRound(map.getZoom() >= 9 ? map.getCenter() : null);
  } catch (err) {
    if (state.sheet === 'guess') showSheet('guess', `<article class="detail"><div class="lbl">🧩 Guess the crop</div><p class="err">${esc(err.message)}</p><div class="sheet-actions"><button class="primary" data-act="guess">Try again</button><button class="ghost" data-act="menu">Back</button></div></article>`);
    return;
  }
  if (state.sheet !== 'guess') return;
  showSheet('guess', `<article class="detail"><div class="lbl">🧩 Guess the crop</div>
    <div class="guess-score"><span>🔥 Streak <b>${streak}</b></span><span>🏆 Best <b>${stats.guessBest}</b></span></div>
    ${satelliteHtml(guess.lat, guess.lon)}
    <p class="predict">What's growing in the circle?</p>
    <div class="choices">${guess.choices.map((c) => `<button data-act="guessed" data-code="${c}" style="--c:${cropColor(c)}"><span>${cropEmoji(c)}</span>${esc(prettyName(c))}</button>`).join('')}</div>
  </article>`);
}

function answerGuess(code, btn) {
  if (!guess || guess.done) return;
  guess.done = true;
  const right = code === guess.code;
  streak = right ? streak + 1 : 0;
  if (right) { stats.guessRight++; stats.guessBest = Math.max(stats.guessBest, streak); }
  saveStats();
  fx(right ? 'right' : 'wrong');
  btn.parentElement.querySelectorAll('button').forEach((x) => {
    x.disabled = true;
    if (+x.dataset.code === guess.code) x.classList.add('right');
    else if (x === btn) x.classList.add('wrong');
  });
  const blurb = cropBlurb(guess.code);
  btn.closest('.detail').insertAdjacentHTML('beforeend', `<div class="guess-result ${right ? 'yes' : 'no'}">
      <b>${right ? (streak >= 3 ? `🔥 ${streak} in a row!` : '✅ Nailed it!') : `❌ It's ${cropEmoji(guess.code)} ${esc(prettyName(guess.code))}`}</b>
      ${blurb ? `<p>${esc(blurb)}</p>` : ''}</div>
    <div class="sheet-actions"><button class="primary" data-act="guess">Next field ▶</button><button class="ghost" data-act="zoomto" data-lat="${guess.lat}" data-lng="${guess.lon}" data-z="15">✈️ Go see it</button></div>`);
  if (right && [3, 5, 10].includes(streak)) kernel(`${streak} in a row! You really know your crops. 🧠`, { mood: 'excited' });
  rewardBadges();
}

// ---------- crop of the day ----------

async function openCropOfDay() {
  const code = cropOfTheDay(), r = rarityOf(code), have = state.album.cards[code];
  showSheet('cotd', `<article class="detail cotd" style="--c:${cropColor(code)}"><div class="lbl">⭐ Crop of the day</div>
    <div class="crop"><span class="big-emo" style="--c:${cropColor(code)}">${cropEmoji(code)}</span><span class="crop-name">${esc(prettyName(code))}</span></div>
    <div class="badges"><span class="badge soft" style="border-color:${r.color};color:${r.color}">${r.name}</span>
    <span class="badge ${have ? 'agree' : 'soft'}">${have ? '✓ In your album' : 'Not in your album yet'}</span></div>
    ${cropBlurb(code) ? `<p class="note">${esc(cropBlurb(code))}</p>` : ''}
    <div id="cotdFacts"><p class="predict">Looking it up…</p></div></article>`);
  const near = state.fix ? { lat: state.fix.lat, lng: state.fix.lon } : map.getZoom() >= 6 ? map.getCenter() : null;
  const f = await cropFacts(code, near);
  const el = $('cotdFacts');
  if (!el) return;
  const fmt = (a) => (a >= 1e6 ? `${(a / 1e6).toFixed(1)} million` : a >= 1e3 ? `${Math.round(a / 1e3).toLocaleString()} thousand` : String(a));
  el.innerHTML = `<div class="stats">
      ${f.total ? `<div><b>${fmt(f.total).replace(' million', 'M').replace(' thousand', 'k')}</b><span>acres in the U.S. this season</span></div>` : ''}
      ${f.topState ? `<div><b>${esc(f.topState)}</b><span>grows the most</span></div>` : ''}
    </div>
    ${f.nearest ? `<p class="predict">📍 ${near ? 'Closest big patch' : 'Biggest patch'}: <b>${esc(f.nearest.name)}</b>${f.nearest.miles != null ? `, about ${f.nearest.miles} miles away` : ''}.</p>
      <div class="sheet-actions"><button class="primary" data-act="zoomto" data-lat="${f.nearest.at[0]}" data-lng="${f.nearest.at[1]}" data-z="11">✈️ Go find it</button><button class="ghost" data-act="menu">Back</button></div>` : ''}`;
}

// ---------- famous farm regions ----------

function openBelt(b) {
  fx('pop');
  const c = CATEGORIES.find((x) => x.id === b.cat);
  const f = nextFact(b);
  belts.setActive(b.id);   // its pill wiggles while the card is open
  showSheet('belt', `<article class="detail belt-sheet" style="--c:${c.color}">
    <div class="lbl">Famous farm region</div>
    <div class="crop"><span class="big-emo" style="--c:${c.color}">${b.emoji}</span><span class="crop-name">${esc(b.name)}</span></div>
    <div class="belt-sub">📍 ${esc(b.sub)}</div>
    <p class="belt-fact" id="beltFact">${esc(f.text)}</p>
    <div class="fact-row"><span id="factCount">Fact ${f.n} of ${f.of}</span><button class="chip" data-act="morefact" data-id="${b.id}">🎲 Another fact</button></div>
    <div class="sheet-actions"><button class="primary" data-act="beltspot" data-code="${c.codes[0]}">🔦 Spotlight ${esc(c.name.toLowerCase())}</button><button class="ghost" data-act="zoomto" data-lat="${b.fly[0]}" data-lng="${b.fly[1]}" data-z="${b.fly[2]}">✈️ Fly there</button></div>
  </article>`);
}

// ---------- tapping a state or county ----------

function openRegion(level, p, at) {
  fx('pop');
  if (level === 'counties') countyFacts(p).then((facts) => {
    const el = $('countyFacts');
    if (el && facts.length) el.innerHTML = facts.map((f) => `<li>${f}</li>`).join('');
  });
  const t = topCrop(p);
  const planted = p.top.filter(([c]) => isPlanted(c));
  const max = planted[0]?.[1] || 1;
  const fmt = (a) => (a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : String(a));
  const name = level === 'states' ? p.name : `${countyName(p.name)}, ${p.st}`;
  const live = state.layers?.live?.label;
  showSheet('region', `<article class="detail">
    <div class="lbl">${level === 'states' ? 'State' : 'County'} · ${live ? `${esc(live)} live map` : 'USDA map'}</div>
    <div class="crop"><span class="big-emo" style="--c:${t?.cat?.color ?? '#3a414c'}">${t?.cat?.emoji ?? '🗺️'}</span><span class="crop-name">${esc(name)}</span></div>
    <div class="stats">
      <div><b>${fmt(p.crop)}</b><span>acres planted</span></div>
      <div><b>${Math.round(p.crop / p.area * 100)}%</b><span>of the land is cropland</span></div>
      ${t ? `<div><b>${Math.round(t.share * 100)}%</b><span>of it is ${esc((t.cat?.name ?? prettyName(t.code)).toLowerCase())}</span></div>` : ''}
    </div>
    <div class="tbars">${planted.slice(0, 6).map(([c, a]) => `<div class="tbar"><span class="emo-sm" style="--c:${cropColor(c)}">${cropEmoji(c)}</span>
      <span class="bname">${esc(prettyName(c))}</span><i><b style="width:${(a / max * 100).toFixed(1)}%;background:${cropColor(c)}"></b></i><span class="bval">${fmt(a)} ac</span></div>`).join('')}</div>
    ${level === 'counties' ? '<ul class="cfacts" id="countyFacts"></ul>' : ''}
    <div class="sheet-actions"><button class="primary" data-act="zoomto" data-lat="${at.lat}" data-lng="${at.lng}" data-z="${level === 'states' ? 7 : 12}">Zoom in</button><button class="ghost" data-act="close">Close</button></div>
  </article>`);
}

// ---------- parcels ----------

async function showParcel(lat, lon, btn) {
  const out = $('parcelOut');
  if (!out) return;
  btn.disabled = true;
  out.innerHTML = '<p class="predict">Looking up public property records…</p>';
  try {
    const place = await placeName(lat, lon);
    const r = await parcelAt(lat, lon, place?.st);
    if (r.unsupported) {
      out.innerHTML = `<p class="predict">${esc(place?.state || 'This state')} doesn't publish its property records statewide for free yet. Covered now: WI, NC, AR, FL, CO, VT, CT with owners; OH, IN, ND, CA, UT, NJ with parcel lines.</p>`;
      return;
    }
    if (r.none) { out.innerHTML = '<p class="predict">No parcel found right here.</p>'; return; }
    const i = r.info;
    parcelLayer.clearLayers();
    L.geoJSON(r.geojson, { style: { color: '#fff', weight: 3, dashArray: '6 6', fill: false }, interactive: false }).addTo(parcelLayer);
    out.innerHTML = `<div class="parcel">
      <div class="lbl">Land parcel · public record</div>
      ${i.owner ? `<div class="owner">${esc(i.owner)}</div>` : '<div class="owner muted">Owner not published in this state</div>'}
      <div class="pfacts">${i.acres ? `<span><b>${i.acres.toLocaleString()}</b> acres</span>` : ''}${i.id ? `<span>Parcel <b>${esc(i.id)}</b></span>` : ''}${i.use ? `<span>${esc(i.use)}</span>` : ''}${place ? `<span>${esc(place.short)}</span>` : ''}</div>
    </div>`;
  } catch {
    out.innerHTML = '<p class="err">Couldn\'t reach the property records right now.</p>';
  } finally {
    btn.disabled = false;
  }
}

// ---------- share cards ----------

async function openShareCard() {
  const info = state.shareInfo;
  if (!info) return;
  showSheet('share', '<article class="detail"><div class="lbl">Share</div><p class="predict">Making your card…</p></article>');
  info.place = await placeName(info.lat, info.lon);
  const cv = await fieldCard(info);
  state.shareCanvas = cv;
  state.shareText = `${cropEmoji(info.code)} ${prettyName(info.code)}${info.acres ? `, ${info.acres} acres` : ''}${info.place ? ` in ${info.place.county}, ${info.place.state}` : ''}. Spotted with FieldSight.`;
  if (state.sheet !== 'share') return;
  showSheet('share', `<article class="detail"><div class="lbl">Share this field</div>
    <img class="card-preview" src="${cv.toDataURL('image/png')}" alt="Share card">
    <div class="sheet-actions"><button class="primary" data-act="sharego">Share</button><button class="ghost" data-act="close">Close</button></div></article>`);
}

// ---------- tapping the map ----------

const pinIcon = L.divIcon({ className: 'tap-pin', iconSize: [16, 16], iconAnchor: [8, 8] });

async function onMapTap(lat, lon) {
  if (state.mode === 'idle') enterExplore(null, true);
  const field = fields.fieldAt(lat, lon);
  if (field) { fx('pop'); stats.fieldsTapped++; saveStats(); rewardBadges(); }
  // Tapping outside any field while a panel is open just closes it.
  if (state.sheet && !field) return closeSheet();

  const seq = ++state.tapSeq;
  routeLayer.clearLayers();
  fields.select(field ? field.id : null, [lat, lon]);
  if (tapPin) tapPin.setLatLng([lat, lon]);
  else tapPin = L.marker([lat, lon], { icon: pinIcon, interactive: false }).addTo(map);

  showSheet('tap', `<article class="detail"><div class="lbl">This spot</div>
    <div class="crop"><span class="big-emo" style="--c:${cropColor(field?.code)}">${field ? cropEmoji(field.code) : '…'}</span>
    <span class="crop-name loading-name">${field ? esc(prettyName(field.code)) : 'Looking…'}</span></div></article>`);

  try {
    const res = await lookup(lat, lon, { tapped: true });
    if (seq !== state.tapSeq) return;
    const sp = res.sides.point;
    showSheet('tap', detail('point', sp, res.layers, { stats: fieldStats(field, sp), lat, lon, field })
      + `<div class="sheet-actions">${sp.code != null && isAg(sp.code) ? '<button class="primary share-btn" data-act="share">✨ Share</button>' : ''}<button class="ghost" data-act="parcel" data-lat="${lat}" data-lng="${lon}">🏠 Parcel & owner</button></div><div id="parcelOut"></div>`);
    // Everything the share card needs.
    const nowYear = res.layers.live?.year ?? res.layers.years[0] + 1;
    const hist = field?.history?.length
      ? [...field.history, ...sp.history.filter((h) => h.year > field.history.at(-1).year)] : sp.history;
    state.shareInfo = {
      code: sp.code, tier: sp.tier, liveLabel: res.layers.live?.label, nowYear, lat, lon,
      history: hist.filter((h) => h.code != null && h.year < nowYear),
      acres: field?.acres, football: field ? Math.round(field.acres / 1.32) : null,
      yieldText: fieldStats(field, sp)[2]?.slice(0, 2).join(' ').replace(' at a typical yield', '') || null,
      rings: field ? fields.fieldRings(field.id) : null,
    };
  } catch (err) {
    if (seq !== state.tapSeq) return;
    showSheet('tap', `<article class="detail"><div class="lbl">This spot</div><p class="err">${esc(err.message)}. Try again in a moment.</p></article>`);
  }
}

// The numbers callout for a tapped field: size, and a rough "what's in it" at a typical yield.
function fieldStats(field, s) {
  if (!field) return [];
  const out = [[field.acres.toLocaleString(), field.acres === 1 ? 'acre' : 'acres']];
  // An American football field with end zones is about 1.32 acres.
  out.push([`≈${Math.max(1, Math.round(field.acres / 1.32)).toLocaleString()}`, 'football fields']);
  const y = TYPICAL_YIELD[s.code];
  if (y && isAg(s.code)) {
    const total = y[0] * field.acres;
    const v = total >= 1e6 ? `${(total / 1e6).toFixed(1)}M` : total >= 1e4 ? `${Math.round(total / 1e3)}k` : Math.round(total).toLocaleString();
    out.push([`≈${v}`, `${y[1]} at a typical yield`]);
  }
  return out;
}

// ---------- trip log ----------

function loadTrip() {
  try {
    const t = JSON.parse(localStorage.getItem('fs.trip') || 'null');
    if (t && t.m) return t;
  } catch { /* ignore */ }
  return { started: Date.now(), total: 0, m: {}, last: null };
}
function saveTrip() { localSet('fs.trip', JSON.stringify(state.trip)); }

// Roadside distance past each crop: each lookup credits the distance since the last one,
// split between the sides.
function logTrip(res) {
  const t = state.trip, here = { lat: res.lat, lon: res.lon };
  if (t.last) {
    const d = distM(t.last, here);
    if (d < 1500) {
      const sides = Object.values(res.sides);
      for (const s of sides) {
        const k = s.code ?? 'none';
        t.m[k] = (t.m[k] || 0) + d / sides.length;
        if (s.code != null) addMiles(s.code, d / sides.length);
      }
      t.total += d;
      stats.totalMiles += d / 1609.34;
      saveStats();
    }
  }
  t.last = here;
  saveTrip();
}

const miles = (m) => (m / 1609.34 < 10 ? (m / 1609.34).toFixed(1) : Math.round(m / 1609.34).toLocaleString());

// Crop bingo: every different crop seen along the way.
function spotted(rows) {
  const crops = rows.filter((r) => r.code != null && isAg(r.code));
  if (!crops.length) return '';
  return `<div class="spotted-head"><span>Crops spotted</span><span>${crops.length} so far</span></div>
    <div class="spotted">${crops.map((r) => `<span style="--c:${cropColor(r.code)}" title="${esc(prettyName(r.code))}">${cropEmoji(r.code)}<i>${esc(prettyName(r.code))}</i></span>`).join('')}</div>`;
}

function openTrip() {
  const t = state.trip;
  // Merge classes that share a display name (e.g. the developed-land intensities).
  const byName = new Map();
  for (const [k, m] of Object.entries(t.m)) {
    const code = k === 'none' ? null : +k;
    const name = code == null ? 'No data' : isAg(code) ? prettyName(code) : shortName(code);
    const r = byName.get(name) || { code, m: 0 };
    r.m += m;
    byName.set(name, r);
  }
  const rows = [...byName.values()].sort((a, b) => b.m - a.m);
  const farm = rows.filter((r) => r.code != null && isAg(r.code)).reduce((s, r) => s + r.m, 0);
  const top = rows.slice(0, 10);
  const maxM = top[0]?.m || 1;
  const started = new Date(t.started).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const body = t.total < 50
    ? '<p class="predict">Nothing logged yet. Start driving and the crops along your route add up here.</p>'
    : `<div class="trip-sum"><div><b>${miles(t.total)}</b><span>miles driven</span></div><div><b>${Math.round(farm / t.total * 100)}%</b><span>farmland roadside</span></div></div>
       <div class="tbars">${top.map((r) => `<div class="tbar"><span class="swatch" style="background:${r.code != null ? cropColor(r.code) : 'var(--line)'}"></span>
         <span class="bname">${esc(r.code != null ? prettyName(r.code) : 'No data')}</span><i><b style="width:${(r.m / maxM * 100).toFixed(1)}%;background:${r.code != null ? cropColor(r.code) : 'var(--line)'}"></b></i><span class="bval">${miles(r.m)} mi</span></div>`).join('')}</div>`;
  showSheet('trip', `<article class="detail"><div class="lbl">Trip log · since ${esc(started)}</div>
    <div class="crop"><span class="crop-name">${t.total < 50 ? 'No miles yet' : `Mostly ${esc(rows.find((r) => r.code != null && isAg(r.code)) ? prettyName(rows.find((r) => r.code != null && isAg(r.code)).code) : 'non-farm')}`}</span></div>
    ${body}
    ${spotted(rows)}
    <div class="sheet-actions"><button class="ghost" data-act="newtrip">Start a new trip</button><button class="ghost" data-act="menu">Back</button></div></article>`);
}

// ---------- menu, offline routes ----------

function openMenu() {
  const routes = loadRoutes();
  const t = state.trip;
  showSheet('menu', `<nav class="menu">
    <button data-act="cotd"><b>⭐ Crop of the day</b><span>Today: ${cropEmoji(cropOfTheDay())} ${esc(prettyName(cropOfTheDay()))}</span></button>
    <button data-act="bingo"><b>🎯 Road-trip bingo</b><span>Today's card · spot 3 in a row</span></button>
    <button data-act="guess"><b>🧩 Guess the crop</b><span>Bird's-eye photo quiz${stats.guessBest ? ` · best streak ${stats.guessBest}` : ''}</span></button>
    <button data-act="album"><b>🃏 Crop Cards & badges</b><span>${albumSummary(state.album).got} cards · ${albumSummary(state.album).states} state stamps</span></button>
    <button data-act="trip"><b>Trip log</b><span>${t.total >= 50 ? `${miles(t.total)} mi so far` : 'Miles of each crop along your drive'}</span></button>
    <button data-act="offline"><b>🧭 Plan a drive</b><span>What you'll pass on the way · save for offline</span></button>
    <button data-act="routes"><b>Saved routes</b><span>${routes.length ? `${routes.length} saved` : 'None yet'}</span></button>
    <button data-act="about"><b>About the data</b><span>Where each reading comes from</span></button>
    <div class="toggles">
      <button data-act="tog" data-k="sound" class="${settings.sound ? 'on' : ''}">🔊 Sounds</button>
      <button data-act="tog" data-k="buzz" class="${settings.buzz ? 'on' : ''}">📳 Buzz</button>
      <button data-act="tog" data-k="mascot" class="${settings.mascot ? 'on' : ''}">🌽 Kernel</button>
    </div>
  </nav>`);
}
els.menuBtn.addEventListener('click', () => (state.sheet === 'menu' ? closeSheet() : openMenu()));

let downloadCtl = null;

// Plan a drive: route → forecast of what you'll pass (ribbon + totals) → start it, or save it offline.
function openOffline(prefillTo = '') {
  showSheet('offline', `<article class="detail"><div class="lbl">Plan a drive</div>
    <p class="predict">See what you'll drive past, then start the drive or save it for no-signal stretches. On Android you can also share a place from Google Maps to FieldSight.</p>
    <form class="route-form" id="routeForm">
      <label>From<input name="from" placeholder="Current location" autocomplete="off"></label>
      <label>To<input name="to" placeholder="City, town or address" required autocomplete="off" value="${esc(prefillTo)}"></label>
      <button class="primary" type="submit">Find route</button>
    </form>
    <div id="routePlan"></div></article>`);
  $('routeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target), out = $('routePlan');
    out.innerHTML = '<p class="predict">Finding the route…</p>';
    try {
      const here = state.fix ? { lat: state.fix.lat, lon: state.fix.lon } : await new Promise((r) => {
        if (!navigator.geolocation) return r(null);
        navigator.geolocation.getCurrentPosition((p) => r({ lat: p.coords.latitude, lon: p.coords.longitude }), () => r(null), { timeout: 8000 });
      });
      const plan = await planRoute(fd.get('from').trim(), fd.get('to').trim(), here);
      routeLayer.clearLayers();
      const line = L.polyline(plan.coords, { color: '#ffffff', weight: 5, opacity: 0.9 }).addTo(routeLayer);
      map.fitBounds(line.getBounds(), { paddingTopLeft: [20, 90], paddingBottomRight: [20, 360] });
      out.innerHTML = `<div class="plan"><b>${esc(plan.from.name)} → ${esc(plan.to.name)}</b>
        <span>${Math.round(plan.miles)} mi · ${Math.floor(plan.minutes / 60)} h ${Math.round(plan.minutes % 60)} min</span></div>
        <div id="forecast"><div class="dl"><i><b id="fcBar"></b></i><span id="fcText">Reading the fields along the way…</span></div></div>
        <div class="sheet-actions"><button class="primary" id="goBtn">▶ Start this drive</button><button class="ghost" id="dlBtn">⬇ Save offline</button></div>
        <div id="dlOut"></div>`;
      // Forecast.
      downloadCtl = new AbortController();
      const scanSignal = downloadCtl.signal;
      scanRoute(plan.coords, (done, total, stops) => {
        const bar = $('fcBar'), txt = $('fcText');
        if (bar) bar.style.width = `${(done / total * 100).toFixed(0)}%`;
        if (txt) txt.textContent = `Reading the fields along the way… ${Math.round(done / total * 100)}%`;
        if (done % 20 === 0 || done === total) paintRibbon(stops.filter(Boolean), plan);
      }, scanSignal).then((scan) => {
        plan.scan = scan;
        state.plan = plan;
        paintRibbon(scan.stops, plan, true);
      });
      $('goBtn').addEventListener('click', () => {
        state.route = { coords: plan.coords, plan };
        closeSheet();
        driveRouteLayer.clearLayers();
        L.polyline(plan.coords, { color: '#ffffff', weight: 6, opacity: 0.35, interactive: false }).addTo(driveRouteLayer);
        if (state.mode !== 'drive') startDriving();
        toast('🧭 Route set. Watch the top bar for what\'s coming up.');
      });
      $('dlBtn').addEventListener('click', async () => {
        const dlOut = $('dlOut');
        const ctl = new AbortController();
        dlOut.innerHTML = '<div class="dl"><i><b id="dlBar"></b></i><span id="dlText">Starting…</span><button class="chip warn" id="dlCancel">Cancel</button></div>';
        $('dlCancel').addEventListener('click', () => ctl.abort());
        try {
          const rec = await downloadRoute(plan, (done, total) => {
            const bar = $('dlBar'), txt = $('dlText');
            if (bar) bar.style.width = `${(done / total * 100).toFixed(1)}%`;
            if (txt) txt.textContent = `${done.toLocaleString()} of ${total.toLocaleString()} map pieces (about ${plan.mb < 1 ? '<1' : Math.round(plan.mb)} MB)`;
          }, ctl.signal);
          if (!dlOut.isConnected) toast('⬇ Route saved for offline');
          dlOut.innerHTML = `<p class="note"><b>Saved.</b> Left/right readings will work along this route with no signal${rec.failed ? ` (${rec.failed} pieces couldn't be downloaded)` : ''}.</p>`;
        } catch (err) {
          dlOut.innerHTML = err.name === 'AbortError' ? '<p class="predict">Cancelled. Pieces already downloaded stay saved.</p>' : `<p class="err">${esc(err.message)}</p>`;
        }
      });
    } catch (err) {
      out.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    }
  });
}

// The forecast: totals plus a ribbon per side showing what you pass, start to finish.
function paintRibbon(stops, plan, final = false) {
  const el = $('forecast');
  if (!el || !stops.length) return;
  const sum = summarize(stops).filter((r) => r.code != null).slice(0, 5);
  const seg = (side) => stops.map((s) => `<i style="background:${s[side] != null && isAg(s[side]) ? cropColor(s[side]) : '#2b3038'}"></i>`).join('');
  el.innerHTML = `${final ? '' : '<div class="dl"><i><b style="width:100%;opacity:.4"></b></i></div>'}
    <div class="fc-chips">${sum.map((r) => `<span style="--c:${cropColor(r.code)}"><b>${cropEmoji(r.code)}</b>${esc(prettyName(r.code))} <em>${Math.round(r.share * 100)}%</em></span>`).join('')}</div>
    <div class="ribbon"><span>L</span><div>${seg('left')}</div></div>
    <div class="ribbon"><span>R</span><div>${seg('right')}</div></div>
    <div class="ribbon-axis"><span>Start</span><span>${Math.round(plan.miles / 2)} mi</span><span>${Math.round(plan.miles)} mi</span></div>`;
}

function openRoutes() {
  const routes = loadRoutes();
  showSheet('routes', `<article class="detail"><div class="lbl">Saved routes</div>
    ${routes.length ? `<div class="routes">${routes.map((r) => `<div class="route">
      <div><b>${esc(r.name)}</b><span>${r.miles} mi · saved ${esc(new Date(r.saved).toLocaleDateString())}</span></div>
      <button class="chip" data-act="showroute" data-id="${r.id}">Show</button>
      <button class="chip warn" data-act="delroute" data-id="${r.id}">Delete</button></div>`).join('')}</div>`
    : '<p class="predict">No saved routes yet.</p>'}
    <div class="sheet-actions"><button class="ghost" data-act="offline">Save a route</button><button class="ghost" data-act="menu">Back</button></div></article>`);
}

els.sheetBody.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'trip') openTrip();
  else if (act === 'tog') {
    settings.set(b.dataset.k, !settings[b.dataset.k]);
    b.classList.toggle('on', settings[b.dataset.k]);
    if (settings[b.dataset.k]) { fx('pop'); if (b.dataset.k === 'mascot') kernel('Hi again! 👋'); }
  }
  else if (act === 'bingo') openBingo();
  else if (act === 'guess') openGuess();
  else if (act === 'guessed') answerGuess(+b.dataset.code, b);
  else if (act === 'cotd') openCropOfDay();
  else if (act === 'album') openAlbum();
  else if (act === 'sharealbum') {
    const cv = await albumCard(state.album);
    const sum = albumSummary(state.album);
    await shareCanvas(cv, { title: 'My FieldSight album', text: `I've collected ${sum.got} crop cards and ${sum.states} state stamps on FieldSight! 🌽🫘🌾`, filename: 'fieldsight-album.png' });
  }
  else if (act === 'menu') openMenu();
  else if (act === 'offline') openOffline();
  else if (act === 'routes') openRoutes();
  else if (act === 'about') { closeSheet(); els.about.showModal(); }
  else if (act === 'close') closeSheet();
  else if (act === 'sharebingo') {
    const t = `🎯 My FieldSight road-trip bingo card today. Can you spot them all? 🌽🫘🌾`;
    if (navigator.share) navigator.share({ title: 'FieldSight bingo', text: t, url: location.origin + location.pathname }).catch(() => {});
    else { navigator.clipboard?.writeText(`${t} ${location.origin}${location.pathname}`); toast('Copied to clipboard'); }
  }
  else if (act === 'beltspot') { closeSheet(); spotlight(+b.dataset.code); }
  else if (act === 'morefact') {
    const belt = BELTS.find((x) => x.id === b.dataset.id), f = nextFact(belt), el = $('beltFact');
    el.classList.remove('flip'); void el.offsetWidth; el.classList.add('flip');
    el.textContent = f.text;
    fx('flip');
    $('factCount').textContent = `Fact ${f.n} of ${f.of}`;
  }
  else if (act === 'share') openShareCard();
  else if (act === 'parcel') showParcel(+b.dataset.lat, +b.dataset.lng, b);
  else if (act === 'sharego') {
    const r = await shareCanvas(state.shareCanvas, { title: 'FieldSight', text: state.shareText, filename: 'fieldsight.png' });
    if (r === 'downloaded') b.textContent = 'Saved to your downloads ✓';
  }
  else if (act === 'zoomto') { closeSheet(); map.setView([+b.dataset.lat, +b.dataset.lng], +b.dataset.z); }
  else if (act === 'newtrip') { state.trip = { started: Date.now(), total: 0, m: {}, last: null }; saveTrip(); openTrip(); }
  else if (act === 'showroute') {
    const r = loadRoutes().find((x) => x.id === b.dataset.id);
    if (!r) return;
    routeLayer.clearLayers();
    const line = L.polyline(r.line, { color: '#e8c170', weight: 4, opacity: 0.9 }).addTo(routeLayer);
    map.fitBounds(line.getBounds(), { paddingTopLeft: [20, 90], paddingBottomRight: [20, 320] });
  } else if (act === 'delroute') {
    await deleteRoute(b.dataset.id);
    routeLayer.clearLayers();
    openRoutes();
  }
});

// ---------- voice ----------

function speak(text) {
  if (!state.voice || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// Only speak crops and pasture, and only when a side changes. Not every farmstead or tree line.
function announce(res) {
  const parts = [];
  for (const [side, s] of Object.entries(res.sides)) {
    if (s.code == null || !isAg(s.code)) continue;
    const name = prettyName(s.code);
    if (state.lastSpoken[side] === name) continue;
    state.lastSpoken[side] = name;
    parts.push(`${SIDE_NAME[side]}: ${name}${s.tier === 'annual' ? ', probably' : ''}.`);
  }
  if (parts.length) speak(parts.join(' '));
}

function setVoice(on) {
  state.voice = on;
  localSet('fs.voice', on ? '1' : '0');
  els.voiceBtn.setAttribute('aria-pressed', String(on));
  if (on) { state.lastSpoken = {}; speak('Voice on.'); }
  else if ('speechSynthesis' in window) speechSynthesis.cancel();
}
els.voiceBtn.addEventListener('click', () => setVoice(!state.voice));
els.voiceBtn.setAttribute('aria-pressed', String(state.voice));

// ---------- modes ----------

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.mode === 'drive' && (!wakeLock || wakeLock.released)) keepAwake();
});

function leaveWelcome() {
  els.welcome.hidden = true;
  document.body.classList.remove('welcoming');
}

function startDriving() {
  state.mode = 'drive';
  const hr = new Date().getHours();
  if (hr >= 21) stats.nightDrive = true;
  if (hr < 6) stats.earlyDrive = true;
  saveStats();
  seasons?.update();
  document.body.classList.add('driving');
  leaveWelcome();
  keepAwake();
  renderStripMessage('Finding GPS…');
  setStatus('Finding GPS…', 'busy');
  state.trip.last = null;   // don't count the gap since the last drive

  if (new URLSearchParams(location.search).has('sim')) return simulate();
  if (!('geolocation' in navigator)) return renderStripMessage('This browser has no GPS access', false);
  navigator.geolocation.watchPosition(
    (p) => onFix({
      lat: p.coords.latitude, lon: p.coords.longitude, t: p.timestamp,
      speed: p.coords.speed, heading: p.coords.heading, acc: p.coords.accuracy,
    }),
    (err) => {
      setStatus(err.code === 1 ? 'Location blocked' : 'No GPS signal', 'err');
      if (err.code === 1) renderStripMessage('Location is off for this site. Allow it in settings, or tap the map.', false);
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
  );
}

// center: jump there. stay: keep the current view (the user just tapped the map).
function enterExplore(center, stay = false) {
  state.mode = 'explore';
  leaveWelcome();
  if (center) return map.setView(center, 15);
  if (stay) return;
  if (map.getZoom() < 8) map.setView([42.05, -93.7], 14);
  navigator.geolocation?.getCurrentPosition((p) => map.setView([p.coords.latitude, p.coords.longitude], 15), () => {}, { timeout: 8000 });
}

// Drive a fixed Iowa route for testing without a car (?sim).
function simulate() {
  const route = [[42.0500, -93.8000], [42.0500, -93.7000], [42.0960, -93.7000], [42.0960, -93.6200]];
  const speed = 29; // m/s ≈ 65 mph
  let leg = 0, pos = { lat: route[0][0], lon: route[0][1] };
  setInterval(() => {
    let remain = speed;
    while (remain > 0 && leg < route.length - 1) {
      const to = { lat: route[leg + 1][0], lon: route[leg + 1][1] };
      const d = distM(pos, to);
      if (d <= remain) { pos = to; remain -= d; leg++; continue; }
      const f = remain / d;
      pos = { lat: pos.lat + (to.lat - pos.lat) * f, lon: pos.lon + (to.lon - pos.lon) * f };
      remain = 0;
    }
    if (leg >= route.length - 1) { leg = 0; pos = { lat: route[0][0], lon: route[0][1] }; }
    const next = route[Math.min(leg + 1, route.length - 1)];
    onFix({ lat: pos.lat, lon: pos.lon, t: Date.now(), speed, heading: bearing(pos, { lat: next[0], lon: next[1] }) });
  }, 1000);
}

document.body.classList.add('welcoming');
{
  // A different fun fact on the welcome card each visit.
  const f = randomFact();
  $('didYouKnow').innerHTML = `<b>${f.belt.emoji} Did you know?</b> ${esc(f.text)}`;
  const [, sn] = season(), cotd = cropOfTheDay();
  $('welcomeChips').innerHTML = `<button class="wchip" data-w="cotd">⭐ Crop of the day: ${cropEmoji(cotd)} ${esc(prettyName(cotd))}</button><span class="wchip plain">${sn.emoji} ${sn.name}</span>`;
  $('welcomeChips').addEventListener('click', (e) => { if (e.target.closest('[data-w=cotd]')) { enterExplore(null, true); openCropOfDay(); } });
  // Kernel says hi once a day.
  if (localGet('fs.kernelDay') !== new Date().toDateString()) {
    localSet('fs.kernelDay', new Date().toDateString());
    setTimeout(() => kernel(`Hi, I'm <b>Kernel</b>! 🌽 It's ${sn.name.toLowerCase()}. Tap a glowing region for fun facts, or try today's bingo in the ☰ menu.`, { ms: 8000 }), 1400);
  }
}
els.headBtn.setAttribute('aria-pressed', String(state.headingUp));
els.startBtn.addEventListener('click', startDriving);
els.exploreBtn.addEventListener('click', () => enterExplore());
els.about.addEventListener('click', (e) => { if (e.target === els.about) els.about.close(); });
window.addEventListener('online', () => state.mode === 'drive' && driveStatus(false));
window.addEventListener('offline', () => state.mode === 'drive' && driveStatus(false));

// ?debug exposes internals in the console.
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { fsMap: map, fsFields: fields, fsState: state });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// Shared from another app (Android share sheet → FieldSight, e.g. a place in Google Maps):
// open the planner with that place as the destination.
{
  const q = new URLSearchParams(location.search);
  const shared = [q.get('title'), q.get('text')].filter(Boolean).join('\n');
  if (shared) {
    const place = shared.split('\n').map((l) => l.trim()).find((l) => l && !/^https?:/.test(l)) || '';
    enterExplore(null, true);
    setTimeout(() => openOffline(place), 300);
  }
}

// Shareable spot: ?at=lat,lon opens the map there and inspects it.
const at = new URLSearchParams(location.search).get('at')?.split(',').map(Number);
if (at?.length === 2 && at.every(Number.isFinite)) {
  enterExplore(at);
  // Give the field outlines a moment to load so the tapped field is highlighted.
  setTimeout(() => onMapTap(at[0], at[1]), 1500);
}
