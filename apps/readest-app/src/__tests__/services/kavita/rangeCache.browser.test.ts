import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KavitaPersistentRangeCache,
  clearKavitaRangeCache,
  getKavitaRangeCacheBytes,
} from '@/services/kavita/rangeCache';
import type { KavitaBookSource } from '@/services/kavita/types';

const source = (fileCreated = 'v1'): KavitaBookSource => ({
  kind: 'kavita',
  connectionId: 'connection',
  serverId: 'server',
  libraryId: 1,
  libraryName: 'Books',
  seriesId: 2,
  seriesName: 'Series',
  volumeId: 3,
  chapterId: 4,
  fileId: 5,
  fileBytes: 12,
  fileCreated,
  fileExtension: '.epub',
  koreaderHash: 'hash',
  offlineState: 'remote',
  lastSeenAt: 1,
});

describe('KavitaPersistentRangeCache', () => {
  beforeEach(() => clearKavitaRangeCache());
  afterEach(() => clearKavitaRangeCache());

  it('serves exact chunks and automatically misses a changed file version', async () => {
    const cache = new KavitaPersistentRangeCache(source(), 1024);
    await cache.put(0, 3, new Uint8Array([1, 2, 3, 4]).buffer);
    expect(Array.from(new Uint8Array((await cache.get(0, 3))!))).toEqual([1, 2, 3, 4]);
    expect(await new KavitaPersistentRangeCache(source('v2'), 1024).get(0, 3)).toBeUndefined();
  });

  it('evicts least-recently-used chunks to the configured capacity', async () => {
    const cache = new KavitaPersistentRangeCache(source(), 8);
    await cache.put(0, 3, new Uint8Array(4).buffer);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await cache.put(4, 7, new Uint8Array(4).buffer);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await cache.get(0, 3);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await cache.put(8, 11, new Uint8Array(4).buffer);
    expect(await cache.get(0, 3)).toBeDefined();
    expect(await cache.get(4, 7)).toBeUndefined();
    expect(await cache.get(8, 11)).toBeDefined();
    expect(await getKavitaRangeCacheBytes('connection')).toBe(8);
  });
});
