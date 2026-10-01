import {
  lookup, discoverLayers, prettyName, isAg, NOTES, sideArea, LIVE_WMS, ANNUAL_WMS,
  wakeProxy, proxyUrl,
} from './data.js';
import { FieldLayer, CropTiles, FIELD_MIN_ZOOM } from './fields.js';
import { RegionLayer, COUNTY_MAX_ZOOM, topCrop, isPlanted } from './regions.js';
import { cropColor, cropEmoji, shortName, TYPICAL_YIELD } from './palette.js';
import { planRoute, downloadRoute, loadRoutes, deleteRoute } from './offline.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), statusText: $('statusText'), strip: $('strip'), welcome: $('welcome'),
  startBtn: $('startBtn'), exploreBtn: $('exploreBtn'), voiceBtn: $('voiceBtn'), menuBtn: $('menuBtn'),
  about: $('about'), recenter: $('recenterBtn'), layerToggle: $('layerToggle'), baseBtn: $('baseBtn'),
  headBtn: $('headBtn'), legend: $('legend'), mapHint: $('mapHint'), sheet: $('sheet'), sheetBody: $('sheetBody'), sheetClose: $('sheetClose'),
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
  trip: loadTrip(),
};

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- map ----------

const map = L.map('map', {
  zoomControl: false, attributionControl: true, zoomSnap: 0.5,
  rotate: true, bearing: 0, touchRotate: false, shiftKeyRotate: false, rotateControl: false, compassBearing: false,
}).setView([39.5, -96.5], 5);
map.attributionControl.setPrefix(false);

// Fields and road labels turn with the map in heading-up mode; field name labels stay upright.
for (const [name, z] of [['fields', 350], ['labels', 420]]) {
  map.createPane(name, map._rotatePane || undefined);
  map.getPane(name).style.zIndex = z;
  map.getPane(name).style.pointerEvents = 'none';
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
  onStats: (stats) => { if (map.getZoom() >= FIELD_MIN_ZOOM) renderLegend(stats); },
  insets: mapInsets,
});
fields.setSolid(base === 'dark');
const regions = new RegionLayer(map, {
  pane: 'fields', insets: mapInsets,
  onTap: (level, p, at) => openRegion(level, p, at),
  onUpdate: () => { if (map.getZoom() < FIELD_MIN_ZOOM) renderLegend(regions.statsInView()); },
});
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

// ---------- "in view" legend: crops on screen; tap one to spotlight it ----------

function renderLegend(stats) {
  if (!stats || !stats.length || crop.which === 'none') {
    els.legend.hidden = true;
    if (state.focus != null) { state.focus = null; fields.setFocus(null); regions.setFocus(null); }
    return;
  }
  const total = stats.reduce((t, r) => t + r.acres, 0);
  const top = stats.filter((r) => r.acres / total >= 0.01).slice(0, 8);
  if (state.focus != null && !top.some((r) => r.code === state.focus)) top.push({ code: state.focus, acres: 0 });
  const appeared = els.legend.hidden;
  els.legend.hidden = false;
  // Labels were placed before the legend showed up; place them again clear of it.
  if (appeared) requestAnimationFrame(() => fields.relabel());
  els.legend.innerHTML = top.map((r) => `<button data-code="${r.code}" class="${r.code === state.focus ? 'on' : ''}" style="--c:${cropColor(r.code)}">
      <span class="emo">${cropEmoji(r.code)}</span>${esc(prettyName(r.code))}<em>${r.acres ? `${Math.max(1, Math.round(r.acres / total * 100))}%` : ''}</em></button>`).join('');
}
els.legend.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const code = +b.dataset.code;
  state.focus = state.focus === code ? null : code;
  fields.setFocus(state.focus);
  regions.setFocus(state.focus);
  b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', +x.dataset.code === state.focus));
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
  }).join('');
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

async function fillProgress() {
  for (const el of els.sheetBody.querySelectorAll('.progress:not([data-done])')) {
    el.dataset.done = '1';
    const { lat, lon, crop: code } = el.dataset;
    const key = `${code}:${(+lat).toFixed(0)}:${(+lon).toFixed(0)}`;
    let p = progressCache.get(key);
    if (!p) {
      p = fetch(`${proxyUrl}/progress?lat=${lat}&lon=${lon}&crop=${code}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      progressCache.set(key, p);
    }
    const data = await p;
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
  fields.select(null);
  fields.relabel();
  if (wasTap && state.mode === 'drive' && state.fix) { state.following = true; els.recenter.hidden = true; follow(true); }
}
els.sheetClose.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ---------- tapping a state or county ----------

function openRegion(level, p, at) {
  const t = topCrop(p);
  const planted = p.top.filter(([c]) => isPlanted(c));
  const max = planted[0]?.[1] || 1;
  const fmt = (a) => (a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : String(a));
  const name = level === 'states' ? p.name : `${p.name} County, ${p.st}`;
  const live = state.layers?.live?.label;
  showSheet('region', `<article class="detail">
    <div class="lbl">${level === 'states' ? 'State' : 'County'} · ${live ? `${esc(live)} live map` : 'USDA map'}</div>
    <div class="crop"><span class="big-emo" style="--c:${cropColor(t?.code)}">${t ? cropEmoji(t.code) : '🗺️'}</span><span class="crop-name">${esc(name)}</span></div>
    <div class="stats">
      <div><b>${fmt(p.crop)}</b><span>acres planted</span></div>
      <div><b>${Math.round(p.crop / p.area * 100)}%</b><span>of the land is cropland</span></div>
      ${t ? `<div><b>${Math.round(t.share * 100)}%</b><span>of it is ${esc(prettyName(t.code).toLowerCase())}</span></div>` : ''}
    </div>
    <div class="tbars">${planted.slice(0, 6).map(([c, a]) => `<div class="tbar"><span class="emo-sm" style="--c:${cropColor(c)}">${cropEmoji(c)}</span>
      <span class="bname">${esc(prettyName(c))}</span><i><b style="width:${(a / max * 100).toFixed(1)}%;background:${cropColor(c)}"></b></i><span class="bval">${fmt(a)} ac</span></div>`).join('')}</div>
    <div class="sheet-actions"><button class="primary" data-act="zoomto" data-lat="${at.lat}" data-lng="${at.lng}" data-z="${level === 'states' ? 7 : 12}">Zoom in</button><button class="ghost" data-act="close">Close</button></div>
  </article>`);
}

// ---------- tapping the map ----------

const pinIcon = L.divIcon({ className: 'tap-pin', iconSize: [16, 16], iconAnchor: [8, 8] });

async function onMapTap(lat, lon) {
  if (state.mode === 'idle') enterExplore(null, true);
  const field = fields.fieldAt(lat, lon);
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
    showSheet('tap', detail('point', res.sides.point, res.layers, { stats: fieldStats(field, res.sides.point), lat, lon, field }));
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
      }
      t.total += d;
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
    <button data-act="trip"><b>Trip log</b><span>${t.total >= 50 ? `${miles(t.total)} mi so far` : 'Miles of each crop along your drive'}</span></button>
    <button data-act="offline"><b>Save a route for offline</b><span>For stretches with no signal</span></button>
    <button data-act="routes"><b>Saved routes</b><span>${routes.length ? `${routes.length} saved` : 'None yet'}</span></button>
    <button data-act="about"><b>About the data</b><span>Where each reading comes from</span></button>
  </nav>`);
}
els.menuBtn.addEventListener('click', () => (state.sheet === 'menu' ? closeSheet() : openMenu()));

let downloadCtl = null;

function openOffline() {
  showSheet('offline', `<article class="detail"><div class="lbl">Save a route for offline</div>
    <p class="predict">Downloads the crop maps along a route, so left/right readings keep working with no signal. The base map needs signal.</p>
    <form class="route-form" id="routeForm">
      <label>From<input name="from" placeholder="Current location" autocomplete="off"></label>
      <label>To<input name="to" placeholder="City, town or address" required autocomplete="off"></label>
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
      const line = L.polyline(plan.coords, { color: '#e8c170', weight: 4, opacity: 0.9 }).addTo(routeLayer);
      map.fitBounds(line.getBounds(), { paddingTopLeft: [20, 90], paddingBottomRight: [20, 320] });
      out.innerHTML = `<div class="plan"><b>${esc(plan.from.name)} → ${esc(plan.to.name)}</b>
        <span>${Math.round(plan.miles)} mi · ${Math.floor(plan.minutes / 60)} h ${Math.round(plan.minutes % 60)} min · about ${plan.mb < 1 ? '<1' : Math.round(plan.mb)} MB</span></div>
        <button class="primary" id="dlBtn">Download for offline</button>`;
      $('dlBtn').addEventListener('click', async () => {
        downloadCtl = new AbortController();
        out.innerHTML = '<div class="dl"><i><b id="dlBar"></b></i><span id="dlText">Starting…</span><button class="chip warn" id="dlCancel">Cancel</button></div>';
        $('dlCancel').addEventListener('click', () => downloadCtl?.abort());
        try {
          const rec = await downloadRoute(plan, (done, total) => {
            const bar = $('dlBar'), txt = $('dlText');
            if (bar) bar.style.width = `${(done / total * 100).toFixed(1)}%`;
            if (txt) txt.textContent = `${done.toLocaleString()} of ${total.toLocaleString()} map pieces`;
          }, downloadCtl.signal);
          downloadCtl = null;
          if (!out.isConnected) setStatus('Route saved for offline', 'on');
          out.innerHTML = `<p class="note"><b>Saved.</b> Left/right readings will work along this route with no signal${rec.failed ? ` (${rec.failed} pieces couldn't be downloaded)` : ''}.</p>`;
        } catch (err) {
          downloadCtl = null;
          out.innerHTML = err.name === 'AbortError' ? '<p class="predict">Cancelled. Pieces already downloaded stay saved.</p>' : `<p class="err">${esc(err.message)}</p>`;
        }
      });
    } catch (err) {
      out.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    }
  });
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
  else if (act === 'menu') openMenu();
  else if (act === 'offline') openOffline();
  else if (act === 'routes') openRoutes();
  else if (act === 'about') { closeSheet(); els.about.showModal(); }
  else if (act === 'close') closeSheet();
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
els.headBtn.setAttribute('aria-pressed', String(state.headingUp));
els.startBtn.addEventListener('click', startDriving);
els.exploreBtn.addEventListener('click', () => enterExplore());
els.about.addEventListener('click', (e) => { if (e.target === els.about) els.about.close(); });
window.addEventListener('online', () => state.mode === 'drive' && driveStatus(false));
window.addEventListener('offline', () => state.mode === 'drive' && driveStatus(false));

// ?debug exposes internals in the console.
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { fsMap: map, fsFields: fields, fsState: state });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// Shareable spot: ?at=lat,lon opens the map there and inspects it.
const at = new URLSearchParams(location.search).get('at')?.split(',').map(Number);
if (at?.length === 2 && at.every(Number.isFinite)) {
  enterExplore(at);
  // Give the field outlines a moment to load so the tapped field is highlighted.
  setTimeout(() => onMapTap(at[0], at[1]), 1500);
}
