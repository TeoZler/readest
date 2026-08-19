import type { Book } from '@/types/book';
import { RemoteFile, type RemoteFileRangeCache } from '@/utils/file';
import { KavitaClient } from './client';
import { KAVITA_RANGE_CHUNK_SIZE } from './constants';
import { KavitaError } from './errors';
import { getKavitaRuntimeBaseUrl, getKavitaRuntimeConnection } from './runtime';
import { createKavitaTransport } from './transport';
import { KavitaPersistentRangeCache } from './rangeCache';

export interface OpenKavitaBookOptions {
  signal?: AbortSignal;
  rangeCache?: RemoteFileRangeCache;
  disableCache?: boolean;
  onProgress?: (loaded: number, total: number) => void;
}

export async function openKavitaBookFile(
  book: Book,
  options: OpenKavitaBookOptions = {},
): Promise<RemoteFile> {
  const source = book.kavitaSource;
  if (!source) throw new KavitaError('not-found', 'Book has no Kavita source');
  const runtime = getKavitaRuntimeConnection(source.connectionId);
  if (!runtime) {
    throw new KavitaError('authentication', 'Kavita connection is not unlocked on this device');
  }
  if (runtime.config.serverId !== source.serverId) {
    throw new KavitaError('invalid-response', 'Kavita server identity no longer matches this book');
  }
  const transport = createKavitaTransport({ allowInvalidTls: runtime.device.allowInvalidTls });
  const client = new KavitaClient(getKavitaRuntimeBaseUrl(runtime), runtime.authKey, transport);
  const filename = `${book.sourceTitle || book.title}.epub`;
  return await new RemoteFile(
    client.getChapterDownloadUrl(source.chapterId),
    filename,
    'application/epub+zip',
    Date.parse(source.fileCreated) || book.updatedAt,
    {
      fetch: client.createAuthenticatedTransport(),
      knownSize: source.fileBytes,
      strictRange: true,
      alignChunks: true,
      chunkSize: KAVITA_RANGE_CHUNK_SIZE,
      retries: 2,
      signal: options.signal,
      onProgress: options.onProgress,
      rangeCache: options.disableCache
        ? undefined
        : (options.rangeCache ??
          (runtime.device.cacheEnabled
            ? new KavitaPersistentRangeCache(source, runtime.device.cacheCapacityBytes)
            : undefined)),
    },
  ).open();
}
