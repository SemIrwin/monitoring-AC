/** Lecture/écriture des fichiers d'étape dans work/ (pivot du pipeline). */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORK_DIR } from './env.mjs';

export const FILES = {
  extraction: join(WORK_DIR, 'extraction.json'),
  proposals: join(WORK_DIR, 'proposals.json'),
  approved: join(WORK_DIR, 'approved.json'),
  applied: join(WORK_DIR, 'applied.json'),
};

export function readStep(name) {
  const file = FILES[name];
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeStep(name, data) {
  const file = FILES[name];
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
  return file;
}
