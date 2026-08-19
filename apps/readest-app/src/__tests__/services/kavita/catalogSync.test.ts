import { describe, expect, it, vi } from 'vitest';
import { syncKavitaCatalog } from '@/services/kavita/catalogSync';
import { mapKavitaChapterToBook } from '@/services/kavita/mapper';
import type { KavitaClient } from '@/services/kavita/client';
import type {
  KavitaConnectionConfig,
  KavitaSeriesDto,
  KavitaVolumeDto,
} from '@/services/kavita/types';
import { KavitaMangaFormat } from '@/services/kavita/types';

const connection: KavitaConnectionConfig = {
  id: 'connection',
  serverId: 'server',
  name: 'Home',
  defaultBaseUrl: 'https://books.example.test',
  selectedLibraryIds: [2],
  progressStrategy: 'ask',
  createdAt: 1,
  updatedAt: 1,
};

const series = (id: number): KavitaSeriesDto => ({
  id,
  name: `Series ${id}`,
  format: KavitaMangaFormat.Epub,
  libraryId: 2,
  libraryName: 'Books',
  created: '2026-01-01',
  lastChapterAddedUtc: '2026-01-01',
});

const volume = (id: number): KavitaVolumeDto => ({
  id,
  name: '1',
  seriesId: id,
  lastModifiedUtc: '2026-01-01',
  chapters: [
    {
      id,
      title: `Book ${id}`,
      titleName: `Book ${id}`,
      volumeId: id,
      volumeTitle: '1',
      summary: null,
      language: 'en',
      createdUtc: '2026-01-01',
      lastModifiedUtc: '2026-01-01',
      files: [
        {
          id,
          filePath: `/book-${id}.epub`,
          pages: 1,
          bytes: 100,
          format: KavitaMangaFormat.Epub,
          created: '2026-01-01',
          extension: '.epub',
          koreaderHash: `hash-${id}`,
        },
      ],
      writers: [],
      genres: [],
      tags: [],
      format: KavitaMangaFormat.Epub,
    },
  ],
});

const existingBook = (id: number, state: 'remote' | 'offline' = 'remote') => {
  const book = mapKavitaChapterToBook(
    'connection',
    'server',
    'Books',
    series(id),
    volume(id),
    volume(id).chapters![0]!,
    10,
  )!;
  book.kavitaSource!.offlineState = state;
  return book;
};

describe('syncKavitaCatalog', () => {
  it('persists staged additions but never deletes after a later page fails', async () => {
    const persist = vi.fn();
    const client = {
      getLibraries: vi.fn().mockResolvedValue([{ id: 2, name: 'Books' }]),
      getSeriesPage: vi
        .fn()
        .mockResolvedValueOnce({
          items: [series(1)],
          pagination: { currentPage: 1, pageSize: 1, totalCount: 2, totalPages: 2 },
        })
        .mockRejectedValueOnce(new Error('network down')),
      getVolumes: vi.fn().mockImplementation((id: number) => Promise.resolve([volume(id)])),
    } as unknown as KavitaClient;

    await expect(
      syncKavitaCatalog({
        client,
        connection,
        currentBooks: [existingBook(99)],
        persistStage: persist,
      }),
    ).rejects.toThrow('network down');
    expect(persist).toHaveBeenCalledTimes(1);
    const staged = persist.mock.calls[0]![0].books;
    expect(staged.some((book: { hash: string }) => book.hash === existingBook(99).hash)).toBe(true);
    expect(staged.some((book: { hash: string }) => book.hash === existingBook(1).hash)).toBe(true);
  });

  it('applies deletion only after a complete scan and preserves offline books as orphaned', async () => {
    const client = {
      getLibraries: vi.fn().mockResolvedValue([{ id: 2, name: 'Books' }]),
      getSeriesPage: vi.fn().mockResolvedValue({
        items: [series(1)],
        pagination: { currentPage: 1, pageSize: 50, totalCount: 1, totalPages: 1 },
      }),
      getVolumes: vi.fn().mockResolvedValue([volume(1)]),
    } as unknown as KavitaClient;
    const result = await syncKavitaCatalog({
      client,
      connection,
      currentBooks: [existingBook(98), existingBook(99, 'offline')],
    });
    expect(result.removed).toBe(1);
    expect(result.orphaned).toBe(1);
    expect(
      result.books.find((book) => book.hash === existingBook(99).hash)?.kavitaSource?.offlineState,
    ).toBe('orphaned');
  });
});
