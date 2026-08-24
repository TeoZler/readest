import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sourceRoot = resolve(process.cwd(), 'src');
const staticTranslationPattern = /(?<![A-Za-z0-9_$])_\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

const collectSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : collectSourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });

const unescapeKey = (key: string) =>
  key.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"');

const sourceKeys = new Set<string>();
for (const file of collectSourceFiles(sourceRoot)) {
  const source = readFileSync(file, 'utf8');
  let match: RegExpExecArray | null;
  while ((match = staticTranslationPattern.exec(source))) {
    if (!match[2]!.includes('${')) sourceKeys.add(unescapeKey(match[2]!));
  }
}

describe.each(['zh-CN', 'zh-TW'])('%s static translation coverage', (locale) => {
  it('contains every statically discoverable UI string without a placeholder', () => {
    const translations = JSON.parse(
      readFileSync(resolve(process.cwd(), `public/locales/${locale}/translation.json`), 'utf8'),
    ) as Record<string, string>;
    const missing = [...sourceKeys].filter(
      (key) => !translations[key] || translations[key] === '__STRING_NOT_TRANSLATED__',
    );
    expect(missing.sort()).toEqual([]);
  });
});
