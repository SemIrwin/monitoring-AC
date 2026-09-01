/**
 * Interaction avec l'éditeur d'email ActiveCampaign (ou toute page d'édition).
 *
 * Découverte volontairement générique — l'éditeur AC évolue et existe en
 * plusieurs versions (classique, Email Designer) :
 *   - blocs riches : tout élément `[contenteditable="true"]` de plus haut
 *     niveau, dans la page ET dans chaque iframe accessible ;
 *   - champs simples : inputs/textarea dont name/id/placeholder évoque
 *     l'objet ou le pré-en-tête.
 *
 * Identité d'un bloc : URL du frame (sans query volatile) + index d'ordre
 * DOM. À l'application, chaque nœud texte est revérifié contre le texte
 * extrait : si l'email a changé entre-temps, on refuse de toucher au bloc.
 */

/** Exécutée DANS le frame : extrait les blocs éditables. */
function pageExtract() {
  const isTop = (el) => !el.parentElement?.closest('[contenteditable="true"]');
  const walkTexts = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const p = node.parentElement;
        if (p && (p.closest('script,style,noscript'))) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const texts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n.data);
    return texts;
  };

  const blocks = [];
  const editables = [...document.querySelectorAll('[contenteditable="true"]')].filter(isTop);
  editables.forEach((el, i) => {
    blocks.push({
      type: 'rich',
      domIndex: i,
      label: (el.innerText || '').trim().slice(0, 80) || `bloc ${i + 1}`,
      nodes: walkTexts(el).map((text) => ({ text })),
    });
  });

  const FIELD_RE = /subject|objet|preheader|pre[-_ ]?header|pr[ée][-_ ]?en[-_ ]?t[êe]te/i;
  const fields = [...document.querySelectorAll('input[type="text"], input:not([type]), textarea')]
    .filter((el) => FIELD_RE.test([el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' ')));
  fields.forEach((el, i) => {
    blocks.push({
      type: 'field',
      domIndex: i,
      label: el.placeholder || el.name || el.id || `champ ${i + 1}`,
      nodes: [{ text: el.value || '' }],
    });
  });

  return blocks;
}

/**
 * Exécutée DANS le frame : applique de nouveaux textes de nœuds à un bloc.
 * Vérifie que les textes actuels correspondent à `expected` avant d'écrire.
 * Retourne { ok } ou { ok: false, reason }.
 */
function pageApply({ type, domIndex, expected, updated }) {
  const isTop = (el) => !el.parentElement?.closest('[contenteditable="true"]');
  const fire = (el) => {
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  if (type === 'field') {
    const FIELD_RE = /subject|objet|preheader|pre[-_ ]?header|pr[ée][-_ ]?en[-_ ]?t[êe]te/i;
    const fields = [...document.querySelectorAll('input[type="text"], input:not([type]), textarea')]
      .filter((el) => FIELD_RE.test([el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' ')));
    const el = fields[domIndex];
    if (!el) return { ok: false, reason: `champ ${domIndex} introuvable` };
    if ((el.value || '') !== expected[0]) return { ok: false, reason: 'le champ a changé depuis l\'extraction' };
    // Passer par le setter natif pour que React/Vue voient la modification.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, updated[0]);
    fire(el);
    return { ok: true };
  }

  const editables = [...document.querySelectorAll('[contenteditable="true"]')].filter(isTop);
  const root = editables[domIndex];
  if (!root) return { ok: false, reason: `bloc éditable ${domIndex} introuvable` };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const p = node.parentElement;
      if (p && (p.closest('script,style,noscript'))) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  if (nodes.length !== expected.length) {
    return { ok: false, reason: `structure changée (${nodes.length} nœuds texte, ${expected.length} attendus)` };
  }
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].data !== expected[i]) {
      return { ok: false, reason: `le texte du nœud ${i} a changé depuis l'extraction` };
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].data !== updated[i]) nodes[i].data = updated[i];
  }
  fire(root);
  return { ok: true };
}

/** Clé stable (autant que possible) d'un frame : URL sans query ni hash. */
function frameKey(frame) {
  try {
    const u = new URL(frame.url());
    return `${u.origin}${u.pathname}`;
  } catch {
    return frame.url() || 'about:blank';
  }
}

/**
 * Extrait tous les blocs éditables de la page (tous frames confondus).
 * Plusieurs frames peuvent partager la même URL (srcdoc, about:blank) :
 * `frameSeq` numérote les frames de même clé pour que chaque blockId reste
 * unique — sinon deux blocs distincts fusionneraient dans l'UI de revue.
 */
export async function extractBlocks(page) {
  const blocks = [];
  const seqByKey = new Map();
  for (const frame of page.frames()) {
    let found;
    try {
      found = await frame.evaluate(pageExtract);
    } catch {
      continue; // frame cross-origin ou détaché : ignoré
    }
    const fk = frameKey(frame);
    const frameSeq = seqByKey.get(fk) ?? 0;
    seqByKey.set(fk, frameSeq + 1);
    for (const b of found) {
      blocks.push({ ...b, frame: fk, frameSeq, blockId: `${b.type}:${fk}@${frameSeq}#${b.domIndex}` });
    }
  }
  return blocks;
}

/**
 * Applique `updatedTexts` au bloc `block` (issu d'extractBlocks) après
 * vérification. Retourne { ok, reason? }.
 */
export async function applyBlock(page, block, updatedTexts) {
  const frames = page.frames().filter((f) => frameKey(f) === block.frame);
  if (frames.length === 0) return { ok: false, reason: `frame ${block.frame} introuvable` };
  // Essayer d'abord le frame de même rang qu'à l'extraction ; les autres
  // servent de repli (la vérification des textes attendus tranche de toute
  // façon : un mauvais frame est rejeté avant toute écriture).
  if (Number.isInteger(block.frameSeq) && block.frameSeq > 0 && block.frameSeq < frames.length) {
    frames.unshift(frames.splice(block.frameSeq, 1)[0]);
  }
  let last = { ok: false, reason: 'aucun frame ne correspond' };
  for (const frame of frames) {
    try {
      last = await frame.evaluate(pageApply, {
        type: block.type,
        domIndex: block.domIndex,
        expected: block.nodes.map((n) => n.text),
        updated: updatedTexts,
      });
    } catch (e) {
      last = { ok: false, reason: e.message };
    }
    if (last.ok) return last;
  }
  return last;
}
