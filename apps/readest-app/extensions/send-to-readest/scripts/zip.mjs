#!/usr/bin/env node
/**
 * Package the built extension into a versioned, Chrome-Web-Store-ready zip.
 *
 * Invoked by `pnpm zip`, which builds first so the archive is never stale.
 * The zip root holds `manifest.json` directly — the layout the Web Store
 * dashboard expects — and drops the `.LICENSE.txt` banners webpack emits
 * plus macOS `.DS_Store` noise.
 *
 * Uses the extension's existing zip.js dependency so the same packaging step
 * works on Windows, macOS, and Linux release runners.
 */
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter, configure } from '@zip.js/zip.js';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');
const MANIFEST = join(DIST, 'manifest.json');

if (!existsSync(MANIFEST)) {
  console.error('[zip] dist/manifest.json not found — run `pnpm build` first.');
  process.exit(1);
}

const appPackage = join(ROOT, '..', '..', 'package.json');
const { version: releaseVersion } = JSON.parse(readFileSync(appPackage, 'utf8'));
const out = join(ROOT, `Readest-Remote_${releaseVersion}_browser-extension.zip`);
if (existsSync(out)) rmSync(out);

const files = [];
const collect = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name !== '.DS_Store' && !entry.name.endsWith('.LICENSE.txt')) files.push(path);
  }
};
collect(DIST);
files.sort((a, b) => a.localeCompare(b));

configure({ useWebWorkers: false });
const writer = new ZipWriter(new Uint8ArrayWriter());
for (const path of files) {
  // Use POSIX separators and a fixed timestamp for reproducible archives.
  const name = relative(DIST, path).split(sep).join('/');
  await writer.add(name, new Uint8ArrayReader(readFileSync(path)), {
    lastModDate: new Date('2000-01-01T00:00:00.000Z'),
  });
}
writeFileSync(out, await writer.close());

const kb = Math.round(statSync(out).size / 1024);
console.log(
  `[zip] Readest-Remote_${releaseVersion}_browser-extension.zip (${kb} KB) ready to upload`,
);
