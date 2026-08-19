#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [directoryArg = 'release', versionArg] = process.argv.slice(2);
const directory = resolve(directoryArg);
const version = versionArg || process.env.RELEASE_VERSION;

if (!version) {
  console.error('usage: verify-release-assets.mjs <directory> <version>');
  process.exit(2);
}

const prefix = `Readest-Remote_${version}`;
const expected = [
  `${prefix}_windows-x64-setup.exe`,
  `${prefix}_windows-x64-portable.exe`,
  `${prefix}_windows-arm64-setup.exe`,
  `${prefix}_windows-arm64-portable.exe`,
  `${prefix}_linux-x64.AppImage`,
  `${prefix}_linux-x64.deb`,
  `${prefix}_linux-arm64.AppImage`,
  `${prefix}_linux-arm64.deb`,
  `${prefix}_macos-universal.dmg`,
  `${prefix}_android-universal.apk`,
  `${prefix}_android-arm64.apk`,
  `${prefix}_ios-arm64.ipa`,
  `${prefix}_web.zip`,
  `${prefix}_koreader-plugin.zip`,
  `${prefix}_calibre-plugin.zip`,
  `${prefix}_browser-extension.zip`,
];

const errors = [];
for (const name of expected) {
  const path = join(directory, name);
  if (!existsSync(path)) errors.push(`missing ${name}`);
  else if (!statSync(path).isFile() || statSync(path).size === 0) errors.push(`empty ${name}`);
}

if (existsSync(directory)) {
  const actual = readdirSync(directory).filter((name) => name.startsWith('Readest-Remote_'));
  for (const name of actual) {
    if (!expected.includes(name)) errors.push(`unexpected ${basename(name)}`);
  }
}

for (const forbidden of ['latest.json', 'latest.json.sig']) {
  if (existsSync(join(directory, forbidden))) errors.push(`forbidden updater artifact ${forbidden}`);
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log(`Verified ${expected.length} Readest Remote ${version} release assets.`);
