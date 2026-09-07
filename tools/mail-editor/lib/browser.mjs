/**
 * Session Playwright persistante : le profil (cookies, session AC) est stocké
 * dans work/browser-profile/ — on se connecte une fois avec `login`, les
 * commandes suivantes réutilisent la session. Mode visible par défaut :
 * l'outil est fait pour être REGARDÉ pendant qu'il travaille.
 */

import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { PROFILE_DIR, SHOTS_DIR } from './env.mjs';

export async function launchBrowser({ headless = false } = {}) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(SHOTS_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());
  return { context, page };
}

/** Heuristique « est-on connecté ? » : pas de formulaire de login visible. */
export async function looksLoggedIn(page) {
  try {
    const hasLogin = await page.locator('input[type="password"]').first().isVisible({ timeout: 1500 });
    return !hasLogin;
  } catch {
    return true;
  }
}

const rl = () => createInterface({ input: process.stdin, output: process.stdout });

/** Pause interactive : l'utilisateur agit dans le navigateur puis valide. */
export async function waitForEnter(message) {
  const iface = rl();
  await iface.question(`\n➤ ${message}\n  (Entrée pour continuer, Ctrl-C pour abandonner) `);
  iface.close();
}

export async function ask(message) {
  const iface = rl();
  const answer = await iface.question(`➤ ${message} `);
  iface.close();
  return answer.trim();
}
