import {
  lookup, discoverLayers, prettyName, colorOf, isAg, NOTES, sideArea, LIVE_WMS, ANNUAL_WMS,
} from './data.js';
import { FieldLayer, FIELD_MIN_ZOOM } from './fields.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), statusText: $('statusText'), strip: $('strip'), welcome: $('welcome'),
  startBtn: $('startBtn'), exploreBtn: $('exploreBtn'), voiceBtn: $('voiceBtn'), infoBtn: $('infoBtn'),
  about: $('about'), recenter: $('recenterBtn'), layerToggle: $('layerToggle'), baseBtn: $('baseBtn'),
  mapHint: $('mapHint'), sheet: $('sheet'), sheetBody: $('sheetBody'), sheetClose: $('sheetClose'),
};

const state = {
  mode: 'idle',          // idle | drive | explore
  fix: null,             // latest GPS fix {lat, lon, speed, heading, t}
  prevFix: null,
  heading: null,
  following: true,
  lastQuery: null,       // {lat, lon, heading, mode, t}
  lastDrive: null,       // latest left/right (or "around you") result
  inFlight: false,
  sheet: null,           // null | 'drive' | 'tap'
  tapSeq: 0,             // latest tap, so a slow earlier tap can't overwrite it
  serverDown: false,
  lastSpoken: {},
  voice: localGet('fs.voice') === '1',
  layers: null,
};

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- map ----------

const map = L.map('map', { zoomControl: false, attributionControl: true, zoomSnap: 0.5 }).setView([39.5, -96.5], 5);
map.attributionControl.setPrefix(false);

for (const [name, z] of [['fields', 350], ['labels', 420], ['fieldLabels', 560]]) {
  map.createPane(name);
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
function setBase(which) {
  base = which;
  localSet('fs.base', which);
  for (const [k, layers] of Object.entries(BASES)) for (const l of layers) (k === which ? l.addTo(map) : map.removeLayer(l));
  els.baseBtn.setAttribute('aria-pressed', String(which === 'satellite'));
  els.baseBtn.title = which === 'satellite' ? 'Switch to dark map' : 'Switch to satellite';
}
setBase(base);
els.baseBtn.addEventListener('click', () => setBase(base === 'dark' ? 'satellite' : 'dark'));
map.attributionControl.addAttribution('Crops: USDA NASS, GMU CSISS');

// Crops: pixel tiles when zoomed out, outlined + labeled fields when zoomed in.
const fields = new FieldLayer(map, {
  onLoading: (on) => { if (state.mode !== 'drive') setStatus(on ? 'Loading fields…' : 'Ready', on ? 'busy' : ''); },
  // Keep labels out from under the top bar and the bottom panel.
  insets: () => {
    const h = document.querySelector('.hud').getBoundingClientRect();
    const covered = [els.sheet, els.welcome].filter((e) => !e.hidden).map((e) => e.getBoundingClientRect())
      .filter((r) => r.width < window.innerWidth * 0.9 ? false : true);
    const bottomTop = covered.length ? Math.min(...covered.map((r) => r.top)) : window.innerHeight;
    return { top: h.bottom, bottom: window.innerHeight - bottomTop };
  },
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
    crop.tiles = L.tileLayer.wms(src.url, {
      layers: src.layer, format: 'image/png', transparent: true, version: '1.1.1',
      crs: L.CRS.EPSG4326, opacity: 0.55, tileSize: 512, pane: 'fields',
    });
    fields.setSource(src);
  }
  fields.setEnabled(!!src);
  syncCropZoom();
}
// Pixel tiles only below the field zoom; the field layer takes over above it.
function syncCropZoom() {
  const zoomedOut = map.getZoom() < FIELD_MIN_ZOOM;
  if (crop.tiles) (zoomedOut ? crop.tiles.addTo(map) : map.removeLayer(crop.tiles));
  els.mapHint.hidden = !(zoomedOut && crop.which !== 'none');
}
map.on('zoomend', syncCropZoom);
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
let tapPin = null;

map.on('dragstart', () => {
  if (state.mode === 'drive') { state.following = false; els.recenter.hidden = false; }
});
els.recenter.addEventListener('click', () => {
  state.following = true; els.recenter.hidden = true;
  if (state.fix) follow(true);
});
map.on('click', (e) => onMapTap(e.latlng.lat, e.latlng.lng));

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

// Keep the car a little below center so more of the road ahead shows under the HUD.
function follow(animate) {
  const f = state.fix, z = map.getZoom() < 14 ? 16 : map.getZoom();
  const p = map.project([f.lat, f.lon], z).subtract([0, map.getSize().y * 0.12]);
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
  meMarker.getElement()?.querySelector('.dir')?.setAttribute('transform', `rotate(${state.heading ?? 0} 15 15)`);
  if (state.following && state.sheet !== 'tap') follow(true);

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
  if (due) driveQuery(f.lat, f.lon, mode === 'road' ? { heading: state.heading } : {});
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
    if (state.sheet === 'drive') openDriveSheet();
    announce(res);
  } catch {
    state.serverDown = true;
    if (!state.lastDrive) renderStripMessage('Crop map server is slow. Retrying…');
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
    return `<div class="side-cell tier-${s.tier}">
      <div class="lbl"><span>${label}</span>${tierTag(s, res.layers)}</div>
      <div class="name"><span class="swatch" style="background:${s.code != null ? colorOf(s.code) : 'var(--line)'}"></span><span>${esc(name)}</span></div>
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
    L.polygon(sideArea(res.lat, res.lon, opts.heading, side), {
      color: '#ffffff', weight: 1.5, opacity: 0.7, dashArray: '4 5', fill: false, interactive: false,
    }).addTo(areaLayer);
  }
}

// ---------- detail sheet ----------

function detail(sideKey, s, layers, extraFacts = '') {
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
  const facts = extraFacts ? `<div class="facts">${extraFacts}</div>` : '';

  const nowYear = layers.live?.year ?? (layers.years[0] + 1);
  const cells = s.history.map((h) => `<div class="yr" title="${h.year}: ${h.code != null ? esc(prettyName(h.code)) : 'no data'}"><i style="background:${h.code != null ? colorOf(h.code) : 'var(--line)'}"></i>${String(h.year).slice(2)}</div>`);
  cells.push(`<div class="yr now" title="${nowYear}: ${esc(name)}"><i style="background:${s.live ? colorOf(s.live.code) : 'transparent'};${s.live ? '' : 'border:1px dashed var(--muted)'}"></i>${String(nowYear).slice(2)}</div>`);

  return `<article class="detail">
      <div class="lbl">${SIDE_NAME[sideKey]}</div>
      <div class="crop"><span class="swatch" style="background:${s.code != null ? colorOf(s.code) : 'var(--line)'}"></span><span class="crop-name">${esc(name)}</span></div>
      ${runner}
      <div class="badges">${badges.join('')}</div>
      ${facts}${extra}${note}
      <div class="history" style="--n:${cells.length}">${cells.join('')}</div>
    </article>`;
}

function showSheet(kind, html, two = false) {
  state.sheet = kind;
  els.sheetBody.className = `sheet-body${two ? ' two' : ''}`;
  els.sheetBody.innerHTML = html;
  els.sheet.hidden = false;
  document.body.classList.add('sheet-open');
  fields.relabel();
}

function openDriveSheet() {
  const { res } = state.lastDrive;
  const keys = Object.keys(res.sides);
  showSheet('drive', keys.map((k) => detail(k, res.sides[k], res.layers)).join(''), keys.length === 2);
}

function closeSheet() {
  if (!state.sheet) return;
  const wasTap = state.sheet === 'tap';
  state.sheet = null;
  state.tapSeq++;
  els.sheet.hidden = true;
  document.body.classList.remove('sheet-open');
  if (tapPin) { map.removeLayer(tapPin); tapPin = null; }
  fields.select(null);
  fields.relabel();
  if (wasTap && state.mode === 'drive' && state.fix) { state.following = true; els.recenter.hidden = true; follow(true); }
}
els.sheetClose.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ---------- tapping the map ----------

const pinIcon = L.divIcon({ className: 'tap-pin', iconSize: [16, 16], iconAnchor: [8, 8] });

async function onMapTap(lat, lon) {
  if (state.mode === 'idle') enterExplore(null, true);
  const field = fields.fieldAt(lat, lon);
  // Tapping outside any field while the sheet is open just closes it.
  if (state.sheet && !field) return closeSheet();

  const seq = ++state.tapSeq;
  fields.select(field ? field.id : null);
  if (tapPin) tapPin.setLatLng([lat, lon]);
  else tapPin = L.marker([lat, lon], { icon: pinIcon, interactive: false }).addTo(map);

  showSheet('tap', `<article class="detail"><div class="lbl">This spot</div>
    <div class="crop"><span class="swatch" style="background:${field ? colorOf(field.code) : 'var(--line)'}"></span>
    <span class="crop-name loading-name">${field ? esc(prettyName(field.code)) : 'Looking…'}</span></div></article>`);

  try {
    const res = await lookup(lat, lon, { tapped: true });
    if (seq !== state.tapSeq) return;
    const facts = field && field.acres > 0 ? `Field size about <b>${field.acres.toLocaleString()} acres</b>` : '';
    showSheet('tap', detail('point', res.sides.point, res.layers, facts));
  } catch (err) {
    if (seq !== state.tapSeq) return;
    showSheet('tap', `<article class="detail"><div class="lbl">This spot</div><p class="err">${esc(err.message)}. Try again in a moment.</p></article>`);
  }
}

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
els.startBtn.addEventListener('click', startDriving);
els.exploreBtn.addEventListener('click', () => enterExplore());
els.infoBtn.addEventListener('click', () => els.about.showModal());
els.about.addEventListener('click', (e) => { if (e.target === els.about) els.about.close(); });

// Shareable spot: ?at=lat,lon opens the map there and inspects it.
const at = new URLSearchParams(location.search).get('at')?.split(',').map(Number);
if (at?.length === 2 && at.every(Number.isFinite)) {
  enterExplore(at);
  // Give the field outlines a moment to load so the tapped field is highlighted.
  setTimeout(() => onMapTap(at[0], at[1]), 1500);
}
