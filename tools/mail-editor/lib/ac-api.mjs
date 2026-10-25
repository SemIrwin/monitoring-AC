/**
 * Client API ActiveCampaign v3 minimal (repris de scripts/fetch-metrics.mjs).
 * Sert uniquement à ÉNUMÉRER les emails d'une automatisation (id, nom, sujet).
 * L'édition passe par Playwright dans l'éditeur visuel : modifier le HTML via
 * l'API v1 (message_edit) désynchroniserait le JSON du designer.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function acGet(baseUrl, apiKey, path, params = {}) {
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

export async function acGetAll(baseUrl, apiKey, path, collectionKey, extraParams = {}) {
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

/**
 * Emails (campagnes) d'une automatisation, identifiée par id numérique,
 * fragment d'URL (…/series/123) ou nom (insensible à la casse).
 * Retourne { automation, emails: [{ id, name, sdate }] }.
 */
export async function listAutomationEmails(baseUrl, apiKey, automationRef) {
  const automations = await acGetAll(baseUrl, apiKey, 'automations', 'automations');
  const ref = String(automationRef).trim();
  const idFromUrl = ref.match(/series\/(\d+)/)?.[1];
  const wanted = idFromUrl || ref;
  let automation = automations.find((a) => String(a.id) === wanted);
  if (!automation) {
    const lower = wanted.toLowerCase();
    const byName = automations.filter((a) => String(a.name || '').toLowerCase().includes(lower));
    if (byName.length === 1) automation = byName[0];
    else if (byName.length > 1) {
      throw new Error(`Plusieurs automatisations correspondent à « ${ref} » : ${byName.map((a) => `${a.id} (${a.name})`).join(', ')} — préciser l'id.`);
    }
  }
  if (!automation) {
    throw new Error(`Automatisation « ${ref} » introuvable. Disponibles : ${automations.map((a) => `${a.id} (${a.name})`).join(', ') || 'aucune'}`);
  }
  const campaigns = await acGetAll(baseUrl, apiKey, 'campaigns', 'campaigns');
  const emails = campaigns
    .filter((c) => String(c.seriesid) === String(automation.id))
    .map((c) => ({ id: String(c.id), name: String(c.name || `Email ${c.id}`), sdate: c.sdate || null }));
  return { automation: { id: String(automation.id), name: String(automation.name || '') }, emails };
}
