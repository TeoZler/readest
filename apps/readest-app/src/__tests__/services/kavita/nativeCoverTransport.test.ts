import { describe, expect, it } from 'vitest';
import { createNativeCoverResponse } from '@/services/kavita/nativeCoverTransport';

describe('native Kavita cover response', () => {
  it('preserves validators, retry metadata and binary body', async () => {
    const response = createNativeCoverResponse(
      {
        status: 200,
        contentType: 'image/jpeg',
        etag: 'cover-v1',
        lastModified: 'Wed, 19 Aug 2026 03:29:44 GMT',
        retryAfter: '5',
        bodyBase64: 'AQID',
      },
      new Uint8Array([1, 2, 3]),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('ETag')).toBe('cover-v1');
    expect(response.headers.get('Retry-After')).toBe('5');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('creates a bodyless 304 response', async () => {
    const response = createNativeCoverResponse({ status: 304 });
    expect(response.status).toBe(304);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it('rejects invalid status and a successful response without a body', () => {
    expect(() => createNativeCoverResponse({ status: 0 })).toThrow('status is invalid');
    expect(() => createNativeCoverResponse({ status: 200 })).toThrow('file is missing');
  });
});
