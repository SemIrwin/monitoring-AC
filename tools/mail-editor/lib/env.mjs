/**
 * Environnement partagé de l'outil : chargement du .env racine du dépôt,
 * chemins de travail, configuration.
 *
 * Variables reconnues :
 *   AC_API_URL / AC_API_KEY   — API ActiveCampaign (mêmes que le monitoring)
 *   AC_ACCOUNT_URL            — URL de l'app AC (https://compte.activehosted.com)
 *   ANTHROPIC_API_KEY         — pour les propositions LLM (facultatif)
 *   AC_EDITOR_MODEL           — modèle Claude (défaut : claude-opus-5)
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = join(TOOL_ROOT, '..', '..');
export const WORK_DIR = join(TOOL_ROOT, 'work');
export const PROFILE_DIR = join(WORK_DIR, 'browser-profile');
export const SHOTS_DIR = join(WORK_DIR, 'screenshots');

export function loadEnv() {
  for (const envPath of [join(REPO_ROOT, '.env'), join(TOOL_ROOT, '.env')]) {
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  mkdirSync(WORK_DIR, { recursive: true });
  return {
    apiUrl: process.env.AC_API_URL || '',
    apiKey: process.env.AC_API_KEY || '',
    accountUrl: (process.env.AC_ACCOUNT_URL || guessAccountUrl(process.env.AC_API_URL || '')).replace(/\/$/, ''),
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.AC_EDITOR_MODEL || 'claude-opus-5',
  };
}

/** https://compte.api-us1.com → https://compte.activehosted.com (déduction). */
function guessAccountUrl(apiUrl) {
  const m = apiUrl.match(/^https:\/\/([^.]+)\.api-us\d+\.com/i);
  return m ? `https://${m[1]}.activehosted.com` : '';
}
