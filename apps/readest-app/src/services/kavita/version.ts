import { KAVITA_MIN_VERSION } from './constants';

function parseVersion(input: string): [number, number, number, number] | null {
  const match = input
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
}

export function compareKavitaVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`Invalid Kavita version: ${!left ? a : b}`);
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export function isSupportedKavitaVersion(version: string, minimum = KAVITA_MIN_VERSION): boolean {
  try {
    return compareKavitaVersions(version, minimum) >= 0;
  } catch {
    return false;
  }
}
