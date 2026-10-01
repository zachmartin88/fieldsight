// FieldSight proxy: caches crop-map tiles from the GMU CSISS map servers and serves USDA crop
// progress. No dependencies; run with Node 22+.
//
//   GET /health
//   GET /wms/icrop?<WMS query>    -> https://cat.csiss.gmu.edu/cgi-bin/wms_cdl_icrop
//   GET /wms/cdlall?<WMS query>   -> https://cat.csiss.gmu.edu/cgi-bin/wms_cdlall
//   GET /progress?lat=&lon=&crop=<CDL code>  -> this week's USDA crop progress for that state
//
// The upstream server omits its intermediate certificate, so start Node with
// NODE_EXTRA_CA_CERTS=proxy/incommon-rsa-server-ca-2.pem (render.yaml does this).
import http from 'node:http';

const PORT = process.env.PORT || 8787;
const QUICKSTATS_KEY = process.env.QUICKSTATS_KEY || '';
const UPSTREAM = {
  icrop: 'https://cat.csiss.gmu.edu/cgi-bin/wms_cdl_icrop',
  cdlall: 'https://cat.csiss.gmu.edu/cgi-bin/wms_cdlall',
};
// Only these WMS parameters are forwarded, so the proxy can't be used for anything else.
const WMS_PARAMS = ['SERVICE', 'VERSION', 'REQUEST', 'LAYERS', 'STYLES', 'SRS', 'BBOX', 'WIDTH', 'HEIGHT', 'FORMAT', 'TRANSPARENT'];
const MAX_PIXELS = 1200 * 1200;

// ---------- small byte-capped LRU ----------

class Lru {
  constructor(maxBytes) { this.max = maxBytes; this.bytes = 0; this.map = new Map(); }
  get(k) {
    const e = this.map.get(k);
    if (!e) return null;
    if (e.expires < Date.now()) { this.delete(k); return null; }
    this.map.delete(k); this.map.set(k, e);
    return e;
  }
  set(k, e) {
    this.delete(k);
    this.map.set(k, e); this.bytes += e.body.length;
    while (this.bytes > this.max) this.delete(this.map.keys().next().value);
  }
  delete(k) {
    const e = this.map.get(k);
    if (e) { this.bytes -= e.body.length; this.map.delete(k); }
  }
}
const cache = new Lru(Number(process.env.CACHE_MB || 150) * 1024 * 1024);
const inflight = new Map();

async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit) return { ...hit, hit: true };
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const e = await load();
    if (e.status === 200) cache.set(key, { ...e, expires: Date.now() + ttlMs });
    return e;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function upstream(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'FieldSight-proxy/1.0' } });
    return { status: res.status, type: res.headers.get('content-type') || 'application/octet-stream', body: Buffer.from(await res.arrayBuffer()) };
  } finally { clearTimeout(t); }
}

// ---------- handlers ----------

async function wms(service, params) {
  const q = new URLSearchParams();
  const upper = new Map([...params].map(([k, v]) => [k.toUpperCase(), v]));
  for (const k of WMS_PARAMS) if (upper.has(k)) q.set(k, upper.get(k));
  const req = (q.get('REQUEST') || '').toLowerCase();
  if (req !== 'getmap' && req !== 'getcapabilities') return json(400, { error: 'only GetMap and GetCapabilities' });
  if (req === 'getmap' && (+q.get('WIDTH') || 0) * (+q.get('HEIGHT') || 0) > MAX_PIXELS) return json(400, { error: 'image too large' });

  // Map layers are named by year (and month), so a given tile never changes; capabilities do.
  const ttl = req === 'getmap' ? 30 * 86400e3 : 3600e3;
  const key = `${service}?${q}`;
  const e = await cached(key, ttl, () => upstream(`${UPSTREAM[service]}?${q}`));
  return {
    status: e.status, type: e.type, body: e.body,
    headers: {
      'Cache-Control': e.status === 200 ? `public, max-age=${req === 'getmap' ? 7 * 86400 : 3600}` : 'no-store',
      'X-Cache': e.hit ? 'HIT' : 'MISS',
    },
  };
}

// USDA Crop Sequence Boundaries (official field outlines). Only query parameters are forwarded.
const CSB_URL = 'https://pdi.scinet.usda.gov/hosting/rest/services/Hosted/Crop_Sequence_Boundaries_2024/FeatureServer/2/query';
const CSB_PARAMS = ['where', 'geometry', 'geometryType', 'inSR', 'spatialRel', 'outFields', 'outSR', 'f', 'resultOffset', 'resultRecordCount', 'geometryPrecision', 'maxAllowableOffset'];

async function csb(params) {
  const q = new URLSearchParams();
  for (const k of CSB_PARAMS) if (params.has(k)) q.set(k, params.get(k));
  const key = `csb?${q}`;
  const e = await cached(key, 7 * 86400e3, () => upstream(`${CSB_URL}?${q}`));
  return { status: e.status, type: e.type, body: e.body, headers: { 'Cache-Control': e.status === 200 ? 'public, max-age=86400' : 'no-store' } };
}

// CDL code -> Quick Stats commodity (and class for wheat).
const COMMODITY = {
  1: ['CORN'], 5: ['SOYBEANS'], 2: ['COTTON'], 3: ['RICE'], 4: ['SORGHUM'], 21: ['BARLEY'], 28: ['OATS'],
  24: ['WHEAT', 'WINTER'], 23: ['WHEAT', 'SPRING, (EXCL DURUM)'], 22: ['WHEAT', 'SPRING, DURUM'],
  6: ['SUNFLOWER'], 10: ['PEANUTS'], 41: ['SUGARBEETS'], 31: ['CANOLA'], 42: ['BEANS'],
};

async function stateAt(lat, lon) {
  const key = `state:${lat.toFixed(1)},${lon.toFixed(1)}`;
  const e = await cached(key, 30 * 86400e3, async () => {
    const r = await upstream(`https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&layers=States&format=json`);
    const st = r.status === 200 ? JSON.parse(r.body).result?.geographies?.States?.[0] : null;
    return { status: st ? 200 : 404, type: 'application/json', body: Buffer.from(JSON.stringify(st ? { code: st.STUSAB, name: st.NAME } : {})) };
  });
  return e.status === 200 ? JSON.parse(e.body) : null;
}

async function quickStats(params) {
  const q = new URLSearchParams({ key: QUICKSTATS_KEY, source_desc: 'SURVEY', agg_level_desc: 'STATE', format: 'JSON', ...params });
  const r = await upstream(`https://quickstats.nass.usda.gov/api/api_GET/?${q}`);
  if (r.status !== 200) return [];
  return JSON.parse(r.body).data || [];
}

// Latest week's numbers, plus the week before for comparison.
function latestWeeks(rows) {
  const weeks = [...new Set(rows.map((r) => r.week_ending))].sort().reverse();
  const pick = (w) => rows.filter((r) => r.week_ending === w).map((r) => ({
    what: r.unit_desc.replace(/^PCT /, '').toLowerCase(), pct: Number(String(r.Value).replace(/,/g, '')),
  })).filter((r) => Number.isFinite(r.pct));
  return { week: weeks[0] || null, now: weeks[0] ? pick(weeks[0]) : [], prev: weeks[1] ? pick(weeks[1]) : [] };
}

async function progress(params) {
  if (!QUICKSTATS_KEY) return json(501, { error: 'crop progress is not set up (no QUICKSTATS_KEY)' });
  const lat = +params.get('lat'), lon = +params.get('lon'), code = +params.get('crop');
  const c = COMMODITY[code];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !c) return json(400, { error: 'need lat, lon and a supported crop' });
  const st = await stateAt(lat, lon);
  if (!st) return json(404, { error: 'not in a US state' });

  const year = new Date().getFullYear();
  const key = `progress:${st.code}:${code}:${year}`;
  const e = await cached(key, 6 * 3600e3, async () => {
    const base = { commodity_desc: c[0], state_alpha: st.code, year: String(year) };
    if (c[1]) base.class_desc = c[1];
    const [prog, cond] = await Promise.all([
      quickStats({ ...base, statisticcat_desc: 'PROGRESS' }),
      quickStats({ ...base, statisticcat_desc: 'CONDITION' }),
    ]);
    const out = { state: st.name, stateCode: st.code, commodity: c[0].toLowerCase(), progress: latestWeeks(prog), condition: latestWeeks(cond) };
    const any = out.progress.now.length || out.condition.now.length;
    return { status: any ? 200 : 404, type: 'application/json', body: Buffer.from(JSON.stringify(any ? out : { error: 'no report this season' })) };
  });
  return { status: e.status, type: e.type, body: e.body, headers: { 'Cache-Control': 'public, max-age=3600' } };
}

// ---------- leaderboard ----------
// Each phone keeps its own totals and re-sends them when the app opens, so the board rebuilds
// itself after the free server restarts. No accounts: a random device id plus a nickname.
const board = new Map();          // id -> { name, cards, states, badges, miles, score, at }
const NAME_OK = /^[\p{L}\p{N} ._'-]{2,18}$/u;
const BLOCK = /(fuck|shit|cunt|nigg|fag|bitch|dick|pussy|rape)/i;
const clampInt = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

function lbScore(p) { return p.cards * 10 + p.states * 20 + p.badges * 15 + Math.floor(p.miles); }

async function readBody(req, limit = 2048) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > limit) throw new Error('too big'); }
  return body;
}

async function lbSubmit(req) {
  const b = JSON.parse(await readBody(req));
  const id = String(b.id || '');
  if (!/^[a-z0-9-]{8,40}$/i.test(id)) return json(400, { error: 'bad id' });
  const name = String(b.name || '').trim();
  if (!NAME_OK.test(name) || BLOCK.test(name)) return json(400, { error: 'pick another name' });
  const prev = board.get(id);
  if (prev && Date.now() - prev.at < 5000) return json(429, { error: 'slow down' });
  const p = { name, cards: clampInt(b.cards, 200), states: clampInt(b.states, 48), badges: clampInt(b.badges, 60), miles: clampInt(b.miles, 200000), at: Date.now() };
  p.score = lbScore(p);
  board.set(id, p);
  return json(200, { ok: true, rank: rankOf(id), players: board.size });
}

function rankOf(id) {
  const me = board.get(id);
  if (!me) return null;
  let r = 1;
  for (const p of board.values()) if (p.score > me.score) r++;
  return r;
}

function lbTop(params) {
  const id = params.get('id');
  const top = [...board.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 50)
    .map(([pid, p]) => ({ name: p.name, score: p.score, cards: p.cards, states: p.states, badges: p.badges, miles: p.miles, me: pid === id }));
  return { status: 200, type: 'application/json', body: Buffer.from(JSON.stringify({ top, players: board.size, rank: id ? rankOf(id) : null })), headers: { 'Cache-Control': 'no-store' } };
}

function json(status, obj) {
  return { status, type: 'application/json', body: Buffer.from(JSON.stringify(obj)) };
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let out;
  try {
    const m = url.pathname.match(/^\/wms\/(icrop|cdlall)$/);
    if (req.method === 'POST' && url.pathname === '/lb') out = await lbSubmit(req);
    else if (req.method !== 'GET') out = json(405, { error: 'method' });
    else if (url.pathname === '/health') out = json(200, { ok: true, cachedMB: +(cache.bytes / 1048576).toFixed(1), progress: !!QUICKSTATS_KEY });
    else if (m) out = await wms(m[1], url.searchParams);
    else if (url.pathname === '/progress') out = await progress(url.searchParams);
    else if (url.pathname === '/csb') out = await csb(url.searchParams);
    else if (url.pathname === '/lb') out = lbTop(url.searchParams);
    else out = json(404, { error: 'not found' });
  } catch (err) {
    out = json(502, { error: 'upstream failed', detail: String(err.message || err) });
  }
  res.writeHead(out.status, { ...cors, 'Content-Type': out.type, ...(out.headers || {}) });
  res.end(out.body);
});
server.listen(PORT, () => console.log(`FieldSight proxy on :${PORT}${QUICKSTATS_KEY ? '' : ' (crop progress off: no QUICKSTATS_KEY)'}`));
