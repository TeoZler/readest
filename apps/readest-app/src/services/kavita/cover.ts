import environmentConfig, { isTauriAppPlatform } from '@/services/environment';
import { eventDispatcher } from '@/utils/event';
import { DocumentLoader, type BookDoc } from '@/libs/document';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { getCoverFilename, getLocalBookFilename } from '@/utils/book';
import { svg2png } from '@/utils/svg';
import { KavitaClient } from './client';
import {
  deleteKavitaCoverCacheEntries,
  kavitaCoverCacheKey,
  kavitaCoverSourceVersion,
  readKavitaCoverCache,
  readKavitaCoverCacheEntry,
  touchKavitaCoverCacheValidation,
  writeKavitaCoverCache,
  type KavitaCoverCacheEntry as PersistentCoverEntry,
} from './coverCache';
import { KavitaError, classifyKavitaHttpError, classifyKavitaNetworkError } from './errors';
import { openKavitaBookFile } from './content';
import {
  getKavitaRuntimeBaseUrl,
  getKavitaRuntimeConnection,
  type KavitaRuntimeConnection,
} from './runtime';
import { createKavitaTransport, type KavitaTransport } from './transport';
import { fetchNativeKavitaCover } from './nativeCoverTransport';
import { AbortableTaskPool } from './abortableTaskPool';

const LEGACY_COVER_MARKER = 'kavita-cover-version.txt';
const MAX_CONCURRENT_FETCHES = 6;
const MAX_COVER_BYTES = 16 * 1024 * 1024;
const REVALIDATE_AFTER_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [0, 500, 1500] as const;
const COOLDOWN_DELAYS_MS = [30_000, 120_000, 600_000] as const;
const PERSIST_COVER_DELAY_MS = 10_000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DIRECT_FALLBACK_STATUSES = new Set([400, 404, 405, 410, 415]);
const RETRY_FALLBACK_STATUSES = new Set([408, 500, 502, 503, 504]);

interface RuntimeCoverEntry {
  key: string;
  connectionId: string;
  controller: AbortController;
  promise: Promise<string>;
  refs: number;
  settled: boolean;
  objectUrl?: string;
}

interface ConnectionFailureState {
  failures: number;
  cooldownUntil: number;
  authBlocked: boolean;
}

export interface KavitaCoverLease {
  url: Promise<string>;
  release(): void;
}

export interface KavitaCoverFetchDependencies {
  transport?: KavitaTransport;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const coverEntries = new Map<string, RuntimeCoverEntry>();
const connectionFailures = new Map<string, ConnectionFailureState>();
const notifiedConnections = new Set<string>();
const coverFetchPool = new AbortableTaskPool(MAX_CONCURRENT_FETCHES);
const pendingPersistence = new Map<ReturnType<typeof setTimeout>, string>();

const sleepWithSignal = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

const legacyMarkerFilename = (book: Book): string => `${book.hash}/${LEGACY_COVER_MARKER}`;

const runtimeKey = (book: Book): string => {
  const source = book.kavitaSource!;
  return `${source.connectionId}:${kavitaCoverSourceVersion(source)}`;
};

async function withFetchSlot<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  return await coverFetchPool.run(signal, task);
}

async function unlockRuntime(book: Book): Promise<KavitaRuntimeConnection> {
  const source = book.kavitaSource;
  if (!source) throw new KavitaError('not-found', 'Book has no Kavita source');
  let runtime = getKavitaRuntimeConnection(source.connectionId);
  if (!runtime) {
    const { getKavitaConnectionRepository } = await import('./connections');
    await getKavitaConnectionRepository()?.unlock(source.connectionId);
    runtime = getKavitaRuntimeConnection(source.connectionId);
  }
  if (!runtime) {
    throw new KavitaError('authentication', 'Kavita connection is not unlocked on this device');
  }
  if (runtime.config.serverId !== source.serverId) {
    throw new KavitaError('invalid-response', 'Kavita server identity no longer matches this book');
  }
  return runtime;
}

async function decodeCover(blob: Blob): Promise<Blob> {
  if (!blob.size || blob.size > MAX_COVER_BYTES || !blob.type.toLowerCase().startsWith('image/')) {
    throw new KavitaError('invalid-response', 'Kavita returned an invalid cover image');
  }
  let decoded = blob;
  if (blob.type.toLowerCase().split(';')[0] === 'image/svg+xml') decoded = await svg2png(blob);
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(decoded);
      if (bitmap.width <= 0 || bitmap.height <= 0) throw new Error('Image has no dimensions');
      bitmap.close();
    } else if (typeof Image !== 'undefined') {
      const url = URL.createObjectURL(decoded);
      try {
        await new Promise<void>((resolve, reject) => {
          const image = new Image();
          image.onload = () =>
            image.naturalWidth > 0 && image.naturalHeight > 0
              ? resolve()
              : reject(new Error('Image has no dimensions'));
          image.onerror = () => reject(new Error('Image decoding failed'));
          image.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch (error) {
    throw new KavitaError(
      'invalid-response',
      'Kavita cover image could not be decoded',
      undefined,
      {
        cause: error,
      },
    );
  }
  return decoded;
}

const retryAfterMilliseconds = (response: Response): number | undefined => {
  const value = response.headers.get('Retry-After');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
};

const recordFailure = (connectionId: string, now = Date.now()): void => {
  const current = connectionFailures.get(connectionId) ?? {
    failures: 0,
    cooldownUntil: 0,
    authBlocked: false,
  };
  current.failures = Math.min(current.failures + 1, COOLDOWN_DELAYS_MS.length);
  current.cooldownUntil = now + COOLDOWN_DELAYS_MS[current.failures - 1]!;
  connectionFailures.set(connectionId, current);
};

const recordRateLimit = (
  connectionId: string,
  retryAfter: number | undefined,
  now: number,
): void => {
  recordFailure(connectionId, now);
  const current = connectionFailures.get(connectionId)!;
  if (retryAfter !== undefined) {
    current.cooldownUntil = Math.max(current.cooldownUntil, now + retryAfter);
  }
};

const recordAuthenticationFailure = (connectionId: string): void => {
  const current = connectionFailures.get(connectionId) ?? {
    failures: 0,
    cooldownUntil: 0,
    authBlocked: false,
  };
  current.authBlocked = true;
  connectionFailures.set(connectionId, current);
};

const assertConnectionAvailable = (connectionId: string, now = Date.now()): void => {
  const failure = connectionFailures.get(connectionId);
  if (failure?.authBlocked) {
    throw new KavitaError('authentication', 'Kavita cover authentication requires attention', 401);
  }
  if (failure && failure.cooldownUntil > now) {
    throw new KavitaError('network', 'Kavita cover requests are temporarily cooling down');
  }
};

export function resetKavitaCoverFailureState(connectionId?: string): void {
  if (connectionId) {
    connectionFailures.delete(connectionId);
    notifiedConnections.delete(connectionId);
  } else {
    connectionFailures.clear();
    notifiedConnections.clear();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => resetKavitaCoverFailureState());
}

const notifyConnectionError = async (
  runtime: KavitaRuntimeConnection,
  error: KavitaError,
): Promise<void> => {
  if (!['authentication', 'permission'].includes(error.category)) return;
  if (!notifiedConnections.has(runtime.config.id)) {
    notifiedConnections.add(runtime.config.id);
    eventDispatcher.dispatch('toast', {
      type: 'error',
      timeout: 8000,
      message: `${runtime.config.name}: Kavita cover authentication or Download permission failed`,
    });
  }
  const { getKavitaConnectionRepository } = await import('./connections');
  const repository = getKavitaConnectionRepository();
  if (repository) {
    const device = repository.getDeviceConfig(runtime.config.id);
    repository.saveDeviceConfig({
      ...device,
      lastDiagnostic: {
        checkedAt: Date.now(),
        ok: false,
        category: error.category,
        message: 'Kavita cover authentication or Download permission failed',
      },
    });
  }
};

async function requestApiCover(
  book: Book,
  signal: AbortSignal,
  validators: { etag?: string; lastModified?: string } = {},
  dependencies: KavitaCoverFetchDependencies = {},
): Promise<{ blob?: Blob; notModified: boolean; etag?: string; lastModified?: string }> {
  const source = book.kavitaSource!;
  const runtime = await unlockRuntime(book);
  const now = dependencies.now ?? Date.now;
  assertConnectionAvailable(source.connectionId, now());
  const transport =
    dependencies.transport ??
    createKavitaTransport({ allowInvalidTls: runtime.device.allowInvalidTls });
  const client = new KavitaClient(getKavitaRuntimeBaseUrl(runtime), runtime.authKey, transport);
  const authenticatedFetch = client.createAuthenticatedTransport();
  const random = dependencies.random ?? Math.random;
  const sleep = dependencies.sleep ?? sleepWithSignal;
  let lastError: KavitaError | undefined;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const baseDelay = RETRY_DELAYS_MS[attempt]!;
      await sleep(Math.round(baseDelay * (0.8 + random() * 0.4)), signal);
    }
    signal.throwIfAborted();
    const headers = new Headers({ Accept: 'image/*' });
    if (validators.etag) headers.set('If-None-Match', validators.etag);
    if (validators.lastModified) headers.set('If-Modified-Since', validators.lastModified);
    try {
      const response =
        !dependencies.transport && isTauriAppPlatform()
          ? await fetchNativeKavitaCover({
              baseUrl: getKavitaRuntimeBaseUrl(runtime),
              chapterId: source.chapterId,
              authKey: runtime.authKey,
              allowInvalidTls: runtime.device.allowInvalidTls,
              etag: validators.etag,
              lastModified: validators.lastModified,
              signal,
            })
          : await authenticatedFetch(client.getChapterCoverUrl(source.chapterId), {
              method: 'GET',
              headers,
              signal,
              cache: 'no-store',
              credentials: 'omit',
              referrerPolicy: 'no-referrer',
            });
      if (response.status === 304) {
        resetKavitaCoverFailureState(source.connectionId);
        return { notModified: true };
      }
      if (response.status === 401 || response.status === 403) {
        const error = classifyKavitaHttpError(response.status, 'Kavita cover');
        recordAuthenticationFailure(source.connectionId);
        await notifyConnectionError(runtime, error);
        throw error;
      }
      if (!response.ok) {
        const error = classifyKavitaHttpError(response.status, 'Kavita cover');
        if (response.status === 429) {
          const retryAfter = retryAfterMilliseconds(response);
          if (attempt + 1 >= RETRY_DELAYS_MS.length) {
            recordRateLimit(source.connectionId, retryAfter, now());
            throw error;
          }
          if (retryAfter !== undefined) await sleep(retryAfter, signal);
          lastError = error;
          continue;
        }
        if (RETRYABLE_STATUSES.has(response.status) && attempt + 1 < RETRY_DELAYS_MS.length) {
          lastError = error;
          continue;
        }
        throw error;
      }
      const length = Number(response.headers.get('Content-Length') ?? 0);
      if (length > MAX_COVER_BYTES) {
        throw new KavitaError('invalid-response', 'Kavita cover exceeds the 16 MiB limit');
      }
      const mimeType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
      if (!mimeType?.startsWith('image/')) {
        throw new KavitaError('invalid-response', 'Kavita cover response is not an image');
      }
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_COVER_BYTES) {
        throw new KavitaError('invalid-response', 'Kavita cover body has an invalid size');
      }
      const blob = await decodeCover(new Blob([bytes], { type: mimeType }));
      resetKavitaCoverFailureState(source.connectionId);
      return {
        blob,
        notModified: false,
        etag: response.headers.get('ETag') ?? undefined,
        lastModified: response.headers.get('Last-Modified') ?? undefined,
      };
    } catch (cause) {
      const error = classifyKavitaNetworkError(cause, client.getChapterCoverUrl(source.chapterId));
      if (
        error.category === 'cancelled' ||
        error.category === 'authentication' ||
        error.category === 'permission' ||
        error.status === 429 ||
        DIRECT_FALLBACK_STATUSES.has(error.status ?? 0)
      ) {
        throw error;
      }
      lastError = error;
      if (attempt + 1 >= RETRY_DELAYS_MS.length) break;
    }
  }
  const failure = lastError ?? new KavitaError('network', 'Kavita cover request failed');
  recordFailure(source.connectionId, now());
  throw failure;
}

export async function fetchKavitaCoverApiBlob(
  book: Book,
  signal: AbortSignal,
  validators: { etag?: string; lastModified?: string } = {},
  dependencies: KavitaCoverFetchDependencies = {},
): Promise<{ blob?: Blob; notModified: boolean; etag?: string; lastModified?: string }> {
  try {
    return await requestApiCover(book, signal, validators, dependencies);
  } catch (error) {
    if (
      !isTauriAppPlatform() &&
      (validators.etag || validators.lastModified) &&
      error instanceof KavitaError &&
      ['cors', 'network'].includes(error.category)
    ) {
      return await requestApiCover(book, signal, {}, dependencies);
    }
    throw error;
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
    return { document: opened.book, close: async () => await opened.book.destroy?.() };
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
    const cover = await opened.document.getCover();
    signal.throwIfAborted();
    if (!cover) throw new KavitaError('invalid-response', 'Kavita EPUB has no cover image');
    return await decodeCover(cover);
  } finally {
    await opened.close();
  }
}

const shouldFallbackToEpub = (error: unknown): boolean => {
  if (!(error instanceof KavitaError)) return false;
  if (DIRECT_FALLBACK_STATUSES.has(error.status ?? 0)) return true;
  if (RETRY_FALLBACK_STATUSES.has(error.status ?? 0)) return true;
  return error.category === 'invalid-response' || error.category === 'not-found';
};

async function readLegacyCover(appService: AppService, book: Book): Promise<Blob | null> {
  try {
    const source = book.kavitaSource!;
    if (!(await appService.exists(getCoverFilename(book), 'Books'))) return null;
    if (!(await appService.exists(legacyMarkerFilename(book), 'Books'))) return null;
    const storedVersion = await appService.readFile(legacyMarkerFilename(book), 'Books', 'text');
    if (storedVersion !== kavitaCoverSourceVersion(source)) return null;
    const bytes = (await appService.readFile(
      getCoverFilename(book),
      'Books',
      'binary',
    )) as ArrayBuffer;
    return bytes.byteLength ? new Blob([bytes], { type: 'image/png' }) : null;
  } catch {
    return null;
  }
}

async function deleteLegacyCover(appService: AppService, book: Book): Promise<void> {
  await appService.deleteFile(getCoverFilename(book), 'Books').catch(() => undefined);
  await appService.deleteFile(legacyMarkerFilename(book), 'Books').catch(() => undefined);
}

const protectedCacheKeys = (): Set<string> =>
  // Native runtime URLs point at these cache files. Protect every URL acquired
  // in this session, not just currently mounted cards, so virtualization cannot
  // leave a stable URL pointing at an LRU-deleted file.
  new Set(Array.from(coverEntries.values()).map((entry) => entry.key));

const persistCoverInBackground = (
  appService: AppService,
  book: Book,
  blob: Blob,
  validators: { etag?: string; lastModified?: string },
): void => {
  const source = book.kavitaSource;
  if (!source) return;
  // Keep filesystem IPC away from the critical render path. A cold shelf can
  // finish decoding its visible covers before durable cache writes begin.
  const timer = setTimeout(() => {
    pendingPersistence.delete(timer);
    const protectedKeys = protectedCacheKeys();
    void writeKavitaCoverCache(appService, source, blob, validators, protectedKeys)
      .then(async (entry) => {
        // Keep the legacy cover until the new cache payload and index are both
        // durable. A disabled/full cache still leaves the session Blob usable.
        if (entry) await deleteLegacyCover(appService, book).catch(() => undefined);
      })
      .catch(() => undefined);
  }, PERSIST_COVER_DELAY_MS);
  pendingPersistence.set(timer, source.connectionId);
};

async function refreshPersistentCover(
  appService: AppService,
  book: Book,
  signal: AbortSignal,
  cached?: PersistentCoverEntry,
): Promise<Blob | null> {
  try {
    const result = await fetchKavitaCoverApiBlob(book, signal, {
      etag: cached?.etag,
      lastModified: cached?.lastModified,
    });
    if (result.notModified) {
      await touchKavitaCoverCacheValidation(appService, book.kavitaSource!).catch(() => undefined);
      return null;
    }
    if (!result.blob) throw new KavitaError('invalid-response', 'Kavita returned no cover body');
    // The decoded Blob is ready for display. Native filesystem persistence is
    // deliberately write-behind so the six network slots are not held by the
    // globally serialized cache index/file writes on Android.
    persistCoverInBackground(appService, book, result.blob, {
      etag: result.etag,
      lastModified: result.lastModified,
    });
    return result.blob;
  } catch (error) {
    const localAvailable =
      ['offline', 'orphaned'].includes(book.kavitaSource?.offlineState ?? '') &&
      (await appService.exists(getLocalBookFilename(book), 'Books'));
    if (!localAvailable && !shouldFallbackToEpub(error)) throw error;
    const fallback = await extractKavitaCoverBlob(book, signal, appService);
    persistCoverInBackground(appService, book, fallback, {});
    return fallback;
  }
}

async function loadCover(book: Book, signal: AbortSignal): Promise<string> {
  const appService = await environmentConfig.getAppService();
  const source = book.kavitaSource!;
  const nativeEntry = isTauriAppPlatform()
    ? await readKavitaCoverCacheEntry(appService, source)
    : null;
  if (nativeEntry) {
    if (Date.now() - nativeEntry.lastValidatedAt >= REVALIDATE_AFTER_MS) {
      void withFetchSlot(signal, () =>
        refreshPersistentCover(appService, book, signal, nativeEntry),
      )
        .then((blob) => {
          if (blob) replaceRuntimeCoverUrl(book, URL.createObjectURL(blob));
        })
        .catch(() => undefined);
    }
    const path = await appService.resolveFilePath(nativeEntry.path, 'Data');
    return await appService.getImageURL(path);
  }

  const persistent = await readKavitaCoverCache(appService, source);
  if (persistent) {
    if (Date.now() - persistent.entry.lastValidatedAt >= REVALIDATE_AFTER_MS) {
      void withFetchSlot(signal, () =>
        refreshPersistentCover(appService, book, signal, persistent.entry),
      )
        .then((blob) => {
          if (blob) replaceRuntimeCoverUrl(book, URL.createObjectURL(blob));
        })
        .catch(() => undefined);
    }
    return URL.createObjectURL(persistent.blob);
  }

  const legacy = await readLegacyCover(appService, book);
  if (legacy) {
    void withFetchSlot(signal, () => refreshPersistentCover(appService, book, signal)).catch(
      () => undefined,
    );
    return URL.createObjectURL(legacy);
  }

  const blob = await withFetchSlot(signal, async () => {
    const refreshed = await refreshPersistentCover(appService, book, signal);
    if (!refreshed) {
      const cached = await readKavitaCoverCache(appService, book.kavitaSource!);
      if (cached) return cached.blob;
      throw new KavitaError('invalid-response', 'Kavita cover cache was not populated');
    }
    return refreshed;
  });
  signal.throwIfAborted();
  return URL.createObjectURL(blob);
}

const revokeIfBlobUrl = (url: string | undefined): void => {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
};

function replaceRuntimeCoverUrl(book: Book, url: string): void {
  const entry = coverEntries.get(runtimeKey(book));
  if (!entry || entry.controller.signal.aborted || entry.objectUrl === url) return;
  const previous = entry.objectUrl;
  entry.objectUrl = url;
  entry.promise = Promise.resolve(url);
  revokeIfBlobUrl(previous);
  void eventDispatcher.dispatch('kavita-cover-updated', { key: runtimeKey(book), url });
}

export function peekKavitaCoverUrl(book: Book): string | null {
  if (!book.kavitaSource) return null;
  const entry = coverEntries.get(runtimeKey(book));
  return entry?.settled && entry.objectUrl ? entry.objectUrl : null;
}

export function acquireKavitaCoverUrl(book: Book): KavitaCoverLease | null {
  const source = book.kavitaSource;
  if (!source) return null;
  const key = runtimeKey(book);
  let entry = coverEntries.get(key);
  if (!entry) {
    const controller = new AbortController();
    const created: RuntimeCoverEntry = {
      key: kavitaCoverCacheKey(source),
      connectionId: source.connectionId,
      controller,
      refs: 0,
      settled: false,
      promise: Promise.resolve(''),
    };
    created.promise = loadCover(book, controller.signal)
      .then((url) => {
        created.settled = true;
        created.objectUrl = url;
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
  let released = false;
  return {
    url: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry!.refs = Math.max(0, entry!.refs - 1);
      if (entry!.refs === 0 && !entry!.settled) entry!.controller.abort();
    },
  };
}

export function clearKavitaCoverUrls(connectionId?: string): void {
  for (const [timer, pendingConnectionId] of pendingPersistence) {
    if (connectionId && pendingConnectionId !== connectionId) continue;
    clearTimeout(timer);
    pendingPersistence.delete(timer);
  }
  for (const [key, entry] of coverEntries) {
    if (connectionId && entry.connectionId !== connectionId) continue;
    entry.controller.abort();
    revokeIfBlobUrl(entry.objectUrl);
    coverEntries.delete(key);
  }
}

export async function deleteStoredKavitaCovers(
  appService: AppService,
  books: Book[],
): Promise<void> {
  await deleteKavitaCoverCacheEntries(
    appService,
    books.flatMap((book) => (book.kavitaSource ? [book.kavitaSource] : [])),
  );
  await Promise.all(books.map((book) => deleteLegacyCover(appService, book)));
}
