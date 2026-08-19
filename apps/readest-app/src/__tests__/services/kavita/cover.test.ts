import { afterEach, describe, expect, it } from 'vitest';
import { fetchKavitaCoverApiBlob, resetKavitaCoverFailureState } from '@/services/kavita/cover';
import {
  clearKavitaRuntimeConnections,
  registerKavitaRuntimeConnection,
} from '@/services/kavita/runtime';
import type { Book } from '@/types/book';

const book: Book = {
  hash: 'book',
  format: 'EPUB',
  title: 'Book',
  author: 'Author',
  createdAt: 1,
  updatedAt: 1,
  kavitaSource: {
    kind: 'kavita',
    connectionId: 'connection',
    serverId: 'server',
    libraryId: 1,
    libraryName: 'Library',
    seriesId: 2,
    seriesName: 'Series',
    volumeId: 3,
    chapterId: 4,
    fileId: 5,
    fileBytes: 100,
    fileCreated: '2026-08-19T00:00:00Z',
    fileExtension: '.epub',
    koreaderHash: 'hash',
    offlineState: 'remote',
    lastSeenAt: 1,
  },
};

const register = () =>
  registerKavitaRuntimeConnection({
    config: {
      id: 'connection',
      serverId: 'server',
      name: 'Kavita',
      defaultBaseUrl: 'https://kavita.test',
      selectedLibraryIds: [1],
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
    authKey: 'secret',
  });

afterEach(() => {
  clearKavitaRuntimeConnections();
  resetKavitaCoverFailureState();
});

describe('Kavita cover API retry policy', () => {
  it('retries transient GET failures three times', async () => {
    register();
    let calls = 0;
    await expect(
      fetchKavitaCoverApiBlob(
        book,
        new AbortController().signal,
        {},
        {
          transport: async () => {
            calls += 1;
            return new Response('', { status: 503 });
          },
          sleep: async () => undefined,
          random: () => 0.5,
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(3);
  });

  it('does not retry authentication failures and latches the connection', async () => {
    register();
    let calls = 0;
    const request = () =>
      fetchKavitaCoverApiBlob(
        book,
        new AbortController().signal,
        {},
        {
          transport: async () => {
            calls += 1;
            return new Response('', { status: 401 });
          },
          sleep: async () => undefined,
        },
      );
    await expect(request()).rejects.toMatchObject({ category: 'authentication' });
    await expect(request()).rejects.toMatchObject({ category: 'authentication' });
    expect(calls).toBe(1);
  });

  it('honors 304 validators without reading a body', async () => {
    register();
    const result = await fetchKavitaCoverApiBlob(
      book,
      new AbortController().signal,
      { etag: 'cover-v1' },
      {
        transport: async (_url, init) => {
          expect(new Headers(init?.headers).get('If-None-Match')).toBe('cover-v1');
          return new Response(null, { status: 304 });
        },
      },
    );
    expect(result).toEqual({ notModified: true });
  });
});
