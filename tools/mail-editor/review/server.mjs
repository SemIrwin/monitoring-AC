/**
 * Serveur local de l'interface de revue (aucune dépendance).
 *   GET  /            → l'UI (review/ui.html)
 *   GET  /api/plan    → propositions + décisions déjà enregistrées
 *   POST /api/save    → écrit work/approved.json
 *   GET  /shots/<f>   → captures d'écran de l'extraction
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS_DIR } from '../lib/env.mjs';
import { readStep, writeStep } from '../lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function startReviewServer({ port, proposals }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(join(HERE, 'ui.html'), 'utf8'));
      } else if (req.method === 'GET' && url.pathname === '/api/plan') {
        const approved = readStep('approved');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ proposals, decisions: approved?.decisions || {} }));
      } else if (req.method === 'POST' && url.pathname === '/api/save') {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed.decisions !== 'object') throw new Error('corps invalide');
        // Empreinte de chaque décision : le fragment exact validé. `apply`
        // la revérifie pour qu'une décision ne se rebranche jamais sur une
        // autre occurrence après une ré-extraction.
        const fragmentById = new Map();
        for (const email of proposals.emails) {
          for (const block of email.blocks) {
            for (const occ of block.occurrences) {
              fragmentById.set(occ.id, block.text.slice(occ.proposal.start, occ.proposal.end));
            }
          }
        }
        const decisions = {};
        for (const [id, d] of Object.entries(parsed.decisions)) {
          if (!fragmentById.has(id)) continue; // id inconnu : ignoré
          decisions[id] = {
            approved: !!d.approved,
            replacement: typeof d.replacement === 'string' ? d.replacement : undefined,
            before: fragmentById.get(id),
          };
        }
        const file = writeStep('approved', {
          savedAt: new Date().toISOString(),
          proposalsCreatedAt: proposals.createdAt || null,
          decisions,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file }));
        console.log(`Décisions enregistrées (${Object.keys(decisions).length} occurrence(s)) → ${file}`);
      } else if (req.method === 'GET' && url.pathname.startsWith('/shots/')) {
        const file = join(SHOTS_DIR, basename(url.pathname));
        if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(readFileSync(file));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('introuvable');
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`erreur : ${e.message}`);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`Interface de revue : http://127.0.0.1:${port}`);
      console.log('Valider les occurrences puis « Enregistrer les décisions ». Ctrl-C quand c\'est fini.');
      resolve(server);
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
