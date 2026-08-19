import { DocumentLoader } from '@/libs/document';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { getLocalBookFilename } from '@/utils/book';
import type { ProgressPayload } from '@/utils/transfer';
import { KavitaError } from './errors';
import { openKavitaBookFile } from './content';

export async function downloadKavitaBookOffline(
  appService: AppService,
  book: Book,
  onProgress?: (progress: ProgressPayload) => void,
  signal?: AbortSignal,
): Promise<Book> {
  const source = book.kavitaSource;
  if (!source) throw new KavitaError('not-found', 'Book has no Kavita source');
  const finalPath = getLocalBookFilename(book);
  const tempPath = `${finalPath}.kavita-part`;
  const startedAt = Date.now();
  const remote = await openKavitaBookFile(book, {
    signal,
    disableCache: true,
    onProgress: (loaded, total) => {
      const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
      onProgress?.({ progress: loaded, total, transferSpeed: loaded / seconds });
    },
  });
  try {
    await appService.writeFile(tempPath, 'Books', remote);
    signal?.throwIfAborted();
    const temporary = await appService.openFile(tempPath, 'Books');
    if (temporary.size !== source.fileBytes) {
      throw new KavitaError(
        'invalid-response',
        `Offline EPUB size ${temporary.size} does not match Kavita size ${source.fileBytes}`,
      );
    }
    const opened = await new DocumentLoader(temporary).open();
    if (opened.format !== 'EPUB') {
      throw new KavitaError('invalid-response', 'Downloaded Kavita file is not a valid EPUB');
    }
    await appService.writeFile(finalPath, 'Books', temporary);
    await appService.deleteFile(tempPath, 'Books');
    return {
      ...book,
      downloadedAt: Date.now(),
      kavitaSource: { ...source, offlineState: 'offline' },
    };
  } catch (error) {
    await appService.deleteFile(tempPath, 'Books').catch(() => undefined);
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new KavitaError(
        'quota',
        'Storage quota is insufficient for this offline EPUB',
        undefined,
        {
          cause: error,
        },
      );
    }
    throw error;
  } finally {
    await remote.close();
  }
}

export async function removeKavitaOfflineBook(appService: AppService, book: Book): Promise<Book> {
  const source = book.kavitaSource;
  if (!source) return book;
  await appService.deleteFile(getLocalBookFilename(book), 'Books').catch(() => undefined);
  return {
    ...book,
    downloadedAt: null,
    kavitaSource: {
      ...source,
      offlineState: source.offlineState === 'orphaned' ? 'orphaned' : 'remote',
    },
  };
}
