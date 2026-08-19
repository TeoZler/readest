import { afterEach, describe, expect, it } from 'vitest';
import {
  extractKavitaCoverBlob,
  fetchKavitaCoverApiBlob,
  resetKavitaCoverFailureState,
} from '@/services/kavita/cover';
import {
  clearKavitaRuntimeConnections,
  registerKavitaRuntimeConnection,
} from '@/services/kavita/runtime';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';

const EPUB_URL = new URL('../../fixtures/data/sample-alice.epub', import.meta.url).href;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKavitaRuntimeConnections();
  resetKavitaCoverFailureState();
});

const makeBook = (bytes: number): Book => ({
  hash: 'kavita-alice',
  format: 'EPUB',
  title: 'Alice',
  author: 'Lewis Carroll',
  createdAt: 1,
  updatedAt: 1,
  kavitaSource: {
    kind: 'kavita',
    connectionId: 'connection',
    serverId: 'server',
    libraryId: 2,
    libraryName: 'Books',
    seriesId: 3,
    seriesName: 'Alice',
    volumeId: 4,
    chapterId: 338,
    fileId: 5,
    fileBytes: bytes,
    fileCreated: '2026-08-19T00:00:00Z',
    fileExtension: '.epub',
    koreaderHash: 'ko-hash',
    offlineState: 'remote',
    lastSeenAt: 1,
  },
});

describe('Kavita secure EPUB cover extraction', () => {
  it('fetches the Kavita cover API with query and header authentication then decodes it', async () => {
    const png = await originalFetch(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    ).then((response) => response.arrayBuffer());
    registerKavitaRuntimeConnection({
      config: {
        id: 'connection',
        serverId: 'server',
        name: 'Kavita',
        defaultBaseUrl: 'https://kavita.test',
        selectedLibraryIds: [2],
        progressStrategy: 'ask',
        createdAt: 1,
        updatedAt: 1,
      },
      device: {
        connectionId: 'connection',
        allowInvalidTls: false,
        cacheEnabled: false,
        cacheCapacityBytes: 0,
      },
      authKey: 'top-secret',
    });
    const calls: string[] = [];
    const result = await fetchKavitaCoverApiBlob(
      makeBook(1234),
      new AbortController().signal,
      {},
      {
        transport: async (url, init) => {
          calls.push(url);
          expect(new URL(url).pathname).toBe('/api/Image/chapter-cover');
          expect(new URL(url).searchParams.get('chapterId')).toBe('338');
          expect(new URL(url).searchParams.get('apiKey')).toBe('top-secret');
          expect(new Headers(init?.headers).get('x-api-key')).toBe('top-secret');
          expect(init?.cache).toBe('no-store');
          expect(init?.credentials).toBe('omit');
          expect(init?.referrerPolicy).toBe('no-referrer');
          return new Response(png.slice(0), {
            status: 200,
            headers: { 'Content-Type': 'image/png', ETag: 'cover-v1' },
          });
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(result.notModified).toBe(false);
    expect(result.etag).toBe('cover-v1');
    expect(result.blob?.type).toBe('image/png');
    expect(result.blob?.size).toBeGreaterThan(0);
  });

  it('decodes a visible cover from strict authenticated ranges without putting the key in a URL', async () => {
    const source = new Uint8Array(await (await originalFetch(EPUB_URL)).arrayBuffer());
    const ranges: Array<{ start: number; end: number }> = [];
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      expect(url).not.toContain('top-secret');
      expect(url).toContain('/api/Download/chapter?chapterId=338');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('top-secret');
      const match = new Headers(init?.headers).get('Range')?.match(/^bytes=(\d+)-(\d+)$/);
      expect(match).toBeTruthy();
      const start = Number(match![1]);
      const end = Math.min(Number(match![2]), source.byteLength - 1);
      ranges.push({ start, end });
      return new Response(source.slice(start, end + 1).buffer, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${source.byteLength}`,
          'Content-Type': 'application/epub+zip',
        },
      });
    };
    registerKavitaRuntimeConnection({
      config: {
        id: 'connection',
        serverId: 'server',
        name: 'Kavita',
        defaultBaseUrl: 'https://kavita.test',
        selectedLibraryIds: [2],
        progressStrategy: 'ask',
        createdAt: 1,
        updatedAt: 1,
      },
      device: {
        connectionId: 'connection',
        allowInvalidTls: false,
        cacheEnabled: false,
        cacheCapacityBytes: 0,
      },
      authKey: 'top-secret',
    });

    const cover = await extractKavitaCoverBlob(
      makeBook(source.byteLength),
      new AbortController().signal,
      { exists: async () => false } as unknown as AppService,
    );
    expect(cover.size).toBeGreaterThan(0);
    expect(cover.type).toMatch(/^image\//);
    expect(ranges.length).toBeGreaterThan(0);
    expect(urls).not.toHaveLength(0);

    for (const { start, end } of ranges) {
      expect(end - start + 1).toBeLessThan(source.byteLength);
    }
    expect(ranges).not.toContainEqual({ start: 0, end: source.byteLength - 1 });

    const objectUrl = URL.createObjectURL(cover);
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Extracted Kavita cover did not decode'));
      image.src = objectUrl;
    });
    expect(image.naturalWidth).toBeGreaterThan(0);
    expect(image.naturalHeight).toBeGreaterThan(0);
    URL.revokeObjectURL(objectUrl);
  });
});
