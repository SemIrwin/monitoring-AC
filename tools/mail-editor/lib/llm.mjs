/**
 * Propositions de réécriture par LLM (Claude).
 *
 * L'heuristique de lib/rules.mjs fournit un candidat par occurrence ; le LLM
 * raffine : accords en genre/nombre autour de « session », réécriture des
 * « en direct » (« je suis en direct » → « le show est lancé »…), détection
 * des faux positifs (« réponse directe » → keep).
 *
 * Contrat de sortie par occurrence : un fragment AVANT (verbatim, présent
 * dans la phrase) et un fragment APRÈS. Le fragment est relocalisé dans le
 * texte du bloc par recherche exacte autour de l'occurrence — jamais de
 * régénération du texte entier, le formatage reste intact.
 */

import Anthropic from '@anthropic-ai/sdk';
import { DIRECT_LEXICON, FORBIDDEN_IN_REPLACEMENT, violatesLexicon } from './rules.mjs';

const SYSTEM = `Tu réécris des fragments d'emails marketing en français pour une automatisation.
Objectif : supprimer toute mention de « live » ou de « direct » en gardant l'ambiguïté d'un moment vécu ensemble.

Règles impératives :
1. « live » suivi de « vip » → « session » (accorde le déterminant et les adjectifs autour : le→la, un→une, ce→cette, du→de la, au→à la, etc.). Le mot « vip » reste.
2. « live » non suivi de « vip » → « rendez-vous » (accords si nécessaire).
3. « direct » au sens diffusion (« en direct », « je suis en direct », « on est en direct ») → reformule avec un mot du lexique : ${DIRECT_LEXICON.join(', ')}. La phrase doit donner l'impression d'un moment partagé, présent, SANS affirmer que c'est du direct et SANS laisser deviner une rediffusion.
4. INTERDITS dans tes réécritures : ${FORBIDDEN_IN_REPLACEMENT.join(', ')} (et toute formule qui trahit un enregistrement : « c'était », « revoyez », « replay »…). Garde le présent et l'invitation.
5. « direct » dans un autre sens (« réponse directe », « accès direct », « virement direct », prénom, nom propre) → action "keep".
6. Modifie le MINIMUM de texte : le fragment "before" doit être le plus court possible tout en permettant une phrase correcte après remplacement. Il doit être copié VERBATIM depuis la phrase fournie (mêmes espaces, même casse, mêmes apostrophes).
7. Conserve le ton, le tutoiement/vouvoiement et la ponctuation d'origine.

Réponds UNIQUEMENT avec un tableau JSON, sans texte autour :
[{"id": "<id>", "action": "replace"|"keep", "before": "<fragment verbatim>", "after": "<fragment réécrit>", "note": "<justification en 1 phrase>"}]
Pour "keep", omets before/after.`;

/**
 * items : [{ id, kind, matched, sentence, heuristic }]
 * Retourne Map id → { action, before, after, note }.
 */
export async function proposeWithLlm({ apiKey, model, items, log = console.error }) {
  const client = new Anthropic({ apiKey });
  const user = items.map((it) => JSON.stringify({
    id: it.id,
    type: it.kind,
    mot: it.matched,
    phrase: it.sentence,
    proposition_heuristique: it.heuristic,
  })).join('\n');

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: 'user', content: `Occurrences à traiter (une par ligne) :\n${user}` }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Le modèle a décliné la demande${response.stop_details?.explanation ? ` : ${response.stop_details.explanation}` : ''}.`);
  }

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJsonArray(text);
  const out = new Map();
  for (const row of parsed) {
    if (!row || typeof row.id !== 'string') continue;
    if (row.action === 'replace') {
      if (typeof row.before !== 'string' || typeof row.after !== 'string' || !row.before) {
        log(`  [llm] réponse incomplète pour ${row.id}, ignorée`);
        continue;
      }
      const bad = violatesLexicon(row.after);
      if (bad.length > 0) {
        log(`  [llm] proposition pour ${row.id} rejetée (termes interdits : ${bad.join(', ')})`);
        continue;
      }
    }
    out.set(row.id, { action: row.action === 'keep' ? 'keep' : 'replace', before: row.before, after: row.after, note: row.note || '' });
  }
  return out;
}

function parseJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error(`Réponse LLM sans tableau JSON : ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Relocalise un fragment « before » dans le texte du bloc, au plus près de
 * l'occurrence (offset `near`). Retourne { start, end } ou null.
 */
export function locateFragment(blockText, before, near) {
  if (!before) return null;
  let best = null;
  let idx = blockText.indexOf(before);
  while (idx !== -1) {
    if (best === null || Math.abs(idx - near) < Math.abs(best - near)) best = idx;
    idx = blockText.indexOf(before, idx + 1);
  }
  if (best === null) return null;
  return { start: best, end: best + before.length };
}
