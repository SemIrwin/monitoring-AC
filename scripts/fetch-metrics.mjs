#!/usr/bin/env node
/**
 * Collecteur de métriques ActiveCampaign.
 *
 * À chaque exécution :
 *   1. liste les automatisations et les campagnes (emails) via l'API v3 ;
 *   2. sélectionne les emails à suivre selon config.json ;
 *   3. ajoute un relevé horodaté des compteurs cumulés de chaque email
 *      dans data/snapshots/<campaignId>.ndjson (1 ligne JSON par relevé) ;
 *   4. compacte l'historique ancien (résolution 6 h puis 24 h) ;
 *   5. reconstruit site/data/dataset.json, consommé par le dashboard.
 *
 * Variables d'environnement requises :
 *   AC_API_URL  ex. https://moncompte.api-us1.com
 *   AC_API_KEY  clé API (Paramètres → Développeur)
 *
 * Le dataset publié ne contient NI l'URL du compte NI la clé API.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP_DIR = join(ROOT, 'data', 'snapshots');
const SITE_DATA_DIR = join(ROOT, 'site', 'data');
const DATASET_PATH = join(SITE_DATA_DIR, 'dataset.json');

// Colonnes d'un relevé, dans l'ordre du dataset compact.
// t        : horodatage du relevé (secondes Unix, UTC)
// send     : envois cumulés (send_amt)
// open_u   : ouvreurs uniques cumulés (uniqueopens)
// open_t   : ouvertures totales cumulées (opens)
// click_u  : cliqueurs uniques cumulés (subscriberclicks = contacts uniques ayant
//            cliqué ; uniquelinkclicks est dédupliqué PAR LIEN, pas par contact)
// click_t  : clics totaux cumulés (linkclicks)
// hb       : rebonds durs cumulés (hardbounces)
// sb       : rebonds doux cumulés (softbounces)
// unsub    : désabonnements cumulés (unsubscribes)
const COLS = ['t', 'send', 'open_u', 'open_t', 'click_u', 'click_t', 'hb', 'sb', 'unsub'];

function loadEnvFile() {
  // Support minimal d'un .env local (les CI passent par de vraies variables d'env).
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function loadConfig() {
  const defaults = {
    campaignIds: [],
    automationIds: [],
    automationEmailsOnly: true,
    fullResolutionDays: 21,
    sixHourResolutionDays: 90,
  };
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
    const cfg = { ...defaults };
    for (const k of Object.keys(defaults)) if (raw[k] !== undefined) cfg[k] = raw[k];
    cfg.campaignIds = (cfg.campaignIds || []).map(String);
    cfg.automationIds = (cfg.automationIds || []).map(String);
    return cfg;
  } catch (e) {
    console.warn(`config.json illisible (${e.message}), configuration par défaut utilisée.`);
    return defaults;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acGet(baseUrl, apiKey, path, params = {}) {
  const url = new URL(`/api/3/${path}`, baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'Api-Token': apiKey, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} sur ${path}`);
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status} sur ${path} — vérifier AC_API_URL / AC_API_KEY`);
      } else {
        return await res.json();
      }
    } catch (e) {
      if (String(e.message).includes('vérifier AC_API_URL')) throw e;
      lastErr = e;
    }
    await sleep(1000 * 2 ** (attempt - 1));
  }
  throw lastErr;
}

/** Récupère toutes les pages d'une collection (limit/offset). */
async function acGetAll(baseUrl, apiKey, path, collectionKey, extraParams = {}) {
  const limit = 100;
  const items = [];
  for (let offset = 0; ; offset += limit) {
    const page = await acGet(baseUrl, apiKey, path, { limit, offset, ...extraParams });
    const batch = page[collectionKey] || [];
    items.push(...batch);
    const total = Number(page.meta?.total ?? NaN);
    if (batch.length < limit || (Number.isFinite(total) && items.length >= total)) break;
    await sleep(250); // limite AC : 5 req/s
  }
  return items;
}

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};

function selectCampaigns(campaigns, config) {
  let list = campaigns;
  if (config.automationEmailsOnly) {
    list = list.filter((c) => c.seriesid && String(c.seriesid) !== '0');
  }
  if (config.automationIds.length > 0) {
    const wanted = new Set(config.automationIds);
    list = list.filter((c) => wanted.has(String(c.seriesid)));
  }
  if (config.campaignIds.length > 0) {
    const wanted = new Set(config.campaignIds);
    list = list.filter((c) => wanted.has(String(c.id)));
  }
  // Ignore les emails jamais envoyés (aucun compteur à suivre pour l'instant).
  return list.filter((c) => toInt(c.send_amt) > 0);
}

function snapshotRow(campaign, t) {
  return {
    t,
    send: toInt(campaign.send_amt),
    open_u: toInt(campaign.uniqueopens),
    open_t: toInt(campaign.opens),
    click_u: toInt(campaign.subscriberclicks),
    click_t: toInt(campaign.linkclicks),
    hb: toInt(campaign.hardbounces),
    sb: toInt(campaign.softbounces),
    unsub: toInt(campaign.unsubscribes),
    // Conservé dans l'historique brut pour vérification (unique par couple contact×lien).
    ulc: toInt(campaign.uniquelinkclicks),
  };
}

function readSnapshots(campaignId) {
  const file = join(SNAP_DIR, `${campaignId}.ndjson`);
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (Number.isFinite(row.t)) rows.push(row);
    } catch {
      // ligne corrompue : ignorée plutôt que de tout perdre
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

/**
 * Compactage : au-delà de `fullResolutionDays`, ne garde que le dernier relevé
 * de chaque case de 6 h ; au-delà de `sixHourResolutionDays`, de chaque case de 24 h.
 * Le premier relevé de la série est toujours conservé (point de départ du suivi).
 */
function compact(rows, config, now) {
  if (rows.length === 0) return rows;
  const DAY = 86400;
  const keep = new Map(); // clé de case → dernier relevé de la case
  for (const row of rows) {
    const age = now - row.t;
    let bucket;
    if (age <= config.fullResolutionDays * DAY) bucket = `f${row.t}`;
    else if (age <= config.sixHourResolutionDays * DAY) bucket = `s${Math.floor(row.t / (6 * 3600))}`;
    else bucket = `d${Math.floor(row.t / DAY)}`;
    keep.set(bucket, row);
  }
  const out = [...keep.values()].sort((a, b) => a.t - b.t);
  if (out[0].t !== rows[0].t) out.unshift(rows[0]);
  return out;
}

function writeSnapshots(campaignId, rows) {
  mkdirSync(SNAP_DIR, { recursive: true });
  const file = join(SNAP_DIR, `${campaignId}.ndjson`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  renameSync(tmp, file);
}

function buildDataset({ campaigns, automations, apiIds, now }) {
  const automationById = new Map(automations.map((a) => [String(a.id), a]));

  // Métadonnées des emails du dataset précédent : un email qui n'est plus renvoyé
  // par l'API (supprimé/archivé côté ActiveCampaign, ou exclu par un changement de
  // config) garde son historique et son nom dans le dashboard.
  let previous = new Map();
  try {
    const prev = JSON.parse(readFileSync(DATASET_PATH, 'utf8'));
    previous = new Map((prev.campaigns || []).map((c) => [String(c.id), c]));
  } catch { /* premier passage : pas de dataset précédent */ }

  const byId = new Map();
  for (const c of campaigns) {
    const id = String(c.id);
    const auto = automationById.get(String(c.seriesid));
    byId.set(id, {
      id,
      name: String(c.name || `Email ${id}`),
      automationId: c.seriesid ? String(c.seriesid) : null,
      automationName: auto ? String(auto.name) : null,
      sdate: c.sdate || null,
    });
  }
  const snapFiles = existsSync(SNAP_DIR) ? readdirSync(SNAP_DIR).filter((f) => f.endsWith('.ndjson')) : [];
  for (const f of snapFiles) {
    const id = f.slice(0, -'.ndjson'.length);
    if (byId.has(id)) continue;
    // Un email encore renvoyé par l'API mais absent de `campaigns` a été exclu
    // volontairement par config.json : on respecte l'exclusion. Seuls les emails
    // disparus de l'API (supprimés/archivés côté AC) gardent leur historique.
    if (apiIds.has(id)) continue;
    const old = previous.get(id);
    byId.set(id, {
      id,
      name: old ? String(old.name) : `Email ${id}`,
      automationId: old ? old.automationId : null,
      automationName: old ? old.automationName : null,
      sdate: old ? old.sdate : null,
    });
  }

  const outCampaigns = [];
  const series = {};
  for (const meta of byId.values()) {
    const rows = readSnapshots(meta.id);
    if (rows.length === 0) continue;
    outCampaigns.push(meta);
    series[meta.id] = rows.map((r) => COLS.map((k) => toInt(r[k])));
  }

  outCampaigns.sort((a, b) =>
    (a.automationName || '').localeCompare(b.automationName || '', 'fr') ||
    a.name.localeCompare(b.name, 'fr'));

  return {
    v: 1,
    generatedAt: now,
    cols: COLS,
    automations: [...new Map(outCampaigns
      .filter((c) => c.automationId)
      .map((c) => [c.automationId, { id: c.automationId, name: c.automationName || `Automatisation ${c.automationId}` }]),
    ).values()],
    campaigns: outCampaigns,
    series,
  };
}

function writeDataset(dataset) {
  mkdirSync(SITE_DATA_DIR, { recursive: true });
  const tmp = `${DATASET_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(dataset));
  renameSync(tmp, DATASET_PATH);
}

async function main() {
  loadEnvFile();
  const baseUrl = process.env.AC_API_URL;
  const apiKey = process.env.AC_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error('AC_API_URL et AC_API_KEY sont requis (secrets GitHub Actions ou fichier .env).');
    process.exit(1);
  }

  const config = loadConfig();
  const now = Math.floor(Date.now() / 1000);

  console.log('Récupération des automatisations…');
  const automations = await acGetAll(baseUrl, apiKey, 'automations', 'automations');
  console.log(`  ${automations.length} automatisation(s)`);

  console.log('Récupération des campagnes…');
  const allCampaigns = await acGetAll(baseUrl, apiKey, 'campaigns', 'campaigns');
  const tracked = selectCampaigns(allCampaigns, config);
  console.log(`  ${allCampaigns.length} campagne(s) au total, ${tracked.length} suivie(s)`);

  if (tracked.length === 0) {
    console.warn('Aucun email à suivre. Vérifier config.json (campaignIds / automationIds / automationEmailsOnly).');
  }

  for (const campaign of tracked) {
    const id = String(campaign.id);
    const rows = readSnapshots(id);
    const row = snapshotRow(campaign, now);
    rows.push(row);
    writeSnapshots(id, compact(rows, config, now));
    console.log(`  [${id}] ${campaign.name} — envois=${row.send} ouvreurs=${row.open_u} cliqueurs=${row.click_u} durs=${row.hb} doux=${row.sb}`);
  }

  const dataset = buildDataset({
    campaigns: tracked,
    automations,
    apiIds: new Set(allCampaigns.map((c) => String(c.id))),
    now,
  });
  writeDataset(dataset);
  console.log(`dataset.json généré (${dataset.campaigns.length} email(s), ${new Date(now * 1000).toISOString()}).`);
}

main().catch((e) => {
  console.error(`Échec du relevé : ${e.message}`);
  process.exit(1);
});
