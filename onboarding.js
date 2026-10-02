// First-launch walkthrough: five quick swipeable screens, skippable, replayable from the menu.
import { KERNEL_SVG, fx } from './fun.js';

const KEY = 'fs.onboarded';
export const onboarded = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return true; } };
const done = () => { try { localStorage.setItem(KEY, '1'); } catch { /* fine */ } };

const tile = (bg, e) => `<i style="background:${bg}">${e}</i>`;
const STEPS = [
  {
    art: `<div class="ob-kernel">${KERNEL_SVG}</div><div class="ob-patch">${[
      ['#ffc928', '🌽'], ['#22c55e', '🫘'], ['#fb7a24', '🌾'], ['#ffc928', '🌽'], ['#a78bfa', '🌿'], ['#22c55e', '🫘'],
    ].map(([b, e]) => tile(b, e)).join('')}</div>`,
    title: 'Hi! I’m Kernel 🌽',
    text: 'FieldSight shows what’s growing in fields across the lower 48, straight from <b>this season’s satellite crop map</b>.',
  },
  {
    art: `<div class="ob-strip"><div><small>◂ LEFT</small><b><i style="background:#ffc928">🌽</i>Corn</b><em>LIVE</em></div><div><small>RIGHT ▸</small><b><i style="background:#22c55e">🫘</i>Soybeans</b><em>LIVE</em></div></div>
      <div class="ob-car">🚗</div>`,
    title: 'Driving? We read both sides',
    text: 'Tap <b>Start driving</b> and the top bar names the fields on your left and right, plus what’s coming up. Turn on <b>🔊 voice</b> and keep your eyes on the road.',
  },
  {
    art: `<div class="ob-zoom"><span style="--c:#ffc928">IA 🌽 53%</span><span style="--c:#fb7a24">🌾 The Wheat Belt</span><span style="--c:#22c55e">🫘 Soybeans · 143 ac</span></div>`,
    title: 'Explore the map',
    text: 'Colors are crops (the <b>⁘ key</b> explains them). Zoom from states to counties to single fields, and <b>tap anything</b> for its story, history, and fun facts.',
  },
  {
    art: `<div class="ob-cards">${[['#ffc928', '🌽'], ['#38bdf8', '🍚'], ['#d946ef', '🍇']].map(([b, e], i) => `<i style="background:${b};--r:${(i - 1) * 9}deg">${e}</i>`).join('')}</div>
      <div class="ob-games"><span>🎯 Bingo</span><span>🧩 Guess the crop</span><span>🏅 Badges</span></div>`,
    title: 'Collect & play',
    text: 'Drive past a crop to <b>collect its card</b>. Rare ones glow. Play <b>road-trip bingo</b>, guess crops from the sky, and earn badges. It’s all in the <b>☰ menu</b>.',
  },
  {
    art: `<div class="ob-share"><div class="ob-card"><b>🌽</b><span>Corn</span><small>📍 Story County, Iowa</small></div><div class="ob-spark">✨</div></div>`,
    title: 'Share your finds',
    text: 'Turn any field into a postcard for friends. When you start driving we’ll ask for your location. It’s only used to look up the fields around you. No account needed, and your trips stay on your phone.',
    last: true,
  },
];

export function showOnboarding({ onDone } = {}) {
  let i = 0;
  const el = document.createElement('div');
  el.className = 'onboard';
  el.innerHTML = `<div class="ob-card-wrap" role="dialog" aria-label="How FieldSight works">
      <button class="ob-skip">Skip</button>
      <div class="ob-stage"></div>
      <div class="ob-dots">${STEPS.map(() => '<i></i>').join('')}</div>
      <div class="ob-nav"><button class="ghost ob-back">Back</button><button class="primary ob-next">Next</button></div>
    </div>`;
  document.body.appendChild(el);
  const stage = el.querySelector('.ob-stage'), next = el.querySelector('.ob-next'), back = el.querySelector('.ob-back');

  function render(dir = 1) {
    const s = STEPS[i];
    stage.innerHTML = `<div class="ob-step ${dir > 0 ? 'in-right' : 'in-left'}"><div class="ob-art">${s.art}</div><h2>${s.title}</h2><p>${s.text}</p></div>`;
    el.querySelectorAll('.ob-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
    back.style.visibility = i ? 'visible' : 'hidden';
    next.textContent = s.last ? 'Let’s go! 🚜' : 'Next';
  }
  function close() {
    done();
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
    onDone?.();
  }
  next.addEventListener('click', () => { fx('flip'); if (STEPS[i].last) close(); else { i++; render(1); } });
  back.addEventListener('click', () => { if (i) { i--; render(-1); } });
  el.querySelector('.ob-skip').addEventListener('click', close);
  // Swipe left/right.
  let x0 = null;
  stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (dx < -50 && !STEPS[i].last) { i++; render(1); } else if (dx > 50 && i) { i--; render(-1); }
  });
  document.addEventListener('keydown', function key(e) {
    if (!el.isConnected) return document.removeEventListener('keydown', key);
    if (e.key === 'ArrowRight') next.click(); else if (e.key === 'ArrowLeft') back.click(); else if (e.key === 'Escape') close();
  });
  render();
}
