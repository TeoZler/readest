import { md5 } from 'js-md5';
import type { AppService } from '@/types/system';
import type { KavitaBookSource } from './types';

const CACHE_DIR = 'KavitaCoverCache';
const INDEX_PATH = `${CACHE_DIR}/index.json`;
const SETTINGS_KEY = 'readest_kavita_cover_cache_v1';
const DEFAULT_CAPACITY_BYTES = 1024 * 1024 * 1024;
const ACCESS_WRITE_INTERVAL_MS = 60 * 60 * 1000;

export interface KavitaCoverCacheSettings {
  enabled: boolean;
  capacityBytes: number;
}

export interface KavitaCoverCacheEntry {
  key: string;
  connectionId: string;
  serverId: string;
  chapterId: number;
  fileId: number;
  sourceVersion: string;
  path: string;
  mimeType: string;
  byteSize: number;
  etag?: string;
  lastModified?: string;
  storedAt: number;
  lastValidatedAt: number;
  lastAccessedAt: number;
}

interface KavitaCoverCacheIndex {
  version: 1;
  entries: Record<string, KavitaCoverCacheEntry>;
}

const emptyIndex = (): KavitaCoverCacheIndex => ({ version: 1, entries: {} });
let cacheQueue: Promise<unknown> = Promise.resolve();

const withCacheLock = async <T>(task: () => Promise<T>): Promise<T> => {
  const operation = cacheQueue.then(task, task);
  cacheQueue = operation.catch(() => undefined);
  return operation;
};

export const kavitaCoverSourceVersion = (source: KavitaBookSource): string =>
  [source.serverId, source.chapterId, source.fileId, source.fileBytes, source.fileCreated].join(
    ':',
  );

export const kavitaCoverCacheKey = (source: KavitaBookSource): string =>
  `${source.connectionId}:${kavitaCoverSourceVersion(source)}`;

const cachePath = (key: string, mimeType: string): string => {
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'img';
  return `${CACHE_DIR}/${md5(key)}.${extension}`;
};

const parseIndex = (value: string): KavitaCoverCacheIndex => {
  try {
    const parsed = JSON.parse(value) as KavitaCoverCacheIndex;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch {
    // Rebuild an empty index. Cache payloads without an index are harmless and
    // will be removed by the next explicit clear or quota eviction.
  }
  return emptyIndex();
};

const readIndex = async (appService: AppService): Promise<KavitaCoverCacheIndex> => {
  try {
    if (!(await appService.exists(INDEX_PATH, 'Data'))) return emptyIndex();
    return parseIndex((await appService.readFile(INDEX_PATH, 'Data', 'text')) as string);
  } catch {
    return emptyIndex();
  }
};

const writeIndex = async (appService: AppService, index: KavitaCoverCacheIndex): Promise<void> => {
  await appService.createDir(CACHE_DIR, 'Data', true);
  await appService.writeFile(INDEX_PATH, 'Data', JSON.stringify(index));
};

export function getKavitaCoverCacheSettings(storage?: Storage): KavitaCoverCacheSettings {
  const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  if (!target) return { enabled: true, capacityBytes: DEFAULT_CAPACITY_BYTES };
  try {
    const parsed = JSON.parse(
      target.getItem(SETTINGS_KEY) ?? '',
    ) as Partial<KavitaCoverCacheSettings>;
    return {
      enabled: parsed.enabled !== false,
      capacityBytes:
        typeof parsed.capacityBytes === 'number' && parsed.capacityBytes >= 0
          ? parsed.capacityBytes
          : DEFAULT_CAPACITY_BYTES,
    };
  } catch {
    return { enabled: true, capacityBytes: DEFAULT_CAPACITY_BYTES };
  }
}

export function saveKavitaCoverCacheSettings(
  settings: KavitaCoverCacheSettings,
  storage?: Storage,
): void {
  const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  target?.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      enabled: settings.enabled,
      capacityBytes: Math.max(0, settings.capacityBytes),
    }),
  );
}

export async function readKavitaCoverCache(
  appService: AppService,
  source: KavitaBookSource,
): Promise<{ blob: Blob; entry: KavitaCoverCacheEntry } | null> {
  return withCacheLock(async () => {
    const settings = getKavitaCoverCacheSettings();
    if (!settings.enabled || settings.capacityBytes <= 0) return null;
    const index = await readIndex(appService);
    const key = kavitaCoverCacheKey(source);
    const entry = index.entries[key];
    if (!entry || entry.sourceVersion !== kavitaCoverSourceVersion(source)) return null;
    try {
      if (!(await appService.exists(entry.path, 'Data'))) {
        delete index.entries[key];
        await writeIndex(appService, index);
        return null;
      }
      const bytes = (await appService.readFile(entry.path, 'Data', 'binary')) as ArrayBuffer;
      if (bytes.byteLength !== entry.byteSize) throw new Error('Kavita cover cache size mismatch');
      const now = Date.now();
      if (now - entry.lastAccessedAt >= ACCESS_WRITE_INTERVAL_MS) {
        entry.lastAccessedAt = now;
        await writeIndex(appService, index);
      }
      return { blob: new Blob([bytes], { type: entry.mimeType }), entry: { ...entry } };
    } catch {
      delete index.entries[key];
      await appService.deleteFile(entry.path, 'Data').catch(() => undefined);
      await writeIndex(appService, index).catch(() => undefined);
      return null;
    }
  });
}

const evictIndex = async (
  appService: AppService,
  index: KavitaCoverCacheIndex,
  capacityBytes: number,
  protectedKeys: ReadonlySet<string>,
): Promise<void> => {
  let total = Object.values(index.entries).reduce((sum, entry) => sum + entry.byteSize, 0);
  if (total <= capacityBytes) return;
  const candidates = Object.values(index.entries)
    .filter((entry) => !protectedKeys.has(entry.key))
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  for (const entry of candidates) {
    if (total <= capacityBytes) break;
    await appService.deleteFile(entry.path, 'Data').catch(() => undefined);
    delete index.entries[entry.key];
    total -= entry.byteSize;
  }
};

export async function writeKavitaCoverCache(
  appService: AppService,
  source: KavitaBookSource,
  blob: Blob,
  validators: { etag?: string; lastModified?: string },
  protectedKeys: ReadonlySet<string> = new Set(),
): Promise<KavitaCoverCacheEntry | null> {
  return withCacheLock(async () => {
    const settings = getKavitaCoverCacheSettings();
    if (!settings.enabled || settings.capacityBytes <= 0 || blob.size > settings.capacityBytes) {
      return null;
    }
    const index = await readIndex(appService);
    const key = kavitaCoverCacheKey(source);
    const previous = index.entries[key];
    const path = cachePath(key, blob.type);
    const now = Date.now();
    const entry: KavitaCoverCacheEntry = {
      key,
      connectionId: source.connectionId,
      serverId: source.serverId,
      chapterId: source.chapterId,
      fileId: source.fileId,
      sourceVersion: kavitaCoverSourceVersion(source),
      path,
      mimeType: blob.type,
      byteSize: blob.size,
      etag: validators.etag,
      lastModified: validators.lastModified,
      storedAt: now,
      lastValidatedAt: now,
      lastAccessedAt: now,
    };
    await appService.createDir(CACHE_DIR, 'Data', true);
    try {
      await appService.writeFile(path, 'Data', await blob.arrayBuffer());
    } catch {
      await evictIndex(
        appService,
        index,
        Math.max(0, settings.capacityBytes - blob.size),
        protectedKeys,
      );
      try {
        await appService.writeFile(path, 'Data', await blob.arrayBuffer());
      } catch {
        return null;
      }
    }
    index.entries[key] = entry;
    if (previous && previous.path !== path) {
      await appService.deleteFile(previous.path, 'Data').catch(() => undefined);
    }
    await evictIndex(appService, index, settings.capacityBytes, new Set([...protectedKeys, key]));
    await writeIndex(appService, index);
    return entry;
  });
}

export async function touchKavitaCoverCacheValidation(
  appService: AppService,
  source: KavitaBookSource,
): Promise<void> {
  await withCacheLock(async () => {
    const index = await readIndex(appService);
    const entry = index.entries[kavitaCoverCacheKey(source)];
    if (!entry) return;
    entry.lastValidatedAt = Date.now();
    entry.lastAccessedAt = Date.now();
    await writeIndex(appService, index);
  });
}

export async function deleteKavitaCoverCacheEntries(
  appService: AppService,
  sources: KavitaBookSource[],
): Promise<void> {
  await withCacheLock(async () => {
    const index = await readIndex(appService);
    for (const source of sources) {
      const key = kavitaCoverCacheKey(source);
      const entry = index.entries[key];
      if (!entry) continue;
      await appService.deleteFile(entry.path, 'Data').catch(() => undefined);
      delete index.entries[key];
    }
    await writeIndex(appService, index);
  });
}

export async function clearKavitaCoverCache(appService: AppService): Promise<void> {
  await withCacheLock(async () => {
    await appService.deleteDir(CACHE_DIR, 'Data', true).catch(() => undefined);
  });
}

export async function getKavitaCoverCacheBytes(appService: AppService): Promise<number> {
  return (await getKavitaCoverCacheStats(appService)).bytes;
}

export async function getKavitaCoverCacheStats(
  appService: AppService,
): Promise<{ count: number; bytes: number }> {
  return withCacheLock(async () => {
    const index = await readIndex(appService);
    const entries = Object.values(index.entries);
    return {
      count: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.byteSize, 0),
    };
  });
}
