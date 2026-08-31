#!/usr/bin/env node
/**
 * ac-mail-editor — réécriture assistée des mentions « live » / « direct »
 * dans les emails d'une automatisation ActiveCampaign.
 *
 * Pipeline (chaque étape écrit un fichier dans work/, relisible et rejouable) :
 *
 *   login    ouvre le navigateur pour se connecter à ActiveCampaign (session
 *            conservée dans work/browser-profile/)
 *   extract  liste les emails de l'automatisation (API) puis extrait le texte
 *            de chaque email via l'éditeur (Playwright)     → work/extraction.json
 *   propose  détecte live/direct et propose les réécritures
 *            (règles + LLM Claude si ANTHROPIC_API_KEY)      → work/proposals.json
 *   review   UI locale de validation occurrence par occurrence
 *                                                            → work/approved.json
 *   apply    applique les remplacements approuvés dans l'éditeur
 *            (nœuds texte uniquement : formatage intact)     → work/applied.json
 *   demo     fabrique une extraction d'exemple pour tester propose/review
 *            sans compte ActiveCampaign
 *
 * Rien n'est modifié dans ActiveCampaign sans passer par `review` puis
 * `apply` (et l'enregistrement reste manuel par défaut : on voit chaque
 * email modifié avant de cliquer Enregistrer).
 */

import { join } from 'node:path';
import { loadEnv, SHOTS_DIR } from './lib/env.mjs';
import { listAutomationEmails } from './lib/ac-api.mjs';
import { concatText, applyEdits } from './lib/textmap.mjs';
import { findOccurrences, violatesLexicon } from './lib/rules.mjs';
import { readStep, writeStep, FILES } from './lib/store.mjs';

const [, , command, ...rest] = process.argv;

function parseArgs(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i++; }
      else opts[key] = true;
    } else opts._.push(a);
  }
  return opts;
}
const opts = parseArgs(rest);

const USAGE = `Usage : node cli.mjs <commande> [options]

  login                                  se connecter à ActiveCampaign (session persistante)
  extract --automation <id|nom|url>      extraire le texte des emails de l'automatisation
          [--url-template "https://…/{id}/edit"]  navigation automatique (sinon assistée)
          [--headless]                   (déconseillé pour la première fois)
  propose [--no-llm] [--model <id>]      détecter et proposer les réécritures
  review  [--port 8940]                  ouvrir l'interface de validation
  apply   [--dry-run] [--email <id>]     appliquer les remplacements approuvés
  demo                                   extraction d'exemple (pour tester sans compte)

Variables : AC_API_URL, AC_API_KEY (API) · AC_ACCOUNT_URL (app, déduite sinon)
            ANTHROPIC_API_KEY, AC_EDITOR_MODEL (LLM, facultatif)`;

async function main() {
  switch (command) {
    case 'login': return cmdLogin();
    case 'extract': return cmdExtract();
    case 'propose': return cmdPropose();
    case 'review': return cmdReview();
    case 'apply': return cmdApply();
    case 'demo': return cmdDemo();
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
}

/* ------------------------------------------------------------------ login */

async function cmdLogin() {
  const env = loadEnv();
  const { launchBrowser, waitForEnter } = await import('./lib/browser.mjs');
  const { context, page } = await launchBrowser({ headless: false });
  const url = env.accountUrl || 'https://www.activecampaign.com/login';
  console.log(`Ouverture de ${url}…`);
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitForEnter('Connecte-toi à ActiveCampaign dans le navigateur (MFA compris), puis reviens ici.');
  console.log('Session enregistrée dans work/browser-profile/. Les prochaines commandes la réutiliseront.');
  await context.close();
}

/* ---------------------------------------------------------------- extract */

async function cmdExtract() {
  const env = loadEnv();
  const automationRef = opts.automation;
  if (!automationRef) {
    console.error('extract : préciser --automation <id|nom|url de l\'automatisation>');
    process.exit(1);
  }
  if (!env.apiUrl || !env.apiKey) {
    console.error('AC_API_URL et AC_API_KEY sont requis (mêmes valeurs que le monitoring, via .env).');
    process.exit(1);
  }

  console.log('Énumération des emails de l\'automatisation via l\'API…');
  const { automation, emails } = await listAutomationEmails(env.apiUrl, env.apiKey, automationRef);
  console.log(`Automatisation « ${automation.name} » (id ${automation.id}) : ${emails.length} email(s).`);
  if (emails.length === 0) {
    console.error('Aucun email trouvé pour cette automatisation.');
    process.exit(1);
  }

  const { launchBrowser, waitForEnter } = await import('./lib/browser.mjs');
  const { extractBlocks } = await import('./lib/editor.mjs');
  const { context, page } = await launchBrowser({ headless: Boolean(opts.headless) });

  const template = typeof opts['url-template'] === 'string' ? opts['url-template'] : null;
  const out = { automation, createdAt: new Date().toISOString(), emails: [] };

  for (const email of emails) {
    console.log(`\n— Email ${email.id} : ${email.name}`);
    if (template) {
      const url = template.replaceAll('{id}', email.id).replaceAll('{account}', env.accountUrl);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000); // laisser l'éditeur s'initialiser
    } else {
      if (out.emails.length === 0 && env.accountUrl) {
        await page.goto(env.accountUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      await waitForEnter(`Ouvre l'ÉDITEUR de l'email « ${email.name} » (automatisation « ${automation.name} ») dans le navigateur.`);
    }
    const blocks = await extractBlocks(page);
    const textBlocks = blocks.filter((b) => concatText(b.nodes).trim().length > 0);
    const shot = join(SHOTS_DIR, `extract-${email.id}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    console.log(`  ${textBlocks.length} bloc(s) de texte extraits (capture : ${shot})`);
    out.emails.push({ ...email, url: page.url(), blocks: textBlocks, screenshot: shot });
  }

  const file = writeStep('extraction', out);
  console.log(`\nExtraction écrite dans ${file}. Étape suivante : node cli.mjs propose`);
  await context.close();
}

/* ---------------------------------------------------------------- propose */

async function cmdPropose() {
  const env = loadEnv();
  const extraction = readStep('extraction');
  if (!extraction) {
    console.error(`Pas d'extraction (${FILES.extraction}). Lancer d'abord : node cli.mjs extract (ou demo).`);
    process.exit(1);
  }

  const emails = [];
  const llmItems = [];
  for (const email of extraction.emails) {
    const blocks = [];
    for (const block of email.blocks) {
      const text = concatText(block.nodes);
      const found = findOccurrences(text);
      if (found.length === 0) continue;
      const occurrences = found.map((o, i) => {
        const id = `em${email.id}:${block.blockId}:o${i}`;
        const occ = {
          id, ...o,
          source: 'heuristic',
          note: o.note || '',
          approved: o.confidence === 'high' && !o.needsLlm,
        };
        if (o.needsLlm || o.confidence === 'low') {
          llmItems.push({
            id, kind: o.kind, matched: o.matched, sentence: o.sentence,
            heuristic: text.slice(o.proposal.start, o.proposal.end) + ' → ' + o.proposal.replacement,
            _blockRef: { emailId: email.id, blockId: block.blockId },
          });
        }
        return occ;
      });
      blocks.push({ ...block, text, occurrences });
    }
    emails.push({ id: email.id, name: email.name, url: email.url || null, screenshot: email.screenshot || null, blocks });
  }

  const totalOcc = emails.reduce((n, e) => n + e.blocks.reduce((m, b) => m + b.occurrences.length, 0), 0);
  console.log(`${totalOcc} occurrence(s) détectée(s) dans ${emails.filter((e) => e.blocks.length).length} email(s).`);

  const useLlm = !opts['no-llm'] && env.anthropicKey && llmItems.length > 0;
  if (useLlm) {
    const model = typeof opts.model === 'string' ? opts.model : env.model;
    console.log(`Raffinement LLM (${model}) de ${llmItems.length} occurrence(s)…`);
    const { proposeWithLlm, locateFragment } = await import('./lib/llm.mjs');
    const BATCH = 20;
    for (let i = 0; i < llmItems.length; i += BATCH) {
      const batch = llmItems.slice(i, i + BATCH);
      let results;
      try {
        results = await proposeWithLlm({ apiKey: env.anthropicKey, model, items: batch });
      } catch (e) {
        console.error(`  [llm] lot ${i / BATCH + 1} en échec (${e.message}) — heuristiques conservées.`);
        continue;
      }
      for (const item of batch) {
        const r = results.get(item.id);
        if (!r) continue;
        const email = emails.find((e) => String(e.id) === String(item._blockRef.emailId));
        const block = email?.blocks.find((b) => b.blockId === item._blockRef.blockId);
        const occ = block?.occurrences.find((o) => o.id === item.id);
        if (!occ) continue;
        if (r.action === 'keep') {
          occ.source = 'llm';
          occ.note = r.note || 'Faux positif selon le LLM.';
          occ.approved = false;
          occ.keep = true;
          continue;
        }
        const loc = locateFragment(block.text, r.before, occ.start);
        if (!loc) {
          occ.note = `Fragment LLM introuvable dans le bloc (« ${r.before.slice(0, 60)} ») — heuristique conservée.`;
          continue;
        }
        // Le fragment relocalisé doit COUVRIR l'occurrence : sinon le mot
        // visé survivrait au remplacement (ex. before = un bout de phrase
        // voisin). Dans ce cas, heuristique conservée.
        if (!(loc.start <= occ.start && loc.end >= occ.end)) {
          occ.note = `Fragment LLM (« ${r.before.slice(0, 60)} ») ne couvre pas « ${occ.matched} » — heuristique conservée.`;
          continue;
        }
        occ.proposal = { start: loc.start, end: loc.end, replacement: r.after };
        occ.source = 'llm';
        occ.note = r.note || '';
        occ.approved = true;
      }
      console.log(`  lot ${Math.floor(i / BATCH) + 1}/${Math.ceil(llmItems.length / BATCH)} traité`);
    }
  } else if (!opts['no-llm'] && llmItems.length > 0) {
    console.log('ANTHROPIC_API_KEY absent : heuristiques seules. Les cas « direct » et accords fins sont à revoir dans l\'UI.');
  }

  // Chevauchements : si le LLM a élargi un fragment jusqu'à recouvrir une
  // occurrence voisine (« live » et « direct » dans la même phrase), on ne
  // garde approuvée que la première proposition — l'autre est à départager
  // dans l'UI, sinon `apply` devrait en jeter une arbitrairement.
  for (const email of emails) {
    for (const block of email.blocks) {
      const sorted = [...block.occurrences].sort((a, b) => a.proposal.start - b.proposal.start);
      let prevEnd = -1;
      for (const occ of sorted) {
        if (occ.proposal.start < prevEnd && occ.approved) {
          occ.approved = false;
          occ.note = `⚠ chevauche la proposition précédente (même passage de phrase) — départager à la main. ${occ.note}`;
        }
        prevEnd = Math.max(prevEnd, occ.proposal.end);
      }
    }
  }

  // Filet de sécurité : aucune proposition ne doit réintroduire live/direct/rediffusion.
  for (const email of emails) {
    for (const block of email.blocks) {
      for (const occ of block.occurrences) {
        const bad = violatesLexicon(occ.proposal.replacement);
        if (occ.proposal.replacement !== block.text.slice(occ.proposal.start, occ.proposal.end) && bad.length > 0) {
          occ.approved = false;
          occ.note = `⚠ terme interdit dans la proposition (${bad.join(', ')}) — à corriger à la main. ${occ.note}`;
        }
      }
    }
  }

  const file = writeStep('proposals', {
    automation: extraction.automation,
    createdAt: new Date().toISOString(),
    llm: useLlm ? (typeof opts.model === 'string' ? opts.model : env.model) : null,
    emails,
  });
  console.log(`Propositions écrites dans ${file}. Étape suivante : node cli.mjs review`);
}

/* ----------------------------------------------------------------- review */

async function cmdReview() {
  const proposals = readStep('proposals');
  if (!proposals) {
    console.error(`Pas de propositions (${FILES.proposals}). Lancer d'abord : node cli.mjs propose`);
    process.exit(1);
  }
  const { startReviewServer } = await import('./review/server.mjs');
  const port = Number(opts.port) || 8940;
  await startReviewServer({ port, proposals });
}

/* ------------------------------------------------------------------ apply */

async function cmdApply() {
  const proposals = readStep('proposals');
  if (!proposals) {
    console.error('Pas de propositions. Lancer : extract → propose → review.');
    process.exit(1);
  }
  const approved = readStep('approved');
  if (!approved) {
    console.error(`Pas de décisions (${FILES.approved}). Valider d'abord dans l'UI : node cli.mjs review`);
    process.exit(1);
  }

  if (opts.email === true) {
    console.error('apply : --email attend un id d\'email (ex. --email 123).');
    process.exit(1);
  }

  // Les décisions doivent avoir été prises sur CES propositions : des ids
  // positionnels (o0, o1…) issus d'une autre extraction se rebrancheraient
  // silencieusement sur d'autres occurrences.
  if (approved.proposalsCreatedAt && proposals.createdAt && approved.proposalsCreatedAt !== proposals.createdAt) {
    console.error('Les décisions (work/approved.json) ont été prises sur une AUTRE version des propositions.');
    console.error('Refaire la validation : node cli.mjs review');
    process.exit(1);
  }

  const decisions = approved.decisions || {};
  const emailFilter = typeof opts.email === 'string' ? String(opts.email) : null;
  const plan = [];
  let approvedCount = 0;
  let skipped = 0;
  for (const email of proposals.emails) {
    if (emailFilter && String(email.id) !== emailFilter) continue;
    const blockEdits = [];
    for (const block of email.blocks) {
      const edits = [];
      for (const occ of block.occurrences) {
        const d = decisions[occ.id];
        if (!d || !d.approved) continue;
        approvedCount++;
        // Empreinte : le fragment que l'utilisateur a validé doit encore
        // correspondre au texte visé par la proposition.
        const current = block.text.slice(occ.proposal.start, occ.proposal.end);
        if (typeof d.before === 'string' && d.before !== current) {
          console.error(`  ⚠ ${occ.id} : le passage validé (« ${d.before} ») ne correspond plus (« ${current} ») — occurrence sautée, revalider dans l'UI.`);
          skipped++;
          continue;
        }
        const replacement = typeof d.replacement === 'string' ? d.replacement : occ.proposal.replacement;
        edits.push({ start: occ.proposal.start, end: occ.proposal.end, replacement, occId: occ.id });
      }
      if (edits.length === 0) continue;
      // Chevauchements résiduels : on garde la première proposition et on
      // saute les suivantes (au lieu de perdre le bloc entier).
      edits.sort((a, b) => a.start - b.start);
      const kept = [];
      let prevEnd = -1;
      for (const e of edits) {
        if (e.start < prevEnd) {
          console.error(`  ⚠ ${e.occId} : chevauche un remplacement précédent — occurrence sautée.`);
          skipped++;
          continue;
        }
        kept.push(e);
        prevEnd = e.end;
      }
      if (kept.length === 0) continue;
      let updatedTexts;
      try {
        updatedTexts = applyEdits(block.nodes, kept);
      } catch (e) {
        console.error(`  ⚠ ${email.id}/${block.blockId} : édits invalides (${e.message}) — bloc sauté.`);
        skipped += kept.length;
        continue;
      }
      blockEdits.push({ block, edits: kept, updatedTexts });
    }
    if (blockEdits.length > 0) plan.push({ email, blockEdits });
  }

  if (plan.length === 0) {
    console.log(approvedCount === 0
      ? 'Rien à appliquer : aucune occurrence approuvée.'
      : `Rien à appliquer : les ${approvedCount} occurrence(s) approuvée(s) ont toutes été sautées (voir les avertissements ci-dessus).`);
    return;
  }
  if (skipped > 0) console.log(`⚠ ${skipped} occurrence(s) approuvée(s) sautée(s) — voir les avertissements ci-dessus.`);

  console.log(`À appliquer : ${plan.length} email(s), ${plan.reduce((n, p) => n + p.blockEdits.reduce((m, b) => m + b.edits.length, 0), 0)} remplacement(s).`);
  for (const { email, blockEdits } of plan) {
    console.log(`\n— ${email.name} (id ${email.id})`);
    for (const { block, edits } of blockEdits) {
      for (const e of edits) {
        const before = concatText(block.nodes).slice(e.start, e.end);
        console.log(`    « ${before} » → « ${e.replacement} »`);
      }
    }
  }
  if (opts['dry-run']) {
    console.log('\n--dry-run : aucune modification effectuée.');
    return;
  }

  const { launchBrowser, waitForEnter } = await import('./lib/browser.mjs');
  const { applyBlock } = await import('./lib/editor.mjs');
  const { context, page } = await launchBrowser({ headless: false });
  const report = { appliedAt: new Date().toISOString(), emails: [] };

  for (const { email, blockEdits } of plan) {
    console.log(`\n— Email ${email.id} : ${email.name}`);
    if (email.url && email.url !== 'about:blank') {
      await page.goto(email.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(4000);
    }
    await waitForEnter(`Vérifie que l'ÉDITEUR de « ${email.name} » est bien ouvert (même écran qu'à l'extraction).`);

    const results = [];
    for (const { block, edits, updatedTexts } of blockEdits) {
      const res = await applyBlock(page, block, updatedTexts);
      results.push({ blockId: block.blockId, edits: edits.map((e) => e.occId), ...res });
      console.log(`  ${res.ok ? '✓' : '✗'} ${block.blockId}${res.ok ? '' : ` — ${res.reason}`}`);
    }
    const shot = join(SHOTS_DIR, `apply-${email.id}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    const okCount = results.filter((r) => r.ok).length;
    console.log(`  ${okCount}/${results.length} bloc(s) modifié(s). Capture : ${shot}`);
    if (okCount > 0) {
      await waitForEnter('Relis le rendu dans l\'éditeur puis ENREGISTRE l\'email dans ActiveCampaign.');
    }
    report.emails.push({ id: email.id, name: email.name, results, screenshot: shot });
  }

  const file = writeStep('applied', report);
  console.log(`\nRapport écrit dans ${file}.`);
  await context.close();
}

/* ------------------------------------------------------------------- demo */

async function cmdDemo() {
  loadEnv();
  const demo = {
    automation: { id: 'demo', name: 'Séquence de démonstration' },
    createdAt: new Date().toISOString(),
    demo: true,
    emails: [
      {
        id: 'd1', name: 'J-1 — Rappel', url: null, screenshot: null,
        blocks: [
          {
            blockId: 'rich:demo#0', type: 'rich', domIndex: 0, frame: 'demo', label: 'corps',
            nodes: [
              { text: 'Demain soir, je suis ' }, { text: 'en direct' },
              { text: ' avec toi pour le ' }, { text: 'live' }, { text: ' de lancement.' },
            ],
          },
          {
            blockId: 'rich:demo#1', type: 'rich', domIndex: 1, frame: 'demo', label: 'PS',
            nodes: [{ text: 'PS : réponse directe à ce mail si tu as une question.' }],
          },
        ],
      },
      {
        id: 'd2', name: 'Jour J — On y est', url: null, screenshot: null,
        blocks: [
          {
            blockId: 'rich:demo#0', type: 'rich', domIndex: 0, frame: 'demo', label: 'corps',
            nodes: [
              { text: 'Ça y est, on est en direct ! Rejoins le ' },
              { text: 'Live' }, { text: ' VIP maintenant — le ' },
              { text: 'live' }, { text: ' n\'attend que toi.' },
            ],
          },
        ],
      },
    ],
  };
  const file = writeStep('extraction', demo);
  console.log(`Extraction de démonstration écrite dans ${file}.`);
  console.log('Essayer ensuite : node cli.mjs propose --no-llm  puis  node cli.mjs review');
}

main().catch((e) => {
  console.error(`Échec : ${e.message}`);
  process.exit(1);
});
