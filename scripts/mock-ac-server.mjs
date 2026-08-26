#!/usr/bin/env node
/**
 * Mini serveur imitant l'API ActiveCampaign v3, pour tester fetch-metrics.mjs
 * en local sans compte AC :
 *
 *   node scripts/mock-ac-server.mjs &            # écoute sur :8931
 *   AC_API_URL=http://127.0.0.1:8931 AC_API_KEY=test node scripts/fetch-metrics.mjs
 *
 * À chaque relevé les compteurs augmentent, comme si des contacts entraient
 * dans l'automatisation entre deux exécutions.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8931);
const startedAt = Date.now();

function counters(base, growthPerMin) {
  const minutes = (Date.now() - startedAt) / 60000 + Number(process.env.MOCK_ADVANCE_MIN || 0);
  const send = Math.round(base + growthPerMin * minutes);
  return {
    send_amt: String(send),
    total_amt: String(send),
    uniqueopens: String(Math.round(send * 0.44)),
    opens: String(Math.round(send * 0.71)),
    subscriberclicks: String(Math.round(send * 0.06)),
    uniquelinkclicks: String(Math.round(send * 0.072)),
    linkclicks: String(Math.round(send * 0.09)),
    hardbounces: String(Math.round(send * 0.008)),
    softbounces: String(Math.round(send * 0.015)),
    unsubscribes: String(Math.round(send * 0.004)),
  };
}

const AUTOMATIONS = [
  { id: '1', name: 'Séquence prospection' },
  { id: '2', name: 'Onboarding clients' },
];

function campaigns() {
  return [
    { id: '101', name: 'Email 1 — Bienvenue', seriesid: '1', sdate: '2026-07-01T09:00:00-05:00', ...counters(5000, 4) },
    { id: '102', name: 'Email 2 — Étude de cas', seriesid: '1', sdate: '2026-07-01T09:00:00-05:00', ...counters(4200, 3) },
    { id: '103', name: 'Email 3 — Invitation appel', seriesid: '1', sdate: '2026-07-01T09:00:00-05:00', ...counters(3600, 2) },
    { id: '201', name: 'Onboarding — Jour 1', seriesid: '2', sdate: '2026-07-15T09:00:00-05:00', ...counters(900, 1) },
    { id: '900', name: 'Newsletter ponctuelle', seriesid: '0', sdate: '2026-08-01T09:00:00-05:00', ...counters(12000, 0) },
    { id: '901', name: 'Brouillon jamais envoyé', seriesid: '1', sdate: null, send_amt: '0' },
  ];
}

function paginate(items, url) {
  const limit = Number(url.searchParams.get('limit') || 20);
  const offset = Number(url.searchParams.get('offset') || 0);
  return { slice: items.slice(offset, offset + limit), total: items.length };
}

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.headers['api-token'] !== 'test') {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end('{"message":"No Result found for Api-Token"}');
  }
  let body;
  if (url.pathname === '/api/3/campaigns') {
    const { slice, total } = paginate(campaigns(), url);
    body = { campaigns: slice, meta: { total: String(total) } };
  } else if (url.pathname === '/api/3/automations') {
    const { slice, total } = paginate(AUTOMATIONS, url);
    body = { automations: slice, meta: { total: String(total) } };
  } else {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{"message":"not found"}');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}).listen(PORT, () => console.log(`Mock AC API sur http://127.0.0.1:${PORT} (Api-Token: test)`));
