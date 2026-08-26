#!/usr/bin/env node
/**
 * Génère un historique de démonstration réaliste (30 jours de relevés horaires
 * pour 4 emails répartis sur 2 automatisations) directement dans
 * site/data/dataset.json — pour prévisualiser le dashboard sans compte AC.
 *
 *   node scripts/generate-demo-data.mjs
 *
 * N'écrit PAS dans data/snapshots/ : les vraies données ne sont jamais touchées.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site', 'data', 'dataset.json');

const COLS = ['t', 'send', 'open_u', 'open_t', 'click_u', 'click_t', 'hb', 'sb', 'unsub'];
const DAYS = 30;
const STEP = 3600; // relevé horaire

// Générateur pseudo-aléatoire déterministe (mêmes données de démo à chaque exécution).
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

const now = Math.floor(Date.now() / 1000 / STEP) * STEP;
const start = now - DAYS * 86400;

/**
 * Simule des compteurs cumulés : des contacts entrent dans l'automatisation à un
 * rythme qui varie selon l'heure et le jour (creux la nuit et le week-end), puis
 * ouvrent/cliquent avec un léger retard. Une baisse de délivrabilité est simulée
 * sur 2 jours pour rendre le graphique des rebonds intéressant.
 */
function simulate({ baseRate, openRate, ctor, hbRate, sbRate, incidentDay }) {
  const rows = [];
  let send = 0, open_u = 0, open_t = 0, click_u = 0, click_t = 0, hb = 0, sb = 0, unsub = 0;
  let pendingOpen = 0, pendingClick = 0;

  for (let t = start; t <= now; t += STEP) {
    const d = new Date(t * 1000);
    const hour = d.getUTCHours();
    const dow = d.getUTCDay();
    const dayIndex = Math.floor((t - start) / 86400);

    let rate = baseRate * (0.25 + 0.75 * Math.max(0, Math.sin(((hour - 5) / 16) * Math.PI)));
    if (dow === 0 || dow === 6) rate *= 0.45;
    rate *= 0.85 + 0.3 * rand();

    const newSends = Math.max(0, Math.round(rate));
    send += newSends;

    const incident = incidentDay !== null && dayIndex >= incidentDay && dayIndex < incidentDay + 2;
    const effOpen = openRate * (incident ? 0.55 : 1) * (0.92 + 0.16 * rand());
    hb += Math.round(newSends * hbRate * (incident ? 6 : 1) * (0.5 + rand()));
    sb += Math.round(newSends * sbRate * (incident ? 3 : 1) * (0.5 + rand()));

    // Les ouvertures/clics d'un envoi s'étalent : ~60 % dans l'heure, le reste plus tard.
    pendingOpen += newSends * effOpen;
    const opensNow = pendingOpen * 0.6;
    pendingOpen -= opensNow;
    open_u += Math.round(opensNow);
    open_t += Math.round(opensNow * 1.65);

    pendingClick += opensNow * ctor * (0.9 + 0.2 * rand());
    const clicksNow = pendingClick * 0.7;
    pendingClick -= clicksNow;
    click_u += Math.round(clicksNow);
    click_t += Math.round(clicksNow * 1.4);

    unsub += rand() < newSends * 0.004 ? 1 : 0;

    rows.push([t, send, open_u, open_t, click_u, click_t, hb, sb, unsub]);
  }
  return rows;
}

const emails = [
  { id: '101', name: 'Email 1 — Bienvenue', automationId: '1', sim: { baseRate: 26, openRate: 0.52, ctor: 0.17, hbRate: 0.006, sbRate: 0.012, incidentDay: 21 } },
  { id: '102', name: 'Email 2 — Étude de cas', automationId: '1', sim: { baseRate: 22, openRate: 0.43, ctor: 0.13, hbRate: 0.004, sbRate: 0.010, incidentDay: null } },
  { id: '103', name: 'Email 3 — Invitation appel', automationId: '1', sim: { baseRate: 18, openRate: 0.38, ctor: 0.21, hbRate: 0.003, sbRate: 0.009, incidentDay: null } },
  { id: '201', name: 'Onboarding — Jour 1', automationId: '2', sim: { baseRate: 6, openRate: 0.61, ctor: 0.24, hbRate: 0.002, sbRate: 0.006, incidentDay: null } },
];

const dataset = {
  v: 1,
  demo: true,
  generatedAt: now,
  cols: COLS,
  automations: [
    { id: '1', name: 'Séquence prospection' },
    { id: '2', name: 'Onboarding clients' },
  ],
  campaigns: emails.map(({ id, name, automationId }) => ({
    id, name, automationId,
    automationName: automationId === '1' ? 'Séquence prospection' : 'Onboarding clients',
    sdate: new Date(start * 1000).toISOString(),
  })),
  series: Object.fromEntries(emails.map((e) => [e.id, simulate(e.sim)])),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(dataset));
const kb = Math.round(JSON.stringify(dataset).length / 1024);
console.log(`Démo générée : ${OUT} (${emails.length} emails, ${DAYS} jours, ~${kb} Ko)`);
