/**
 * Détection des mentions « live » / « direct » et propositions de
 * remplacement heuristiques.
 *
 * Règles métier (demandées par Sem) :
 *   1. « live » suivi de « vip »       → « session » (féminin : accorder
 *      l'article/adjectifs autour — heuristique ici, LLM pour les cas fins).
 *   2. « live » seul                    → « rendez-vous » (masculin, accords
 *      généralement inchangés).
 *   3. « direct » (« en direct », « je suis en direct »…) → réécriture
 *      cas par cas (lexique : lancement, show, programme, session,
 *      événement…) qui évoque un moment partagé SANS affirmer le direct
 *      ni laisser deviner une rediffusion. L'heuristique propose un
 *      candidat ; le LLM (lib/llm.mjs) raffine la phrase.
 *
 * Toute occurrence part dans l'UI de revue : rien n'est appliqué sans
 * validation. Les faux positifs probables (« réponse directe », « direction »)
 * sont soit exclus, soit marqués `confidence: 'low'`.
 */

import { sentenceAround } from './textmap.mjs';

export const FORBIDDEN_IN_REPLACEMENT = [
  'rediffusion', 'replay', 'rediff', 'enregistré', 'enregistrement',
  'en direct', 'direct', 'directe', 'live',
];

// Lexique autorisé pour remplacer « (en) direct » : moment ensemble, ambigu.
export const DIRECT_LEXICON = [
  'lancement', 'show', 'programme', 'session', 'événement',
  'rendez-vous', 'moment ensemble', 'grand moment',
];

// \b est ASCII et voit une frontière entre « è » et « l » (clientèle, modèle…) :
// on utilise des lookarounds Unicode pour de vraies frontières de mots français.
const RE_LIVE = /(?<![\p{L}])live(?![\p{L}])/giu;
// « direct » substantif/adjectif ; les lookarounds excluent directement/directeur/direction.
const RE_DIRECT = /(?<![\p{L}])direct(?:e|s|es)?(?![\p{L}])/giu;

/**
 * Le mot fait-il partie d'une URL ou d'un mot composé (« live-stream »,
 * « exemple.com/live/vip ») ? Dans ce cas le remplacer casserait un lien ou
 * un nom : on le signale mais on ne propose rien par défaut.
 */
function inUrlOrCompound(text, start, end) {
  if (text[start - 1] === '-' || text[end] === '-') return true;
  let ts = start;
  while (ts > 0 && !/\s/.test(text[ts - 1])) ts--;
  let te = end;
  while (te < text.length && !/\s/.test(text[te])) te++;
  const token = text.slice(ts, te);
  return /[/@]|:\/\/|www\.|\.[a-z]{2,}(\/|$)/i.test(token);
}

/** Applique au remplacement la casse du mot d'origine (Live → Session). */
export function matchCase(original, replacement) {
  if (original === original.toUpperCase() && /[A-ZÀ-Ý]/.test(original)) return replacement.toUpperCase();
  if (/^[A-ZÀ-Ý]/.test(original)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

// Accords masculin (live) → féminin (session) pour le déterminant qui précède.
// Lookbehind Unicode obligatoire : avec \b, « clientèle live » verrait un
// déterminant « le » à la fin de « clientèle ».
const FEM_DETERMINERS = [
  [/(?<![\p{L}])(le)\s+$/iu, 'la '], [/(?<![\p{L}])(un)\s+$/iu, 'une '],
  [/(?<![\p{L}])(ce)\s+$/iu, 'cette '], [/(?<![\p{L}])(du)\s+$/iu, 'de la '],
  [/(?<![\p{L}])(au)\s+$/iu, 'à la '], [/(?<![\p{L}])(mon)\s+$/iu, 'ma '],
  [/(?<![\p{L}])(ton)\s+$/iu, 'ta '], [/(?<![\p{L}])(son)\s+$/iu, 'sa '],
];

/**
 * Détecte les occurrences dans un texte à plat.
 * Retourne [{ kind, start, end, matched, sentence, confidence, proposal, needsLlm }].
 * `proposal` est l'heuristique : { start, end, replacement } (offsets texte),
 * potentiellement élargie au déterminant pour les accords.
 */
export function findOccurrences(text) {
  const occ = [];

  for (const m of text.matchAll(RE_LIVE)) {
    const start = m.index;
    const end = start + m[0].length;
    const after = text.slice(end);
    const vip = after.match(/^(\s+|[\s-]*)vip\b/i);
    const sentence = sentenceAround(text, start, end);
    if (inUrlOrCompound(text, start, end)) {
      occ.push({
        kind: 'live', start, end, matched: m[0],
        sentence: sentence.text, confidence: 'low', needsLlm: false,
        note: 'URL ou mot composé : remplacer casserait un lien/un nom — à traiter à la main.',
        proposal: { start, end, replacement: m[0] },
      });
      continue;
    }
    if (vip) {
      // « live vip » → « session vip » ; accord du déterminant qui précède.
      const before = text.slice(Math.max(0, start - 12), start);
      let pStart = start;
      let replacement = matchCase(m[0], 'session');
      for (const [re, fem] of FEM_DETERMINERS) {
        const dm = before.match(re);
        if (dm) {
          pStart = start - (before.length - before.search(re));
          const det = text.slice(pStart, start);
          replacement = matchCase(det, fem) + matchCase(m[0], 'session');
          break;
        }
      }
      occ.push({
        kind: 'live_vip', start, end, matched: m[0],
        sentence: sentence.text, confidence: 'high', needsLlm: true,
        proposal: { start: pStart, end, replacement },
      });
    } else {
      occ.push({
        kind: 'live', start, end, matched: m[0],
        sentence: sentence.text, confidence: 'high', needsLlm: false,
        proposal: { start, end, replacement: matchCase(m[0], 'rendez-vous') },
      });
    }
  }

  for (const m of text.matchAll(RE_DIRECT)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = text.slice(Math.max(0, start - 40), start);
    const sentence = sentenceAround(text, start, end);
    if (inUrlOrCompound(text, start, end)) {
      occ.push({
        kind: 'direct', start, end, matched: m[0],
        sentence: sentence.text, confidence: 'low', needsLlm: false,
        note: 'URL ou mot composé : remplacer casserait un lien/un nom — à traiter à la main.',
        proposal: { start, end, replacement: m[0] },
      });
      continue;
    }
    const enDirect = /(?<![\p{L}])en\s+$/iu.test(before);
    // « réponse directe », « accès direct », « virement direct »… : probable
    // faux positif quand « direct » suit un nom sans « en » — confiance basse,
    // proposition par défaut « ne pas toucher », le LLM/la revue tranchent.
    const confidence = enDirect ? 'high' : 'low';
    let proposal;
    if (enDirect) {
      // « en direct » entier → « en live » est interdit ; heuristique simple :
      // « je suis en direct » → « le show est lancé » demande le LLM. Par
      // défaut : remplacer « en direct » par « avec vous » (moment partagé).
      const pStart = start - (before.length - before.search(/(?<![\p{L}])en\s+$/iu));
      proposal = { start: pStart, end, replacement: matchCase(text.slice(pStart, end), 'avec vous') };
    } else {
      proposal = { start, end, replacement: m[0] }; // no-op tant que non confirmé
    }
    occ.push({
      kind: 'direct', start, end, matched: m[0],
      sentence: sentence.text, confidence, needsLlm: true, proposal,
    });
  }

  occ.sort((a, b) => a.start - b.start);
  return occ;
}

/**
 * Vérifie qu'un remplacement ne réintroduit pas un terme interdit.
 * Les espaces sont normalisés (insécables, doubles) avant comparaison et les
 * expressions multi-mots tolèrent n'importe quel blanc entre les mots.
 */
export function violatesLexicon(replacement) {
  return FORBIDDEN_IN_REPLACEMENT.filter((w) => {
    const esc = w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/ /g, '\\s+');
    return new RegExp(`(?<![\\p{L}])${esc}(?![\\p{L}])`, 'iu').test(replacement);
  });
}
