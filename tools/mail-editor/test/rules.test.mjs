import test from 'node:test';
import assert from 'node:assert/strict';
import { findOccurrences, matchCase, violatesLexicon } from '../lib/rules.mjs';

test('live seul → rendez-vous', () => {
  const occ = findOccurrences('Rejoins le live ce soir.');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].kind, 'live');
  assert.equal(occ[0].proposal.replacement, 'rendez-vous');
});

test('live + vip → session, déterminant accordé', () => {
  const text = 'Rejoins le live VIP maintenant.';
  const occ = findOccurrences(text);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].kind, 'live_vip');
  const p = occ[0].proposal;
  assert.equal(text.slice(p.start, p.end), 'le live');
  assert.equal(p.replacement, 'la session');
});

test('un live vip → une session', () => {
  const text = 'Il y a un live vip demain.';
  const [occ] = findOccurrences(text);
  assert.equal(occ.kind, 'live_vip');
  assert.equal(text.slice(occ.proposal.start, occ.proposal.end), 'un live');
  assert.equal(occ.proposal.replacement, 'une session');
});

test('casse préservée (Live → Rendez-vous)', () => {
  const [occ] = findOccurrences('Live exceptionnel demain.');
  assert.equal(occ.proposal.replacement, 'Rendez-vous');
  assert.equal(matchCase('LIVE', 'session'), 'SESSION');
  assert.equal(matchCase('Live', 'session'), 'Session');
  assert.equal(matchCase('live', 'session'), 'session');
});

test('en direct → détecté, confiance haute, LLM demandé', () => {
  const text = 'Ce soir je suis en direct avec toi.';
  const occ = findOccurrences(text);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].kind, 'direct');
  assert.equal(occ[0].confidence, 'high');
  assert.equal(occ[0].needsLlm, true);
  const p = occ[0].proposal;
  assert.equal(text.slice(p.start, p.end), 'en direct');
});

test('direct sans « en » → confiance basse, proposition no-op', () => {
  const text = 'Merci pour ta réponse directe.';
  const occ = findOccurrences(text);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].confidence, 'low');
  assert.equal(occ[0].proposal.replacement, occ[0].matched);
});

test('pas de faux positifs : directement, direction, olive, livre, délivre', () => {
  const occ = findOccurrences('Va directement à la direction chercher une olive et un livre qui délivre.');
  assert.equal(occ.length, 0);
});

test('plusieurs occurrences triées par position', () => {
  const occ = findOccurrences('Le live commence : on est en direct, et le live VIP suit.');
  assert.deepEqual(occ.map((o) => o.kind), ['live', 'direct', 'live_vip']);
  assert.ok(occ[0].start < occ[1].start && occ[1].start < occ[2].start);
});

test('violatesLexicon détecte les termes interdits, pas leurs dérivés autorisés', () => {
  assert.deepEqual(violatesLexicon('le grand show'), []);
  assert.ok(violatesLexicon('reste en direct').includes('en direct'));
  assert.ok(violatesLexicon('le replay arrive').includes('replay'));
  assert.ok(violatesLexicon('un live').includes('live'));
  assert.deepEqual(violatesLexicon('délivré'), []);
  assert.deepEqual(violatesLexicon('directement'), []);
  // « direct » nu, espace insécable, espaces doubles : tous bloqués.
  assert.ok(violatesLexicon('le Direct commence').includes('direct'));
  assert.ok(violatesLexicon('en direct').length > 0);
  assert.ok(violatesLexicon('en  direct').length > 0);
});

test('mot accentué avant « live vip » : pas d\'accord volé sur la fin du mot', () => {
  const text = 'Rejoins notre clientèle live VIP ce soir.';
  const [occ] = findOccurrences(text);
  assert.equal(occ.kind, 'live_vip');
  assert.equal(text.slice(occ.proposal.start, occ.proposal.end), 'live');
  assert.equal(occ.proposal.replacement, 'session');

  const text2 = 'Le modèle live vip est prêt.';
  const [occ2] = findOccurrences(text2);
  assert.equal(text2.slice(occ2.proposal.start, occ2.proposal.end), 'live');
});

test('live dans une URL ou un mot composé : signalé mais proposition no-op', () => {
  const occ = findOccurrences('Va sur https://ex.com/live/vip et regarde le live-stream.');
  assert.equal(occ.length, 2);
  for (const o of occ) {
    assert.equal(o.confidence, 'low');
    assert.equal(o.proposal.replacement, o.matched);
    assert.match(o.note, /URL ou mot composé/);
  }
});

test('En direct en début de phrase : casse reportée sur le remplacement', () => {
  const [occ] = findOccurrences('En direct de Paris !');
  assert.equal(occ.proposal.replacement, 'Avec vous');
});
