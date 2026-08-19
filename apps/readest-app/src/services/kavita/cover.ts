import environmentConfig from '@/services/environment';
import { DocumentLoader, type BookDoc } from '@/libs/document';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { getCoverFilename, getLocalBookFilename } from '@/utils/book';
import { svg2png } from '@/utils/svg';
import { KavitaError } from './errors';
import { openKavitaBookFile } from './content';

const COVER_MARKER_FILENAME = 'kavita-cover-version.txt';
const MAX_MEMORY_COVERS = 64;
const MAX_CONCURRENT_EXTRACTIONS = 4;

interface KavitaCoverCacheEntry {
  key: string;
  connectionId: string;
  controller: AbortController;
  promise: Promise<string>;
  refs: number;
  settled: boolean;
  objectUrl?: string;
  lastAccessedAt: number;
}

export interface KavitaCoverLease {
  url: Promise<string>;
  release(): void;
}

const coverEntries = new Map<string, KavitaCoverCacheEntry>();
const coverWaiters: Array<() => void> = [];
let activeExtractions = 0;

const sourceVersion = (book: Book): string => {
  const source = book.kavitaSource;
  if (!source) return '';
  return [
    source.serverId,
    source.chapterId,
    source.fileId,
    source.fileBytes,
    source.fileCreated,
  ].join(':');
};

const cacheKey = (book: Book): string => {
  const source = book.kavitaSource!;
  return `${source.connectionId}:${sourceVersion(book)}`;
};

const markerFilename = (book: Book): string => `${book.hash}/${COVER_MARKER_FILENAME}`;

async function withExtractionSlot<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  if (activeExtractions >= MAX_CONCURRENT_EXTRACTIONS) {
    await new Promise<void>((resolve) => coverWaiters.push(resolve));
  }
  signal.throwIfAborted();
  activeExtractions += 1;
  try {
    return await task();
  } finally {
    activeExtractions -= 1;
    coverWaiters.shift()?.();
  }
}

async function readCachedCoverUrl(
  appService: AppService,
  book: Book,
  version: string,
): Promise<string | null> {
  try {
    if (!(await appService.exists(getCoverFilename(book), 'Books'))) return null;
    if (!(await appService.exists(markerFilename(book), 'Books'))) return null;
    const storedVersion = await appService.readFile(markerFilename(book), 'Books', 'text');
    if (storedVersion !== version) return null;
    return book.coverImageUrl || (await appService.generateCoverImageUrl(book));
  } catch {
    return null;
  }
}

async function openCoverDocument(
  appService: AppService,
  book: Book,
  signal: AbortSignal,
): Promise<{ document: BookDoc; close: () => Promise<void> }> {
  const localFilename = getLocalBookFilename(book);
  if (
    (book.kavitaSource?.offlineState === 'offline' ||
      book.kavitaSource?.offlineState === 'orphaned') &&
    (await appService.exists(localFilename, 'Books'))
  ) {
    const local = await appService.openFile(localFilename, 'Books');
    const opened = await new DocumentLoader(local).open();
    if (opened.format !== 'EPUB') {
      await opened.book.destroy?.();
      throw new KavitaError('invalid-response', 'Kavita book is not EPUB');
    }
    return {
      document: opened.book,
      close: async () => {
        await opened.book.destroy?.();
      },
    };
  }

  const remote = await openKavitaBookFile(book, { signal });
  try {
    const opened = await new DocumentLoader(remote).open();
    if (opened.format !== 'EPUB') {
      await opened.book.destroy?.();
      throw new KavitaError('invalid-response', 'Kavita book is not EPUB');
    }
    return {
      document: opened.book,
      close: async () => {
        await opened.book.destroy?.();
        await remote.close();
      },
    };
  } catch (error) {
    await remote.close();
    throw error;
  }
}

export async function extractKavitaCoverBlob(
  book: Book,
  signal: AbortSignal,
  appService?: AppService,
): Promise<Blob> {
  if (!book.kavitaSource) throw new KavitaError('not-found', 'Book has no Kavita source');
  const service = appService ?? (await environmentConfig.getAppService());
  const opened = await openCoverDocument(service, book, signal);
  try {
    signal.throwIfAborted();
    let cover = await opened.document.getCover();
    signal.throwIfAborted();
    if (!cover?.size || !cover.type.startsWith('image/')) {
      throw new KavitaError('invalid-response', 'Kavita EPUB has no usable cover image');
    }
    if (cover.type === 'image/svg+xml') cover = await svg2png(cover);
    return cover;
  } finally {
    await opened.close();
  }
}

async function persistCover(appService: AppService, book: Book, cover: Blob, version: string) {
  try {
    await appService.createDir(book.hash, 'Books', true);
    await appService.deleteFile(markerFilename(book), 'Books').catch(() => undefined);
    await appService.writeFile(getCoverFilename(book), 'Books', await cover.arrayBuffer());
    await appService.writeFile(markerFilename(book), 'Books', version);
  } catch (error) {
    // The in-memory object URL remains usable when device storage is full or
    // unavailable. Never include request URLs or credentials in this warning.
    console.warn('[Kavita] Could not persist the extracted EPUB cover', error);
  }
}

async function loadCover(
  book: Book,
  signal: AbortSignal,
): Promise<{ url: string; owned: boolean }> {
  const appService = await environmentConfig.getAppService();
  const version = sourceVersion(book);
  const cached = await readCachedCoverUrl(appService, book, version);
  if (cached) return { url: cached, owned: false };

  const cover = await withExtractionSlot(signal, () => extractKavitaCoverBlob(book, signal));
  signal.throwIfAborted();
  await persistCover(appService, book, cover, version);
  signal.throwIfAborted();
  return { url: URL.createObjectURL(cover), owned: true };
}

function evictIdleCovers() {
  if (coverEntries.size <= MAX_MEMORY_COVERS) return;
  const idle = Array.from(coverEntries.values())
    .filter((entry) => entry.settled && entry.refs === 0)
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  while (coverEntries.size > MAX_MEMORY_COVERS && idle.length > 0) {
    const entry = idle.shift()!;
    coverEntries.delete(entry.key);
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  }
}

export function acquireKavitaCoverUrl(book: Book): KavitaCoverLease | null {
  const source = book.kavitaSource;
  if (!source) return null;
  const key = cacheKey(book);
  let entry = coverEntries.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = {
      key,
      connectionId: source.connectionId,
      controller,
      refs: 0,
      settled: false,
      lastAccessedAt: Date.now(),
      promise: Promise.resolve(''),
    };
    const created = entry;
    created.promise = loadCover(book, controller.signal)
      .then(({ url, owned }) => {
        created.settled = true;
        if (owned) created.objectUrl = url;
        evictIdleCovers();
        return url;
      })
      .catch((error) => {
        created.settled = true;
        if (coverEntries.get(key) === created) coverEntries.delete(key);
        throw error;
      });
    coverEntries.set(key, created);
    entry = created;
  }

  entry.refs += 1;
  entry.lastAccessedAt = Date.now();
  let released = false;
  return {
    url: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry!.refs = Math.max(0, entry!.refs - 1);
      entry!.lastAccessedAt = Date.now();
      if (entry!.refs === 0 && !entry!.settled) entry!.controller.abort();
      evictIdleCovers();
    },
  };
}

export function clearKavitaCoverUrls(connectionId?: string): void {
  for (const [key, entry] of coverEntries) {
    if (connectionId && entry.connectionId !== connectionId) continue;
    entry.controller.abort();
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    coverEntries.delete(key);
  }
}

export async function deleteStoredKavitaCovers(
  appService: AppService,
  books: Book[],
): Promise<void> {
  await Promise.all(
    books.flatMap((book) => [
      appService.deleteFile(getCoverFilename(book), 'Books').catch(() => undefined),
      appService.deleteFile(markerFilename(book), 'Books').catch(() => undefined),
    ]),
  );
}
