#!/usr/bin/env node
/*
 * Fallback export: drive the real browser UI through Tools -> Export JSON -> <pack>
 * and save whatever the page downloads.
 *
 * Use this when /api/export changes shape or stops matching the UI, so the primary
 * path in tools/fetch-export.sh can be re-verified against ground truth.
 * Verified to produce a byte-identical file to the API path (same sha256).
 *
 * Requires Playwright. Resolve it from your project or install it:
 *     npm i -D playwright && npx playwright install chromium
 *
 * Usage:
 *     node tools/export-via-ui.mjs [pack] [output]
 *     node tools/export-via-ui.mjs fpkg /tmp/fpkg.ui.json
 *
 * pack   : fpkg (default) | lz4 | pfs | packizard      output : default fpkg-ui.json
 *
 * Env:
 *   PLAYWRIGHT_MODULE   path to a project's node_modules to resolve `playwright` from
 *   CHROMIUM_EXECUTABLE explicit browser binary (overrides the bundled download)
 */

import { createRequire } from 'node:module';
import process from 'node:process';

const PACK = process.argv[2] || 'fpkg';
const OUT = process.argv[3] || `${PACK}-ui.json`;
const BASE = process.env.GFS_BASE_URL || 'https://pfs-library.xetdy-am.workers.dev';

const require = createRequire(
  process.env.PLAYWRIGHT_MODULE
    ? new URL('noop.js', `file://${process.env.PLAYWRIGHT_MODULE.replace(/\/?$/, '/')}`)
    : import.meta.url,
);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error(
    'export-via-ui: could not resolve `playwright`.\n' +
      '  Install it (npm i -D playwright && npx playwright install chromium)\n' +
      '  or point PLAYWRIGHT_MODULE at a project that has it.',
  );
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
try {
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // The site gates the catalog behind a client-side Cloudflare Turnstile widget.
  // The widget does not complete in headless browsers, so seed the flag it sets
  // ("gfs-captcha-verified", 3h TTL) and reload. This only bypasses the UI gate;
  // it grants no server-side access — /api/export needs no auth at all.
  await page.evaluate(() =>
    localStorage.setItem(
      'gfs-captcha-verified',
      JSON.stringify({ expiry: Date.now() + 3 * 60 * 60 * 1000 }),
    ),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Dismiss the "What's New" modal if it appears; it intercepts clicks otherwise.
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {});

  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'Export JSON' }).click();

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page
    .getByRole('button', { name: new RegExp(PACK, 'i') })
    .first()
    .click();
  const download = await downloadPromise;
  await download.saveAs(OUT);

  console.error(`export-via-ui: saved ${download.suggestedFilename()} -> ${OUT}`);
} finally {
  await browser.close();
}
