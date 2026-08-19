import { describe, expect, it, vi } from 'vitest';
import { KavitaError } from '@/services/kavita/errors';
import { validateKavitaRangeResponse } from '@/services/kavita/range';
import { RemoteFile } from '@/utils/file';

const partialResponse = (bytes: Uint8Array, start: number, end: number, total: number) =>
  new Response(bytes.slice().buffer, {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${total}` },
  });

describe('Kavita Range validation', () => {
  it('accepts an exact 206 Content-Range', () => {
    const response = partialResponse(new Uint8Array(10), 10, 19, 100);
    expect(validateKavitaRangeResponse(response, 10, 19, 100)).toEqual({
      start: 10,
      end: 19,
      total: 100,
    });
  });

  it('rejects proxy-rewritten HTTP 200 without consuming the body', () => {
    const response = new Response(new ArrayBuffer(100), { status: 200 });
    try {
      validateKavitaRangeResponse(response, 0, 9, 100);
      expect.unreachable('HTTP 200 Range response should be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(KavitaError);
      expect((error as KavitaError).category).toBe('range-unsupported');
    }
  });

  it('rejects mismatched ranges and versions', () => {
    expect(() =>
      validateKavitaRangeResponse(partialResponse(new Uint8Array(10), 11, 20, 100), 10, 19, 100),
    ).toThrow(KavitaError);
    expect(() =>
      validateKavitaRangeResponse(partialResponse(new Uint8Array(10), 10, 19, 101), 10, 19, 100),
    ).toThrow(KavitaError);
  });
});

describe('RemoteFile authenticated aligned ranges', () => {
  it('uses 128 KiB aligned requests and deduplicates concurrent chunks', async () => {
    const total = 300_000;
    const source = Uint8Array.from({ length: total }, (_, index) => index % 251);
    const ranges: string[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range')!;
      ranges.push(range);
      const [, startText, endText] = range.match(/^bytes=(\d+)-(\d+)$/)!;
      const start = Number(startText);
      const end = Number(endText);
      return partialResponse(source.slice(start, end + 1), start, end, total);
    });
    const file = await new RemoteFile(
      'https://kavita.test/api/Download/chapter?chapterId=1',
      'book.epub',
      'application/epub+zip',
      Date.now(),
      {
        fetch: fetcher,
        headers: { 'x-api-key': 'secret' },
        knownSize: total,
        strictRange: true,
        alignChunks: true,
        chunkSize: 128 * 1024,
      },
    ).open();

    const [first, second] = await Promise.all([
      file.slice(130_000, 140_000).arrayBuffer(),
      file.slice(130_100, 130_200).arrayBuffer(),
    ]);
    expect(new Uint8Array(first)).toEqual(source.slice(130_000, 140_000));
    expect(new Uint8Array(second)).toEqual(source.slice(130_100, 130_200));
    expect(ranges).toEqual(['bytes=0-131071', 'bytes=131072-262143']);
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('x-api-key')).toBe('secret');
  });

  it('refuses HTTP 200 full-file responses', async () => {
    const file = await new RemoteFile('https://kavita.test/book', 'book.epub', '', Date.now(), {
      fetch: async () => new Response(new ArrayBuffer(100), { status: 200 }),
      knownSize: 100,
      strictRange: true,
      alignChunks: true,
    }).open();
    await expect(file.slice(0, 10).arrayBuffer()).rejects.toThrow('refusing a possible full-file');
  });
});
