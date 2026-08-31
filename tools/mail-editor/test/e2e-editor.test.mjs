/**
 * Test de bout en bout du cœur extraction → règles → application, contre une
 * page qui simule l'éditeur AC (contenteditable + formatage + iframe + champ
 * objet). Vérifie surtout que le HTML autour des remplacements est intact.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { extractBlocks, applyBlock } from '../lib/editor.mjs';
import { concatText, applyEdits } from '../lib/textmap.mjs';
import { findOccurrences } from '../lib/rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(join(HERE, 'fixtures', 'mock-editor.html')).href;

async function launch() {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  }
}

test('extraction, remplacement et préservation du formatage', async () => {
  const browser = await launch();
  const page = await browser.newPage();
  await page.goto(FIXTURE);
  await page.waitForLoadState('networkidle');

  const blocks = await extractBlocks(page);

  // 3 blocs riches de la page (le span imbriqué ne compte pas), 1 dans
  // l'iframe, 1 champ objet.
  const rich = blocks.filter((b) => b.type === 'rich');
  const fields = blocks.filter((b) => b.type === 'field');
  assert.equal(rich.length, 4, `blocs riches attendus : 4, obtenus : ${rich.length}`);
  assert.equal(fields.length, 1);
  assert.match(concatText(fields[0].nodes), /live VIP en direct/);

  const blockA = rich.find((b) => concatText(b.nodes).includes('de lancement'));
  const blockB = rich.find((b) => concatText(b.nodes).includes('VIP maintenant'));
  const blockIframe = rich.find((b) => concatText(b.nodes).includes("Dans l'iframe"));
  assert.ok(blockA && blockB && blockIframe, 'blocs attendus non trouvés');

  // — Bloc A : « en direct » (dans <strong>) et « live » (dans <a><em>).
  const textA = concatText(blockA.nodes);
  const occA = findOccurrences(textA);
  assert.deepEqual(occA.map((o) => o.kind).sort(), ['direct', 'live']);
  const editsA = occA.map((o) => ({ ...o.proposal }));
  const updatedA = applyEdits(blockA.nodes, editsA);
  const resA = await applyBlock(page, blockA, updatedA);
  assert.equal(resA.ok, true, resA.reason);

  const htmlA = await page.locator('#block-a').innerHTML();
  assert.match(htmlA, /<strong>avec vous<\/strong>/, 'le gras doit être conservé sur le remplacement');
  assert.match(htmlA, /<a href="https:\/\/example\.com"><em>rendez-vous<\/em><\/a>/, 'le lien et l\'italique doivent être conservés');
  assert.doesNotMatch(htmlA, /\blive\b|en direct/i);

  // — Bloc B : « le live VIP » chevauche <strong> ; accord le→la.
  const textB = concatText(blockB.nodes);
  const occB = findOccurrences(textB);
  const vip = occB.find((o) => o.kind === 'live_vip');
  assert.ok(vip, '« live VIP » doit être détecté');
  assert.equal(textB.slice(vip.proposal.start, vip.proposal.end), 'le live');
  assert.equal(vip.proposal.replacement, 'la session');
  // « réponse directe » : confiance basse → non appliqué.
  const lowConf = occB.find((o) => o.kind === 'direct');
  assert.equal(lowConf.confidence, 'low');
  const updatedB = applyEdits(blockB.nodes, [{ ...vip.proposal }]);
  const resB = await applyBlock(page, blockB, updatedB);
  assert.equal(resB.ok, true, resB.reason);
  const htmlB = await page.locator('#block-b').innerHTML();
  assert.match(htmlB, /Rejoins la <strong>session<\/strong> VIP maintenant/, 'remplacement chevauchant : « la session » hérite de la position, VIP suit');
  assert.match(htmlB, /réponse directe garantie/, '« réponse directe » ne doit pas être modifié');

  // — Bloc iframe : « en direct » dans <b>.
  const textI = concatText(blockIframe.nodes);
  const occI = findOccurrences(textI);
  assert.equal(occI.length, 1);
  const updatedI = applyEdits(blockIframe.nodes, [{ ...occI[0].proposal }]);
  const resI = await applyBlock(page, blockIframe, updatedI);
  assert.equal(resI.ok, true, resI.reason);
  const htmlI = await page.frameLocator('#inner').locator('[contenteditable]').innerHTML();
  assert.match(htmlI, /on est <b>avec vous<\/b>/);

  // — Champ objet : remplacement complet de la valeur + événement input.
  const subject = fields[0];
  const resS = await applyBlock(page, subject, ['Ce soir : session VIP avec toi']);
  assert.equal(resS.ok, true, resS.reason);
  assert.equal(await page.locator('input[name="campaign_subject"]').inputValue(), 'Ce soir : session VIP avec toi');

  // Les événements input ont bien été émis (les frameworks type React les écoutent).
  const events = await page.evaluate(() => window.__inputEvents);
  assert.ok(events.includes('block-a') && events.includes('block-b') && events.includes('campaign_subject'),
    `événements input attendus, obtenus : ${JSON.stringify(events)}`);

  // — Garde-fou : application refusée si le contenu a changé depuis l'extraction.
  await page.locator('#block-a').evaluate((el) => { el.querySelector('strong').textContent = 'modifié entre-temps'; });
  const stale = await applyBlock(page, blockA, updatedA);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /changé depuis l'extraction/);

  await browser.close();
});
