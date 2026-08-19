import { describe, expect, it } from 'vitest';
import { createKavitaBookId } from '@/services/kavita/identity';
import { redactKavitaSecret } from '@/services/kavita/redaction';

describe('Kavita identity and redaction', () => {
  it('creates a stable Readest id from Readest server id and chapter id only', () => {
    const first = createKavitaBookId('server-a', 42);
    expect(first).toHaveLength(32);
    expect(createKavitaBookId('server-a', 42)).toBe(first);
    expect(createKavitaBookId('server-b', 42)).not.toBe(first);
    expect(createKavitaBookId('server-a', 43)).not.toBe(first);
  });

  it('redacts explicit keys and unavoidable KOReader path keys', () => {
    const key = 'secret-key-123';
    const value = `GET /api/Koreader/${key}/syncs/progress/hash?apiKey=${key} x-api-key=${key}`;
    const redacted = redactKavitaSecret(value, key);
    expect(redacted).not.toContain(key);
    expect(redacted).toBe(
      'GET /api/Koreader/[REDACTED]/syncs/progress/hash?apiKey=[REDACTED] x-api-key=[REDACTED]',
    );
  });
});
