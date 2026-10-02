// Monthly check (run by .github/workflows/refresh-data.yml): has USDA published a newer crop map
// than the one data/*.json was built from? Prints a summary and sets `changed=true|false` for the
// workflow. Also reports whether USDA's national field-boundary (CSB) service is reachable.
import fs from 'node:fs';
import { discoverLayers } from '../data.js';

const meta = JSON.parse(fs.readFileSync(new URL('../data/meta.json', import.meta.url), 'utf8'));
const layers = await discoverLayers();
const now = { live: layers.live?.layer ?? null, annual: layers.years[0] ?? null };
const changed = now.live !== meta.live || now.annual !== meta.annual;

let csb = false;
try {
  const r = await fetch('https://pdi.scinet.usda.gov/hosting/rest/services/Hosted/Crop_Sequence_Boundaries_2024/FeatureServer/2?f=json', { signal: AbortSignal.timeout(30000) });
  csb = r.ok && !!(await r.json()).fields;
} catch { /* still down */ }

const lines = [
  `Built from: live ${meta.live ?? '—'}, annual ${meta.annual ?? '—'} (built ${meta.built})`,
  `Available now: live ${now.live ?? '—'}, annual ${now.annual ?? '—'}`,
  changed ? '➡️ New crop map available: rebuilding data.' : '✅ Data is up to date.',
  csb ? '🟢 USDA national field boundaries are back online.' : '🔴 USDA national field boundaries are still unavailable.',
];
console.log(lines.join('\n'));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\ncsb=${csb}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.map((l) => `- ${l}`).join('\n') + '\n');
