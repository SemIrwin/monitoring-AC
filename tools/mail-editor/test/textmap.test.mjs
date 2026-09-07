import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, concatText, nodeOffsets, sentenceAround, splitEditByTokens } from '../lib/textmap.mjs';

const nodes = (...texts) => texts.map((text) => ({ text }));

test('concatText et nodeOffsets', () => {
  const ns = nodes('abc', '', 'de');
  assert.equal(concatText(ns), 'abcde');
  assert.deepEqual(nodeOffsets(ns), [
    { start: 0, end: 3 }, { start: 3, end: 3 }, { start: 3, end: 5 },
  ]);
});

test('remplacement contenu dans un seul nœud', () => {
  const ns = nodes('je suis en direct ce soir');
  const out = applyEdits(ns, [{ start: 8, end: 17, replacement: 'avec vous' }]);
  assert.deepEqual(out, ['je suis avec vous ce soir']);
});

test('remplacement chevauchant plusieurs nœuds : découpage mot à mot', () => {
  // « rejoins le <b>live</b> vip ce soir » → « rejoins la <b>session</b> vip ce soir »
  // Le mot en gras est remplacé DANS son nœud : le formatage mot à mot survit.
  const ns = nodes('rejoins le ', 'live', ' vip ce soir');
  const text = concatText(ns);
  const start = text.indexOf('le live vip');
  const out = applyEdits(ns, [{ start, end: start + 'le live vip'.length, replacement: 'la session vip' }]);
  assert.deepEqual(out, ['rejoins la ', 'session', ' vip ce soir']);
});

test('splitEditByTokens : ancres sur les mots communs', () => {
  const subs = splitEditByTokens('le live vip', 'la session vip', 10);
  assert.deepEqual(subs, [
    { start: 10, end: 12, replacement: 'la' },
    { start: 13, end: 17, replacement: 'session' },
  ]);
});

test('splitEditByTokens : aucun token commun → null (édit monolithique)', () => {
  assert.equal(splitEditByTokens('direct', 'lancement', 0), null);
});

test('splitEditByTokens : les espaces servent d\'ancres (répartition positionnelle)', () => {
  // Sans mot commun mais avec des espaces, chaque mot est remplacé « en place » :
  // le formatage de chaque position est conservé.
  const subs = splitEditByTokens('je suis en direct', 'le show commence', 0);
  assert.ok(Array.isArray(subs) && subs.length > 0);
  // La reconstruction doit donner exactement le remplacement demandé.
  let text = 'je suis en direct';
  for (const e of [...subs].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, e.start) + e.replacement + text.slice(e.end);
  }
  assert.equal(text, 'le show commence');
});

test('remplacement sans ancre : tout dans le premier nœud touché', () => {
  const ns = nodes('… je suis ', 'en direct', ' ce soir');
  const text = concatText(ns);
  const start = text.indexOf('suis en direct');
  const out = applyEdits(ns, [{ start, end: start + 'suis en direct'.length, replacement: 'lance le show' }]);
  assert.equal(out.join(''), '… je lance le show ce soir');
});

test('plusieurs édits dans le même bloc, ordre quelconque', () => {
  const ns = nodes('le live du live');
  const out = applyEdits(ns, [
    { start: 11, end: 15, replacement: 'rendez-vous' },
    { start: 3, end: 7, replacement: 'rendez-vous' },
  ]);
  assert.deepEqual(out, ['le rendez-vous du rendez-vous']);
});

test('édits chevauchants rejetés', () => {
  const ns = nodes('abcdef');
  assert.throws(() => applyEdits(ns, [
    { start: 0, end: 3, replacement: 'x' },
    { start: 2, end: 5, replacement: 'y' },
  ]), /chevauchants/);
});

test('édit hors bornes rejeté', () => {
  assert.throws(() => applyEdits(nodes('abc'), [{ start: 1, end: 9, replacement: 'x' }]), /hors bornes/);
});

test('remplacement exactement sur un nœud entier', () => {
  const ns = nodes('avant ', 'live', ' après');
  const out = applyEdits(ns, [{ start: 6, end: 10, replacement: 'rendez-vous' }]);
  assert.deepEqual(out, ['avant ', 'rendez-vous', ' après']);
});

test('sentenceAround découpe à la ponctuation', () => {
  const text = 'Bonjour. Demain je suis en direct avec toi ! À très vite.';
  const start = text.indexOf('en direct');
  const s = sentenceAround(text, start, start + 'en direct'.length);
  assert.match(s.text, /^Demain je suis en direct avec toi !?$/);
});
