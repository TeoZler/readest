import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearKavitaCoverCache,
  getKavitaCoverCacheBytes,
  readKavitaCoverCache,
  saveKavitaCoverCacheSettings,
  writeKavitaCoverCache,
} from '@/services/kavita/coverCache';
import type { KavitaBookSource } from '@/services/kavita/types';
import type { AppService } from '@/types/system';

const source = (chapterId: number, fileCreated = 'v1'): KavitaBookSource => ({
  kind: 'kavita',
  connectionId: chapterId % 2 ? 'a' : 'b',
  serverId: `server-${chapterId % 2}`,
  libraryId: 1,
  libraryName: 'Library',
  seriesId: 2,
  seriesName: 'Series',
  volumeId: 3,
  chapterId,
  fileId: chapterId,
  fileBytes: 4,
  fileCreated,
  fileExtension: '.epub',
  koreaderHash: `hash-${chapterId}`,
  offlineState: 'remote',
  lastSeenAt: 1,
});

const memoryService = (): AppService => {
  const files = new Map<string, string | ArrayBuffer>();
  const service: Pick<
    AppService,
    'exists' | 'readFile' | 'writeFile' | 'createDir' | 'deleteFile' | 'deleteDir'
  > = {
    exists: async (path, base) => files.has(`${base}:${path}`),
    readFile: async (path, base) => {
      const value = files.get(`${base}:${path}`);
      if (value === undefined) throw new Error('missing');
      return typeof value === 'string' ? value : value.slice(0);
    },
    writeFile: async (path, base, content) => {
      files.set(
        `${base}:${path}`,
        typeof content === 'string'
          ? content
          : content instanceof File
            ? await content.arrayBuffer()
            : content.slice(0),
      );
    },
    createDir: async () => undefined,
    deleteFile: async (path, base) => {
      files.delete(`${base}:${path}`);
    },
    deleteDir: async (path, base) => {
      for (const key of files.keys()) {
        if (key.startsWith(`${base}:${path}/`) || key === `${base}:${path}`) files.delete(key);
      }
    },
  };
  return service as AppService;
};

beforeEach(() => {
  localStorage.clear();
  saveKavitaCoverCacheSettings({ enabled: true, capacityBytes: 1024 });
});

describe('Kavita cover persistent cache', () => {
  it('hits only the exact source version', async () => {
    const appService = memoryService();
    await writeKavitaCoverCache(
      appService,
      source(1),
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
      { etag: 'v1' },
    );
    expect((await readKavitaCoverCache(appService, source(1)))?.entry.etag).toBe('v1');
    expect(await readKavitaCoverCache(appService, source(1, 'v2'))).toBeNull();
  });

  it('enforces one device-global LRU budget across connections', async () => {
    const appService = memoryService();
    saveKavitaCoverCacheSettings({ enabled: true, capacityBytes: 8 });
    for (const chapter of [1, 2, 3]) {
      await writeKavitaCoverCache(
        appService,
        source(chapter),
        new Blob([new Uint8Array([chapter, 2, 3, 4])], { type: 'image/png' }),
        {},
      );
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(await getKavitaCoverCacheBytes(appService)).toBe(8);
    expect(await readKavitaCoverCache(appService, source(1))).toBeNull();
    expect(await readKavitaCoverCache(appService, source(2))).not.toBeNull();
    expect(await readKavitaCoverCache(appService, source(3))).not.toBeNull();
  });

  it('clears only the cover namespace', async () => {
    const appService = memoryService();
    await writeKavitaCoverCache(
      appService,
      source(1),
      new Blob([new Uint8Array([1])], { type: 'image/png' }),
      {},
    );
    await clearKavitaCoverCache(appService);
    expect(await getKavitaCoverCacheBytes(appService)).toBe(0);
  });
});
