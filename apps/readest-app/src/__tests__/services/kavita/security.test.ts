import { describe, expect, it } from 'vitest';
import { KavitaError } from '@/services/kavita/errors';
import { isLocalOrPrivateHost, normalizeKavitaBaseUrl } from '@/services/kavita/security';

describe('Kavita URL security', () => {
  it.each([
    'localhost',
    'kavita.local',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.2.3',
    '172.31.2.3',
    '192.168.1.2',
    '169.254.2.2',
    '::1',
    'fd00::1',
    'fe80::1',
  ])('allows HTTP for local/private host %s', (host) =>
    expect(isLocalOrPrivateHost(host)).toBe(true));

  it.each([
    'example.com',
    '8.8.8.8',
    '172.15.1.1',
    '172.32.1.1',
    '192.0.2.1',
  ])('does not classify public host %s as private', (host) =>
    expect(isLocalOrPrivateHost(host)).toBe(false));

  it('normalizes trailing slashes', () => {
    expect(normalizeKavitaBaseUrl(' http://192.168.1.20:5000/// ')).toBe(
      'http://192.168.1.20:5000',
    );
  });

  it('requires HTTPS for public hosts', () => {
    try {
      normalizeKavitaBaseUrl('http://books.example.com');
      expect.unreachable('public HTTP URL should be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(KavitaError);
      expect((error as KavitaError).category).toBe('insecure-public-http');
    }
    expect(normalizeKavitaBaseUrl('https://books.example.com/kavita/')).toBe(
      'https://books.example.com/kavita',
    );
  });

  it.each([
    'ftp://192.168.1.2',
    'http://user:pass@192.168.1.2',
    'http://192.168.1.2?q=1',
  ])('rejects unsafe URL %s', (url) =>
    expect(() => normalizeKavitaBaseUrl(url)).toThrow(KavitaError));
});
