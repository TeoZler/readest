import type { Book } from '@/types/book';
import type { KavitaClient } from './client';
import { mapKavitaChapterToBook, mergeKavitaBookMetadata } from './mapper';
import type { KavitaConnectionConfig, KavitaLibraryDto, KavitaSeriesDto } from './types';

export interface KavitaCatalogSyncStage {
  books: Book[];
  completedPages: number;
  totalPages: number;
  final: boolean;
}

export interface KavitaCatalogSyncOptions {
  client: KavitaClient;
  connection: KavitaConnectionConfig;
  currentBooks: Book[];
  libraries?: KavitaLibraryDto[];
  pageSize?: number;
  volumeConcurrency?: number;
  now?: number;
  signal?: AbortSignal;
  persistStage?: (stage: KavitaCatalogSyncStage) => Promise<void>;
}

export interface KavitaCatalogSyncResult {
  books: Book[];
  added: number;
  updated: number;
  removed: number;
  orphaned: number;
  scanned: number;
  completedPages: number;
  totalPages: number;
}

const runPool = async <T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
      while (cursor < values.length) {
        const value = values[cursor++]!;
        await worker(value);
      }
    }),
  );
};

const mergePage = (
  books: Book[],
  incoming: Book[],
): { books: Book[]; added: number; updated: number } => {
  const byHash = new Map(books.map((book) => [book.hash, book]));
  let added = 0;
  let updated = 0;
  for (const book of incoming) {
    const existing = byHash.get(book.hash);
    if (existing) {
      byHash.set(book.hash, mergeKavitaBookMetadata(existing, book));
      updated += 1;
    } else {
      byHash.set(book.hash, book);
      added += 1;
    }
  }
  return { books: Array.from(byHash.values()), added, updated };
};

/**
 * Incrementally imports Kavita pages while making deletion a commit-only step.
 * If any page or volume request fails, already discovered additions/updates may
 * remain visible, but no existing Kavita row is removed.
 */
export async function syncKavitaCatalog(
  options: KavitaCatalogSyncOptions,
): Promise<KavitaCatalogSyncResult> {
  const {
    client,
    connection,
    signal,
    persistStage,
    pageSize = 50,
    volumeConcurrency = 4,
    now = Date.now(),
  } = options;
  const visibleLibraries = options.libraries ?? (await client.getLibraries(signal));
  const selected = new Set(connection.selectedLibraryIds);
  const libraries = visibleLibraries.filter((library) => selected.has(library.id));
  let working = options.currentBooks.slice();
  const seenHashes = new Set<string>();
  let added = 0;
  let updated = 0;
  let scanned = 0;
  let completedPages = 0;
  let totalPages = 0;

  for (const library of libraries) {
    let pageNumber = 1;
    let libraryPages = 1;
    do {
      signal?.throwIfAborted();
      const page = await client.getSeriesPage(library.id, pageNumber, pageSize, signal);
      libraryPages = Math.max(1, page.pagination.totalPages);
      if (pageNumber === 1) totalPages += libraryPages;
      const mapped: Book[] = [];
      await runPool(page.items, volumeConcurrency, async (series: KavitaSeriesDto) => {
        const volumes = await client.getVolumes(series.id, signal);
        for (const volume of volumes) {
          for (const chapter of volume.chapters ?? []) {
            const book = mapKavitaChapterToBook(
              connection.id,
              connection.serverId,
              library.name ?? `Library ${library.id}`,
              series,
              volume,
              chapter,
              now,
            );
            if (book) mapped.push(book);
          }
        }
      });
      for (const book of mapped) seenHashes.add(book.hash);
      scanned += mapped.length;
      const merged = mergePage(working, mapped);
      working = merged.books;
      added += merged.added;
      updated += merged.updated;
      completedPages += 1;
      await persistStage?.({
        books: working,
        completedPages,
        totalPages,
        final: false,
      });
      pageNumber += 1;
    } while (pageNumber <= libraryPages);
  }

  let removed = 0;
  let orphaned = 0;
  working = working.flatMap((book) => {
    const source = book.kavitaSource;
    if (!source || source.connectionId !== connection.id || seenHashes.has(book.hash))
      return [book];
    if (source.offlineState === 'offline') {
      orphaned += 1;
      return [{ ...book, kavitaSource: { ...source, offlineState: 'orphaned' } }];
    }
    removed += 1;
    return [];
  });

  await persistStage?.({
    books: working,
    completedPages,
    totalPages,
    final: true,
  });
  return { books: working, added, updated, removed, orphaned, scanned, completedPages, totalPages };
}
