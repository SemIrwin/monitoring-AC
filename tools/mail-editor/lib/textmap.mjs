/**
 * Correspondance entre le texte « à plat » d'un bloc éditable et ses nœuds
 * texte DOM.
 *
 * Principe de préservation du formatage : on ne régénère JAMAIS de HTML.
 * Un bloc est extrait comme la liste ordonnée de ses nœuds texte ; les
 * remplacements sont calculés sur le texte concaténé, puis reprojetés en
 * nouvelles valeurs de `node.data` pour chaque nœud. Les balises (gras,
 * liens, couleurs…) ne sont donc jamais touchées.
 *
 * Cas limite géré : un remplacement qui chevauche plusieurs nœuds
 * (« le <b>live</b> vip » → « la session vip »). Chaque édit est d'abord
 * DÉCOUPÉ par diff de tokens (LCS) : les mots inchangés servent d'ancres et
 * chaque zone modifiée devient un micro-édit (« le »→« la », « live »→
 * « session »). Un mot remplacé dans un nœud en gras reste donc en gras.
 * Quand aucun mot ne sert d'ancre, le remplacement entier est écrit dans le
 * premier nœud touché (il en hérite le formatage) ; la partie couverte des
 * nœuds suivants est supprimée.
 */

/** Texte concaténé d'une liste de nœuds [{ text }]. */
export function concatText(nodes) {
  return nodes.map((n) => n.text).join('');
}

/** Offsets [start, end) de chaque nœud dans le texte concaténé. */
export function nodeOffsets(nodes) {
  const out = [];
  let pos = 0;
  for (const n of nodes) {
    out.push({ start: pos, end: pos + n.text.length });
    pos += n.text.length;
  }
  return out;
}

const tokenize = (s) => s.match(/\s+|\S+/g) || [];

/**
 * Découpe un édit en micro-édits alignés sur les mots communs entre l'ancien
 * fragment et son remplacement (diff LCS sur les tokens). Retourne null si
 * aucun découpage utile n'est possible (l'édit reste alors monolithique).
 */
export function splitEditByTokens(oldFrag, replacement, base) {
  const a = tokenize(oldFrag);
  const b = tokenize(replacement);
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0 || m * n > 40000) return null;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  if (dp[0][0] === 0) return null; // aucune ancre commune

  const out = [];
  let i = 0;
  let j = 0;
  let aOff = 0; // offset caractère dans oldFrag au début du token a[i]
  let delStart = null;
  let delEnd = null;
  let insBuf = '';
  const flush = (anchorOff) => {
    if (delStart === null && insBuf === '') return;
    const s = delStart ?? anchorOff;
    const e = delEnd ?? anchorOff;
    out.push({ start: base + s, end: base + e, replacement: insBuf });
    delStart = null;
    delEnd = null;
    insBuf = '';
  };
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      flush(aOff);
      aOff += a[i].length;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (delStart === null) delStart = aOff;
      delEnd = aOff + a[i].length;
      aOff = delEnd;
      i++;
    } else {
      insBuf += b[j];
      j++;
    }
  }
  while (i < m) {
    if (delStart === null) delStart = aOff;
    delEnd = aOff + a[i].length;
    aOff = delEnd;
    i++;
  }
  while (j < n) {
    insBuf += b[j];
    j++;
  }
  flush(aOff);
  return out.length > 0 ? out : null;
}

/**
 * Applique des édits [{ start, end, replacement }] (offsets dans le texte
 * concaténé) et retourne le nouveau texte de chaque nœud.
 *
 * Chaque édit est d'abord découpé par splitEditByTokens pour minimiser la
 * zone touchée (préservation du formatage mot à mot). Les édits ne doivent
 * pas se chevaucher ; ils peuvent être donnés dans n'importe quel ordre.
 * Jette si un édit sort des bornes ou chevauche.
 */
export function applyEdits(nodes, edits) {
  const fullText = concatText(nodes);
  const total = fullText.length;
  const originals = [...edits].sort((a, b) => a.start - b.start);
  let prevEndCheck = -1;
  for (const e of originals) {
    if (!(Number.isInteger(e.start) && Number.isInteger(e.end)) || e.start < 0 || e.end > total || e.start > e.end) {
      throw new Error(`Édit hors bornes : [${e.start}, ${e.end}) sur un texte de ${total} caractères`);
    }
    if (e.start < prevEndCheck) throw new Error(`Édits chevauchants autour de l'offset ${e.start}`);
    prevEndCheck = e.end;
  }
  // Découpage mot à mot APRÈS validation : les micro-édits restent dans les
  // bornes de leur édit d'origine et ne peuvent pas se chevaucher entre eux.
  const sorted = originals.flatMap((e) =>
    splitEditByTokens(fullText.slice(e.start, e.end), e.replacement, e.start) ?? [e]);

  const offsets = nodeOffsets(nodes);
  const texts = nodes.map((n) => n.text);

  // Application de droite à gauche : les offsets des édits précédents restent valides.
  for (const e of [...sorted].reverse()) {
    let placed = false;
    for (let i = 0; i < nodes.length; i++) {
      const { start: ns, end: ne } = offsets[i];
      if (ne <= e.start || ns >= e.end) continue; // nœud non concerné
      const cutFrom = Math.max(e.start, ns) - ns;
      const cutTo = Math.min(e.end, ne) - ns;
      // Le remplacement va dans le premier nœud touché ; noter qu'un édit
      // d'insertion pure (start === end) tombe ici via la condition ci-dessous.
      const insert = placed ? '' : e.replacement;
      texts[i] = texts[i].slice(0, cutFrom) + insert + texts[i].slice(cutTo);
      placed = true;
    }
    if (!placed) {
      // Insertion pure à une frontière de nœud (ou texte vide) : placer dans
      // le nœud dont l'intervalle contient le point d'insertion, sinon le dernier.
      let target = nodes.length - 1;
      for (let i = 0; i < nodes.length; i++) {
        if (e.start <= offsets[i].end) { target = i; break; }
      }
      if (target >= 0) {
        const at = Math.min(Math.max(e.start - offsets[target].start, 0), texts[target].length);
        texts[target] = texts[target].slice(0, at) + e.replacement + texts[target].slice(at);
      }
    }
  }
  return texts;
}

/**
 * Extrait la phrase contenant [start, end) dans `text`, pour donner du
 * contexte au LLM et à l'UI de revue. Coupe aux ponctuations fortes ou
 * doubles sauts de ligne, bornée à `maxLen` caractères de part et d'autre.
 */
export function sentenceAround(text, start, end, maxLen = 240) {
  const boundary = /[.!?…]|\n\n/g;
  let sStart = 0;
  let m;
  boundary.lastIndex = 0;
  while ((m = boundary.exec(text)) !== null && m.index < start) sStart = m.index + m[0].length;
  boundary.lastIndex = end;
  const next = boundary.exec(text);
  let sEnd = next ? next.index + next[0].length : text.length;
  sStart = Math.max(sStart, start - maxLen);
  sEnd = Math.min(sEnd, end + maxLen);
  return { text: text.slice(sStart, sEnd).replace(/\s+/g, ' ').trim(), offset: sStart };
}
