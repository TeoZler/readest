import type { RemoteFileRangeCache } from '@/utils/file';
import { KavitaError } from './errors';
import type { KavitaBookSource } from './types';

const DB_NAME = 'readest-kavita-range-cache-v1';
const STORE_NAME = 'chunks';
const DB_VERSION = 1;

interface KavitaRangeChunk {
  key: string;
  connectionId: string;
  versionKey: string;
  start: number;
  end: number;
  bytes: ArrayBuffer;
  byteSize: number;
  createdAt: number;
  lastAccessedAt: number;
}

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'));
  });

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

let databasePromise: Promise<IDBDatabase> | undefined;

const openDatabase = (): Promise<IDBDatabase> => {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      store.createIndex('connectionId', 'connectionId');
      store.createIndex('lastAccessedAt', 'lastAccessedAt');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open Kavita cache'));
  });
  return databasePromise;
};

const versionKeyFor = (source: KavitaBookSource): string =>
  `${source.serverId}:${source.chapterId}:${source.fileId}:${source.fileBytes}:${source.fileCreated}`;

export class KavitaPersistentRangeCache implements RemoteFileRangeCache {
  private readonly versionKey: string;

  constructor(
    private readonly source: KavitaBookSource,
    private readonly capacityBytes: number,
  ) {
    this.versionKey = versionKeyFor(source);
  }

  private key(start: number, end: number): string {
    return `${this.versionKey}:${start}-${end}`;
  }

  async get(start: number, end: number): Promise<ArrayBuffer | undefined> {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const chunk = await requestResult(
      store.get(this.key(start, end)) as IDBRequest<KavitaRangeChunk | undefined>,
    );
    if (chunk) store.put({ ...chunk, lastAccessedAt: Date.now() });
    await done;
    return chunk?.bytes.slice(0);
  }

  async put(start: number, end: number, bytes: ArrayBuffer): Promise<void> {
    if (this.capacityBytes <= 0 || bytes.byteLength > this.capacityBytes) return;
    try {
      await this.putChunk(start, end, bytes);
      await this.evictToCapacity();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        await this.evictToCapacity(Math.max(0, this.capacityBytes - bytes.byteLength));
        try {
          await this.putChunk(start, end, bytes);
          return;
        } catch (retryError) {
          throw new KavitaError(
            'quota',
            'Browser storage quota is insufficient for Kavita cache',
            undefined,
            {
              cause: retryError,
            },
          );
        }
      }
      throw error;
    }
  }

  private async putChunk(start: number, end: number, bytes: ArrayBuffer): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    const now = Date.now();
    transaction.objectStore(STORE_NAME).put({
      key: this.key(start, end),
      connectionId: this.source.connectionId,
      versionKey: this.versionKey,
      start,
      end,
      bytes: bytes.slice(0),
      byteSize: bytes.byteLength,
      createdAt: now,
      lastAccessedAt: now,
    } satisfies KavitaRangeChunk);
    await done;
  }

  private async listConnectionChunks(): Promise<KavitaRangeChunk[]> {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const done = transactionDone(transaction);
    const chunks = await requestResult(
      transaction
        .objectStore(STORE_NAME)
        .index('connectionId')
        .getAll(this.source.connectionId) as IDBRequest<KavitaRangeChunk[]>,
    );
    await done;
    return chunks;
  }

  private async evictToCapacity(capacity = this.capacityBytes): Promise<void> {
    const chunks = await this.listConnectionChunks();
    let total = chunks.reduce((sum, chunk) => sum + chunk.byteSize, 0);
    if (total <= capacity) return;
    chunks.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    for (const chunk of chunks) {
      if (total <= capacity) break;
      store.delete(chunk.key);
      total -= chunk.byteSize;
    }
    await done;
  }
}

export async function clearKavitaRangeCache(connectionId?: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore(STORE_NAME);
  if (!connectionId) {
    store.clear();
  } else {
    const keys = await requestResult(store.index('connectionId').getAllKeys(connectionId));
    for (const key of keys) store.delete(key);
  }
  await done;
}

export async function getKavitaRangeCacheBytes(connectionId?: string): Promise<number> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const done = transactionDone(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const chunks = connectionId
    ? await requestResult(
        store.index('connectionId').getAll(connectionId) as IDBRequest<KavitaRangeChunk[]>,
      )
    : await requestResult(store.getAll() as IDBRequest<KavitaRangeChunk[]>);
  await done;
  return chunks.reduce((sum, chunk) => sum + chunk.byteSize, 0);
}
