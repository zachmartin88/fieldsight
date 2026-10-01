// Shareable cards: a 1080×1350 image (Instagram portrait) of a field, sent through the phone's share
// sheet (Messages, Instagram, etc.) or downloaded where sharing files isn't supported.
import { prettyName } from './data.js';
import { cropColor, cropEmoji, shortName } from './palette.js';
import { parseColor } from './fields.js';

const W = 1080, H = 1350;
const SITE = 'zachmartin88.github.io/fieldsight';
const FONT = 'Inter, -apple-system, "Segoe UI", Roboto, sans-serif';

// ---------- where is this? (county lookup from the bundled outlines) ----------

let countiesP, statesP;
// Source names already say "County" / "Parish" / "Borough" in most cases.
export const countyName = (n) => (/(County|Parish|Borough|city|City|Census Area|Municipality)$/.test(n) ? n : `${n} County`);
function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < xi + (lat - yi) / (yj - yi) * (xj - xi)) inside = !inside;
  }
  return inside;
}
export async function placeName(lat, lng) {
  countiesP ??= fetch('data/counties.json').then((r) => r.json()).catch(() => null);
  statesP ??= fetch('data/states.json').then((r) => r.json()).catch(() => null);
  const [counties, states] = await Promise.all([countiesP, statesP]);
  const hit = counties?.features.find((f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.some((rings) => inRing(lat, lng, rings[0]) && !rings.slice(1).some((h) => inRing(lat, lng, h)));
  });
  if (!hit) return null;
  const st = states?.features.find((f) => f.properties.st === hit.properties.st)?.properties.name || hit.properties.st;
  const county = countyName(hit.properties.name);
  return { county, state: st, st: hit.properties.st, short: `${county}, ${hit.properties.st}` };
}

// ---------- drawing helpers ----------

const rgba = (c, a) => { const [r, g, b] = parseColor(c); return `rgba(${r},${g},${b},${a})`; };
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function pill(ctx, x, y, text, { bg, fg = '#fff', size = 34, pad = 26, h = 76 } = {}) {
  ctx.font = `800 ${size}px ${FONT}`;
  const w = ctx.measureText(text).width + pad * 2;
  ctx.fillStyle = bg; roundRect(ctx, x, y, w, h, h / 2); ctx.fill();
  ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.fillText(text, x + pad, y + h / 2 + 1);
  return w;
}
function fitText(ctx, text, maxW, size, weight = 900) {
  let s = size;
  do { ctx.font = `${weight} ${s}px ${FONT}`; s -= 4; } while (ctx.measureText(text).width > maxW && s > 40);
  return s + 4;
}

// The field's outline, scaled into a box (equirectangular is fine at field size).
function drawShape(ctx, rings, box, color) {
  const pts = rings.flat();
  const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length, k = Math.cos(lat0 * Math.PI / 180);
  const xs = pts.map((p) => p[1] * k), ys = pts.map((p) => -p[0]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const s = Math.min(box.w / (maxx - minx || 1), box.h / (maxy - miny || 1));
  const ox = box.x + (box.w - (maxx - minx) * s) / 2, oy = box.y + (box.h - (maxy - miny) * s) / 2;
  ctx.beginPath();
  for (const r of rings) r.forEach(([lat, lng], i) => {
    const x = ox + (lng * k - minx) * s, y = oy + (-lat - miny) * s;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = rgba(color, 0.9); ctx.fill('evenodd');
  ctx.lineJoin = 'round'; ctx.lineWidth = 7; ctx.strokeStyle = '#fff'; ctx.stroke();
}

// ---------- the card ----------

/**
 * info: { code, tier, liveLabel, acres, football, yieldText, history: [{year, code}], nowYear,
 *         place: {county, state}, rings }
 */
export async function fieldCard(info) {
  await document.fonts?.ready;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const col = cropColor(info.code);

  // Background: the crop's color glowing out of a deep night-blue.
  ctx.fillStyle = '#0f1218'; ctx.fillRect(0, 0, W, H);
  let g = ctx.createRadialGradient(W * 0.75, H * 0.12, 40, W * 0.75, H * 0.12, W * 1.1);
  g.addColorStop(0, rgba(col, 0.75)); g.addColorStop(0.45, rgba(col, 0.22)); g.addColorStop(1, 'rgba(15,18,24,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // Soft crop-row stripes.
  ctx.save(); ctx.globalAlpha = 0.07; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
  for (let i = -H; i < W + H; i += 46) { ctx.beginPath(); ctx.moveTo(i, H); ctx.lineTo(i + H * 0.55, 0); ctx.stroke(); }
  ctx.restore();

  // Header.
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 40px ${FONT}`; ctx.fillStyle = '#e8c170'; ctx.fillText('FieldSight', 80, 120);
  const tag = info.tier === 'live' ? `✓ Live satellite · ${info.liveLabel}` : 'Spotted on the road';
  ctx.font = `700 28px ${FONT}`;
  const tw = ctx.measureText(tag).width + 44;
  ctx.fillStyle = 'rgba(255,255,255,.12)'; roundRect(ctx, W - 80 - tw, 78, tw, 56, 28); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(tag, W - 80 - tw + 22, 107);

  // Big emoji medallion.
  ctx.save();
  ctx.shadowColor = rgba(col, 0.8); ctx.shadowBlur = 60;
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(230, 330, 140, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(230, 330, 140, 0, Math.PI * 2); ctx.stroke();
  ctx.font = `150px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(cropEmoji(info.code) || '🌱', 230, 340);
  ctx.textAlign = 'left';

  // Field shape, top right.
  if (info.rings?.length) drawShape(ctx, info.rings, { x: 460, y: 200, w: 540, h: 260 }, col);

  // Name + place.
  const name = prettyName(info.code);
  const size = fitText(ctx, name, W - 160, 120);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic'; ctx.fillText(name, 80, 610 + (120 - size) / 3);
  ctx.font = `600 38px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.78)';
  const when = new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  ctx.fillText(`📍 ${info.place ? `${info.place.county}, ${info.place.state}` : 'Somewhere in the USA'}`, 80, 680);
  ctx.font = `500 32px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillText(when, 80, 730);

  // Stat pills.
  let x = 80;
  const stats = [info.acres && `${info.acres.toLocaleString()} acres`, info.football && `≈${info.football.toLocaleString()} football fields`, info.yieldText].filter(Boolean);
  let y = 790;
  for (const t of stats) {
    ctx.font = `800 34px ${FONT}`;
    const w = ctx.measureText(t).width + 52;
    if (x + w > W - 80) { x = 80; y += 92; }
    x += pill(ctx, x, y, t, { bg: 'rgba(255,255,255,.12)' }) + 16;
  }

  // Crop history.
  const hist = (info.history || []).slice(-5);
  const seasons = [...hist, { year: info.nowYear, code: info.code, now: true }];
  const top = Math.max(y + 130, 1000), cw = (W - 160 - 14 * (seasons.length - 1)) / seasons.length;
  ctx.font = `800 26px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('CROP HISTORY', 80, top - 22);
  seasons.forEach((sn, i) => {
    const sx = 80 + i * (cw + 14);
    ctx.fillStyle = sn.now ? rgba(col, 0.28) : 'rgba(255,255,255,.08)';
    roundRect(ctx, sx, top, cw, 170, 26); ctx.fill();
    ctx.fillStyle = cropColor(sn.code); roundRect(ctx, sx, top, cw, 10, 5); ctx.fill();
    ctx.textAlign = 'center';
    ctx.font = `800 26px ${FONT}`; ctx.fillStyle = sn.now ? '#e8c170' : 'rgba(255,255,255,.7)';
    ctx.fillText(sn.now ? 'NOW' : `’${String(sn.year).slice(2)}`, sx + cw / 2, top + 50);
    ctx.font = `56px ${FONT}`; ctx.fillText(cropEmoji(sn.code) || '·', sx + cw / 2, top + 118);
    ctx.font = `700 22px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillText(sn.code != null ? shortName(sn.code) : '—', sx + cw / 2, top + 152);
    ctx.textAlign = 'left';
  });

  // Footer.
  ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(80, H - 140, W - 160, 2);
  ctx.font = `700 32px ${FONT}`; ctx.fillStyle = '#fff'; ctx.fillText('What’s growing beside your road?', 80, H - 84);
  ctx.font = `600 28px ${FONT}`; ctx.fillStyle = '#e8c170'; ctx.fillText(SITE, 80, H - 42);
  return cv;
}

// Share a canvas through the share sheet, or download it.
export async function shareCanvas(cv, { title, text, filename }) {
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const file = new File([blob], filename, { type: 'image/png' });
  const data = { files: [file], title, text: `${text} https://${SITE}/` };
  if (navigator.canShare?.(data)) {
    try { await navigator.share(data); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}

// The album as a shareable card: every collected crop as a little tile.
export async function albumCard(album) {
  const { SETS, rarityOf, stars, albumSummary } = await import('./album.js');
  await document.fonts?.ready;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0f1218'; ctx.fillRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, 'rgba(255,197,61,.35)'); g.addColorStop(0.5, 'rgba(255,143,199,.18)'); g.addColorStop(1, 'rgba(63,217,139,.3)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const sum = albumSummary(album);
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 40px ${FONT}`; ctx.fillStyle = '#e8c170'; ctx.fillText('FieldSight', 80, 120);
  ctx.font = `900 96px ${FONT}`; ctx.fillStyle = '#fff'; ctx.fillText('My Crop Cards', 80, 240);
  ctx.font = `700 40px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.8)';
  ctx.fillText(`${sum.got} of ${sum.total} collected · ${sum.states} states`, 80, 310);

  const got = SETS.flatMap((s) => s.codes).filter((c) => album.cards[c]);
  const cols = 6, cw = (W - 160 - 20 * (cols - 1)) / cols, ch = cw * 1.25;
  got.slice(0, 36).forEach((code, i) => {
    const x = 80 + (i % cols) * (cw + 20), y = 380 + Math.floor(i / cols) * (ch + 20);
    if (y + ch > H - 140) return;
    const r = rarityOf(code);
    ctx.fillStyle = rgba(cropColor(code), 0.9); roundRect(ctx, x, y, cw, ch, 22); ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = r.color; ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${cw * 0.5}px ${FONT}`; ctx.fillText(cropEmoji(code), x + cw / 2, y + ch * 0.42);
    ctx.font = `800 ${cw * 0.13}px ${FONT}`; ctx.fillStyle = '#1a1408';
    ctx.fillText('★'.repeat(stars(album.cards[code].n)), x + cw / 2, y + ch * 0.82);
    ctx.textAlign = 'left';
  });
  if (!got.length) {
    ctx.font = `700 44px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.fillText('Just getting started — first drive coming up! 🚗', 80, 460);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 32px ${FONT}`; ctx.fillStyle = '#fff'; ctx.fillText('Collect every crop on your drives.', 80, H - 84);
  ctx.font = `600 28px ${FONT}`; ctx.fillStyle = '#e8c170'; ctx.fillText(SITE, 80, H - 42);
  return cv;
}
