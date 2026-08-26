#!/usr/bin/env node
/**
 * Mini serveur statique pour prévisualiser le dashboard en local :
 *
 *   node scripts/generate-demo-data.mjs   # (ou un vrai relevé)
 *   node scripts/serve-site.mjs           # http://127.0.0.1:8930
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = Number(process.env.PORT || 8930);
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(SITE, path));
    if (file !== SITE && !file.startsWith(SITE + sep)) throw new Error('forbidden');
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Dashboard sur http://127.0.0.1:${PORT}`));
