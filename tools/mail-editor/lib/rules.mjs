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
  'en direct', 'live',
];

// Lexique autorisé pour remplacer « (en) direct » : moment ensemble, ambigu.
export const DIRECT_LEXICON = [
  'lancement', 'show', 'programme', 'session', 'événement',
  'rendez-vous', 'moment ensemble', 'grand moment',
];

const RE_LIVE = /\blive\b/gi;
// « direct » substantif/adjectif ; \b exclut déjà directement/directeur/direction.
const RE_DIRECT = /\bdirect(?:e|s|es)?\b/gi;

/** Applique au remplacement la casse du mot d'origine (Live → Session). */
export function matchCase(original, replacement) {
  if (original === original.toUpperCase() && /[A-ZÀ-Ý]/.test(original)) return replacement.toUpperCase();
  if (/^[A-ZÀ-Ý]/.test(original)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

// Accords masculin (live) → féminin (session) pour le déterminant qui précède.
const FEM_DETERMINERS = [
  [/\b(le)\s+$/i, 'la '], [/\b(un)\s+$/i, 'une '], [/\b(ce)\s+$/i, 'cette '],
  [/\b(du)\s+$/i, 'de la '], [/\b(au)\s+$/i, 'à la '], [/\b(mon)\s+$/i, 'ma '],
  [/\b(ton)\s+$/i, 'ta '], [/\b(son)\s+$/i, 'sa '],
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
    const enDirect = /\ben\s+$/i.test(before);
    // « réponse directe », « accès direct », « virement direct »… : probable
    // faux positif quand « direct » suit un nom sans « en » — confiance basse,
    // proposition par défaut « ne pas toucher », le LLM/la revue tranchent.
    const confidence = enDirect ? 'high' : 'low';
    let proposal;
    if (enDirect) {
      // « en direct » entier → « en live » est interdit ; heuristique simple :
      // « je suis en direct » → « le show est lancé » demande le LLM. Par
      // défaut : remplacer « en direct » par « avec vous » (moment partagé).
      const pStart = start - (before.length - before.search(/\ben\s+$/i));
      proposal = { start: pStart, end, replacement: 'avec vous' };
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

/** Vérifie qu'un remplacement ne réintroduit pas un terme interdit. */
export function violatesLexicon(replacement) {
  return FORBIDDEN_IN_REPLACEMENT.filter((w) => {
    const esc = w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}])${esc}(?![\\p{L}])`, 'iu').test(replacement);
  });
}
