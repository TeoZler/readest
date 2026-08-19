import { describe, expect, it } from 'vitest';
import { compareKavitaVersions, isSupportedKavitaVersion } from '@/services/kavita/version';

describe('Kavita version comparison', () => {
  it.each([
    ['0.9.0.2', '0.9.0.2', 0],
    ['v0.9.0.3', '0.9.0.2', 1],
    ['0.10.0', '0.9.0.2', 1],
    ['0.9.0.1', '0.9.0.2', -1],
    ['0.9.0.2+build', '0.9.0.2', 0],
  ] as const)('compares %s with %s', (a, b, result) => {
    expect(compareKavitaVersions(a, b)).toBe(result);
  });

  it('enforces the V1 minimum', () => {
    expect(isSupportedKavitaVersion('0.9.0.2')).toBe(true);
    expect(isSupportedKavitaVersion('0.9.1')).toBe(true);
    expect(isSupportedKavitaVersion('0.8.7.3')).toBe(false);
    expect(isSupportedKavitaVersion('unknown')).toBe(false);
  });
});
