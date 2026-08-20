import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const appRoot = process.cwd();
const read = (path: string) => readFileSync(resolve(appRoot, path), 'utf8');
const version = (JSON.parse(read('package.json')) as { version: string }).version;
const prefix = `Readest-Remote_${version}`;
const releaseAssets = [
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

const verifyAssets = (directory: string) =>
  spawnSync(
    process.execPath,
    [resolve(appRoot, '../../scripts/verify-release-assets.mjs'), directory, version],
    { encoding: 'utf8' },
  );

describe('Readest Remote release workflow', () => {
  it('builds on dispatch but publishes only from a matching tag after all gates', () => {
    const workflow = read('../../.github/workflows/release.yml');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("tags:\n      - 'v*'");
    expect(workflow).toContain("if: startsWith(github.ref, 'refs/tags/')");
    expect(workflow).toMatch(/GITHUB_REF_NAME.*expected_tag/);
    expect(workflow).toContain('build-windows');
    expect(workflow).toContain('build-linux');
    expect(workflow).toContain('build-macos');
    expect(workflow).toContain('build-android');
    expect(workflow).toContain('build-ios');
    expect(workflow).toContain(
      "$windowsVersion = $env:RELEASE_VERSION -replace '-r([0-9]+)$', '-$1'",
    );
    expect(workflow).toContain('$info.ProductVersion -ne $windowsVersion');
    expect(workflow.match(/pnpm --filter @readest\/readest-app setup-vendors/g)).toHaveLength(8);
    expect(workflow).toContain('(cd release && sha256sum --check SHA256SUMS.txt)');
  });

  it('pins independent signing, ARM runners, static PWA, and portable behavior', () => {
    const workflow = read('../../.github/workflows/release.yml');
    expect(workflow).toContain('windows-11-arm');
    expect(workflow).toContain('ubuntu-24.04-arm');
    expect(workflow).toContain('architecture: x64');
    expect(workflow).toContain('ANDROID_RELEASE_KEYSTORE_BASE64');
    expect(workflow).toContain('ANDROID_RELEASE_CERT_SHA256');
    expect(workflow).toContain('pnpm tauri android init');
    expect(workflow).toContain('pnpm tauri icon ../../data/icons/readest-book.png');
    expect(workflow).toContain('pnpm tauri ios build --ci --no-sign');
    expect(workflow).not.toContain('xcodebuild archive');
    expect(workflow).toContain("NEXT_PUBLIC_PORTABLE_APP: 'true'");
    expect(workflow).toContain('test -s apps/readest-app/out/sw.js');
    expect(workflow).not.toContain('TAURI_SIGNING_PRIVATE_KEY');
    expect(workflow).not.toContain('readest/readest/releases');
    expect(workflow).not.toContain('upload-to-r2');
    expect(workflow).not.toContain('latest.json');
    expect(existsSync(resolve(appRoot, '../../.github/workflows/nightly.yml'))).toBe(false);
    expect(existsSync(resolve(appRoot, '../../.github/workflows/upload-to-r2.yml'))).toBe(false);
    expect(existsSync(resolve(appRoot, '../../.github/workflows/docker-image.yml'))).toBe(false);
    expect(existsSync(resolve(appRoot, '../../.github/workflows/vercel-merge.yml'))).toBe(false);

    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['build-web-static']).toContain('BUILD_STATIC_WEB=true');
    expect(packageJson.scripts['build-web-static']).toContain('--webpack');
    expect(packageJson.scripts['build-web-static']).toContain('--max-old-space-size=6144');
  });

  it('accepts exactly the complete non-empty artifact matrix', () => {
    const directory = mkdtempSync(join(tmpdir(), 'readest-remote-assets-'));
    try {
      for (const asset of releaseAssets) writeFileSync(join(directory, asset), 'artifact');
      const result = verifyAssets(directory);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Verified ${releaseAssets.length}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects missing, empty, unexpected, and updater artifacts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'readest-remote-assets-'));
    try {
      for (const asset of releaseAssets.slice(1)) writeFileSync(join(directory, asset), 'artifact');
      writeFileSync(join(directory, releaseAssets[1]!), '');
      writeFileSync(join(directory, `${prefix}_unexpected.zip`), 'artifact');
      writeFileSync(join(directory, 'latest.json'), '{}');
      const result = verifyAssets(directory);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`missing ${releaseAssets[0]}`);
      expect(result.stderr).toContain(`empty ${releaseAssets[1]}`);
      expect(result.stderr).toContain('unexpected');
      expect(result.stderr).toContain('forbidden updater artifact latest.json');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
