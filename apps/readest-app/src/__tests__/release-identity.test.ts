import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appRoot = process.cwd();
const read = (path: string) => readFileSync(resolve(appRoot, path), 'utf8');
const appPackage = JSON.parse(read('package.json')) as { version: string };
const tauri = JSON.parse(read('src-tauri/tauri.conf.json')) as {
  productName: string;
  mainBinaryName: string;
  identifier: string;
  bundle: {
    windows?: { nsis?: { installerHooks?: string } };
    macOS?: { bundleVersion?: string };
    iOS?: { developmentTeam?: string; bundleVersion?: string };
    fileAssociations: Array<{ name: string; contentTypes?: string[] }>;
  };
  plugins: { 'deep-link': { mobile: Array<{ scheme: string[] }>; desktop: { schemes: string[] } } };
};

describe('Readest Remote release identity', () => {
  it('pins the product, executable, version, and install identifier', () => {
    expect(appPackage.version).toBe('0.12.1-r2');
    expect(tauri.productName).toBe('Readest Remote');
    expect(tauri.mainBinaryName).toBe('readest-remote');
    expect(tauri.identifier).toBe('io.github.wenhe233.readestremote');
  });

  it('registers only Remote custom schemes and no upstream App Link ownership', () => {
    const schemes = [
      ...tauri.plugins['deep-link'].mobile.flatMap((entry) => entry.scheme),
      ...tauri.plugins['deep-link'].desktop.schemes,
    ];
    expect(schemes).toContain('readest-remote');
    expect(schemes).toContain('readest-remote-onedrive');
    expect(schemes).not.toContain('readest');
    expect(schemes).not.toContain('readest-onedrive');
    expect(schemes.join(' ')).not.toContain('googleusercontent');

    const manifest = read('src-tauri/gen/android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:scheme="readest-remote"');
    expect(manifest).not.toMatch(/android:scheme="readest"/);
    expect(manifest).not.toContain('android:host="web.readest.com"');
    expect(manifest).not.toContain('googleusercontent');
  });

  it('uses the independent Android identity and deterministic revision code', () => {
    const gradle = read('src-tauri/gen/android/app/build.gradle.kts');
    expect(gradle).toContain('namespace = "io.github.wenhe233.readestremote"');
    expect(gradle).toContain('applicationId = "io.github.wenhe233.readestremote"');
    expect(gradle).toContain('versionCode = 12001002');
    expect(gradle).toContain('versionName = "0.12.1-r2"');
    expect(gradle).not.toContain('System.getenv("SENTRY_DSN")');
  });

  it('derives Apple containers, extensions, and keychain services from the new id', () => {
    const info = read('src-tauri/Info-ios.plist');
    const project = read('src-tauri/gen/apple/project.yml');
    const widgetInfo = read('src-tauri/gen/apple/ReadestWidget/Info.plist');
    const safariAuth = read('src-tauri/src/macos/safari_auth.rs');
    const bridge = read(
      'src-tauri/plugins/tauri-plugin-native-bridge/ios/Sources/NativeBridgePlugin.swift',
    );
    expect(info).toContain('iCloud.io.github.wenhe233.readestremote');
    expect(info).toContain('<string>readest-remote</string>');
    expect(info).not.toContain('googleusercontent');
    expect(project).toContain('io.github.wenhe233.readestremote.ShareExtension');
    expect(project).toContain('io.github.wenhe233.readestremote.ReadestWidget');
    expect(project).not.toContain('DEVELOPMENT_TEAM:');
    expect(widgetInfo).toContain('<string>Readest Remote</string>');
    expect(widgetInfo).toContain('<string>0.12.1</string>');
    expect(widgetInfo).toContain('<string>12001002</string>');
    expect(safariAuth).toContain('NSString::from_str("readest-remote")');
    expect(safariAuth).not.toContain('NSString::from_str("readest")');
    expect(tauri.bundle.iOS?.developmentTeam).toBeUndefined();
    expect(tauri.bundle.iOS?.bundleVersion).toBe('12001002');
    expect(tauri.bundle.macOS?.bundleVersion).toBe('12001002');
    expect(bridge).toContain('io.github.wenhe233.readestremote.sync-passphrase');
    expect(bridge).toContain('io.github.wenhe233.readestremote.secure-items');
  });

  it('does not register the Explorer thumbnail hook or expose a storefront', () => {
    const windowsConfig = read('src-tauri/tauri.windows.conf.json');
    expect(tauri.bundle.windows?.nsis?.installerHooks).toBeUndefined();
    expect(windowsConfig).not.toContain('thumbnail');
    expect(windowsConfig).toContain('"version": "0.12.1-2"');
    expect(read('src/hooks/useAvailablePlans.ts')).toContain(
      'export const PURCHASES_ENABLED = false',
    );
    expect(read('src-tauri/gen/android/app/src/main/AndroidManifest.xml')).not.toContain(
      'com.android.vending.BILLING',
    );
  });

  it('uses Remote-owned Windows ProgIDs and custom Apple content types', () => {
    expect(tauri.bundle.fileAssociations).toHaveLength(9);
    expect(
      tauri.bundle.fileAssociations.every(({ name }) => name.startsWith('Readest Remote ')),
    ).toBe(true);
    const contentTypes = tauri.bundle.fileAssociations.flatMap(
      ({ contentTypes = [] }) => contentTypes,
    );
    expect(contentTypes).not.toContain('com.readest.fb2');
    expect(contentTypes).not.toContain('com.readest.cbz');
    expect(contentTypes).toContain('io.github.wenhe233.readestremote.fb2');
    expect(contentTypes).toContain('io.github.wenhe233.readestremote.cbz');
  });

  it('does not embed official updater or telemetry targets', () => {
    const constants = read('src/services/constants.ts');
    const posthog = read('src/context/PHContext.tsx');
    const build = read('src-tauri/build.rs');
    const updaterWindow = read('src/components/UpdaterWindow.tsx');
    const discord = read('src-tauri/src/discord_rpc.rs');
    expect(constants).not.toContain('download.readest.com');
    expect(constants).not.toContain('github.com/readest/readest/releases');
    expect(posthog).not.toMatch(/phc_[A-Za-z0-9]+/);
    expect(posthog).toContain('NEXT_PUBLIC_REMOTE_POSTHOG_KEY');
    expect(build).toContain('READEST_REMOTE_SENTRY_DSN');
    expect(build).not.toContain('env::var("SENTRY_DSN")');
    expect(updaterWindow).toContain('WenHe233/readest-remote/releases');
    expect(updaterWindow).not.toContain('apps.apple.com');
    expect(updaterWindow).not.toContain('play.google.com');
    expect(discord).toContain('READEST_REMOTE_DISCORD_APP_ID');
    expect(discord).toContain('Read on Readest Remote');
    expect(discord).not.toContain('1462683110612144348');
    expect(discord).not.toContain('web.readest.com');
  });

  it('versions locale assets so upgrades cannot retain an r1 catalogue', () => {
    const i18n = read('src/i18n/i18n.ts');
    expect(i18n).toContain('packageJson.version');
    expect(i18n).toContain("cache: 'no-store'");
    expect(i18n).toContain('.getRegistrations()');
    expect(i18n).toContain('registration.unregister()');
  });

  it('publishes a distinct Linux desktop identity', () => {
    const appdata = read('../../data/metainfo/appdata.xml');
    expect(appdata).toContain('<id>io.github.wenhe233.readestremote</id>');
    expect(appdata).toContain('<name>Readest Remote</name>');
    expect(appdata).toContain('<release version="0.12.1-r2"');
  });
});
