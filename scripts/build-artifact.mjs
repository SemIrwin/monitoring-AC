#!/usr/bin/env node
/**
 * Construit une version « fichier unique » du dashboard, données incluses,
 * dans dist/artifact.html — pratique pour partager un instantané (par exemple
 * comme Artifact Claude) sans hébergement.
 *
 *   node scripts/build-artifact.mjs            # utilise site/data/dataset.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
const dataset = readFileSync(join(ROOT, 'site', 'data', 'dataset.json'), 'utf8');

function between(src, begin, end) {
  const i = src.indexOf(begin), j = src.indexOf(end);
  if (i === -1 || j === -1) throw new Error(`Repères ${begin} / ${end} introuvables dans site/index.html`);
  return src.slice(i + begin.length, j);
}

const style = between(html, '<!-- ARTIFACT:STYLE:BEGIN -->', '<!-- ARTIFACT:STYLE:END -->');
const body = between(html, '<!-- ARTIFACT:BODY:BEGIN -->', '<!-- ARTIFACT:BODY:END -->');

// `</script>` dans une chaîne JSON terminerait le bloc <script> : on l'échappe.
const safeJson = dataset.replace(/</g, '\\u003c');

const out = `<title>Monitoring AC</title>
${style}
<script>window.__EMBEDDED_DATASET__ = ${safeJson};</script>
${body}`;

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const outPath = join(ROOT, 'dist', 'artifact.html');
writeFileSync(outPath, out);
console.log(`Fichier autonome : ${outPath} (${Math.round(out.length / 1024)} Ko)`);
