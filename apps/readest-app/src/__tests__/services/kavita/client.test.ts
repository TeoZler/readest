import { describe, expect, it, vi } from 'vitest';
import { KavitaClient } from '@/services/kavita/client';
import { diagnoseKavitaConnection } from '@/services/kavita/diagnostics';
import type { KavitaTransport } from '@/services/kavita/transport';
import { KavitaMangaFormat } from '@/services/kavita/types';

const jsonResponse = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });

describe('KavitaClient', () => {
  it('uses x-api-key for ordinary APIs and isolates the official plugin query credential', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const transport: KavitaTransport = async (url, init) => {
      requests.push({ url, headers: new Headers(init?.headers) });
      return url.includes('/api/Plugin/authenticate')
        ? jsonResponse({ username: 'reader', token: 'jwt', kavitaVersion: '0.9.0.2' })
        : jsonResponse([]);
    };
    const client = new KavitaClient('https://books.example.test', 'top-secret', transport);
    await client.getLibraries();
    expect(requests[0]!.url).not.toContain('top-secret');
    expect(requests[0]!.headers.get('x-api-key')).toBe('top-secret');

    await client.authenticatePlugin();
    expect(requests[1]!.url).toContain('/api/Plugin/authenticate');
    expect(requests[1]!.url).toContain('apiKey=top-secret');

    const cover = client.getChapterCoverRequest(7);
    expect(cover.url).not.toContain('top-secret');
    expect(cover.url).toContain('apiKey=readest-header-auth');
    expect(cover.headers.get('x-api-key')).toBe('top-secret');
  });

  it('parses the required Pagination header', async () => {
    const transport: KavitaTransport = async () =>
      jsonResponse([], {
        headers: {
          Pagination: JSON.stringify({
            currentPage: 1,
            pageSize: 50,
            totalCount: 0,
            totalPages: 0,
          }),
        },
      });
    const client = new KavitaClient('https://books.example.test', 'key', transport);
    await expect(client.getSeriesPage(2, 1, 50)).resolves.toMatchObject({
      items: [],
      pagination: { currentPage: 1, totalCount: 0 },
    });
  });

  it('normalizes Kavita itemsPerPage and totalItems pagination names', async () => {
    const transport: KavitaTransport = async () =>
      jsonResponse([], {
        headers: {
          Pagination: JSON.stringify({
            currentPage: 1,
            itemsPerPage: 50,
            totalItems: 148,
            totalPages: 3,
          }),
        },
      });
    const client = new KavitaClient('https://books.example.test', 'key', transport);
    await expect(client.getSeriesPage(2, 1, 50)).resolves.toMatchObject({
      pagination: { pageSize: 50, totalCount: 148, totalPages: 3 },
    });
  });

  it('fails safely if a proxy rewrites Range to HTTP 200', async () => {
    const transport: KavitaTransport = async () =>
      new Response(new ArrayBuffer(100), { status: 200 });
    const client = new KavitaClient('https://books.example.test', 'key', transport);
    await expect(client.probeChapterRange(1, 100)).rejects.toMatchObject({
      category: 'range-unsupported',
    });
  });
});

describe('Kavita connection diagnostics', () => {
  it('verifies version, visible library, Download permission, and a real EPUB Range', async () => {
    const seen: string[] = [];
    const transport: KavitaTransport = vi.fn(async (url, init) => {
      seen.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/authenticate')) {
        return jsonResponse({ username: 'reader', token: 'jwt', kavitaVersion: '0.9.0.2' });
      }
      if (parsed.pathname.endsWith('/libraries')) {
        return jsonResponse([{ id: 2, name: 'Books', type: 2, lastScanned: '2026-01-01' }]);
      }
      if (parsed.pathname.endsWith('/all-v2')) {
        return jsonResponse(
          [
            {
              id: 10,
              name: 'Series',
              format: KavitaMangaFormat.Epub,
              libraryId: 2,
              libraryName: 'Books',
              created: '2026-01-01',
              lastChapterAddedUtc: '2026-01-01',
            },
          ],
          {
            headers: {
              Pagination: JSON.stringify({
                currentPage: 1,
                pageSize: 50,
                totalCount: 1,
                totalPages: 1,
              }),
            },
          },
        );
      }
      if (parsed.pathname.endsWith('/volumes')) {
        return jsonResponse([
          {
            id: 20,
            name: 'Volume',
            seriesId: 10,
            lastModifiedUtc: '2026-01-01',
            chapters: [
              {
                id: 30,
                title: 'Book',
                titleName: 'Book',
                volumeId: 20,
                volumeTitle: 'Volume',
                summary: null,
                language: 'en',
                createdUtc: '2026-01-01',
                lastModifiedUtc: '2026-01-01',
                files: [
                  {
                    id: 40,
                    filePath: '/a.epub',
                    pages: 1,
                    bytes: 100,
                    format: KavitaMangaFormat.Epub,
                    created: '2026-01-01',
                    extension: '.epub',
                    koreaderHash: 'hash',
                  },
                ],
                writers: [],
                genres: [],
                tags: [],
                format: KavitaMangaFormat.Epub,
              },
            ],
          },
        ]);
      }
      if (parsed.pathname.endsWith('/chapter-size')) return jsonResponse(100);
      if (parsed.pathname.endsWith('/chapter')) {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=0-99');
        return new Response(new ArrayBuffer(100), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-99/100' },
        });
      }
      return new Response(null, { status: 404 });
    });

    const result = await diagnoseKavitaConnection({
      baseUrl: 'https://books.example.test',
      authKey: 'key',
      transport,
      existingServerId: 'readest-server-id',
    });
    expect(result.server.serverId).toBe('readest-server-id');
    expect(result.representative.chapter.id).toBe(30);
    expect(seen.some((url) => url.includes('/api/Download/chapter?'))).toBe(true);
  });

  it('rejects unsupported Kavita versions before scanning libraries', async () => {
    const transport: KavitaTransport = async () =>
      jsonResponse({ username: 'reader', token: 'jwt', kavitaVersion: '0.8.7' });
    await expect(
      diagnoseKavitaConnection({
        baseUrl: 'https://books.example.test',
        authKey: 'key',
        transport,
      }),
    ).rejects.toMatchObject({ category: 'unsupported-version' });
  });
});
