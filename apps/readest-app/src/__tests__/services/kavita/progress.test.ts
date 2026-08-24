import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookProgress } from '@/types/book';
import type { KavitaClient } from '@/services/kavita/client';
import {
  buildKavitaProgressPayload,
  decideKavitaProgress,
  fromKavitaBookScrollId,
  getKavitaLocalProgressUpdatedAt,
  getKavitaRemoteProgressUpdatedAt,
  toKavitaBookScrollId,
  type KavitaResolvedRemoteProgress,
} from '@/services/kavita/progress';
import {
  discardLegacyKavitaProgressQueue,
  enqueueKavitaProgress,
  flushPendingKavitaProgress,
  listPendingKavitaProgress,
} from '@/services/kavita/progressQueue';
import type { KavitaBookSource, KavitaReaderProgressDto } from '@/services/kavita/types';

const progress = {
  location: 'epubcfi(/6/16!/4/2/6:10)',
  fraction: 0.42,
  index: 7,
  pageinfo: { current: 41, total: 100 },
} as BookProgress;

const source = {
  kind: 'kavita',
  connectionId: 'connection',
  serverId: 'server',
  libraryId: 2,
  libraryName: 'Books',
  seriesId: 3,
  seriesName: 'Series',
  volumeId: 4,
  chapterId: 5,
  fileId: 6,
  filePages: 12,
  fileBytes: 100,
  fileCreated: '2026-01-01',
  fileExtension: '.epub',
  koreaderHash: 'hash',
  offlineState: 'remote',
  lastSeenAt: 1,
} satisfies KavitaBookSource;

const dto = (updatedAt: number, pageNum = 8, bookScrollId: string | null = '//body/p[3]') =>
  ({
    volumeId: 4,
    chapterId: 5,
    pageNum,
    seriesId: 3,
    libraryId: 2,
    bookScrollId,
    lastModifiedUtc: new Date(updatedAt).toISOString(),
  }) satisfies KavitaReaderProgressDto;

const remote = (
  updatedAt: number,
  fraction = 0.75,
  approximate = false,
): KavitaResolvedRemoteProgress => ({
  dto: dto(updatedAt, 8, approximate ? null : '//body/p[3]'),
  fraction,
  cfi: approximate ? null : 'epubcfi(/6/18!/4/2)',
  approximate,
});

describe('Kavita progress', () => {
  beforeEach(() => localStorage.clear());

  it('maps Readest progress to native Kavita Reader fields and clamps the page', () => {
    expect(
      buildKavitaProgressPayload(source, { ...progress, index: 99 }, '//body/p[3]', 12_345),
    ).toEqual({
      volumeId: 4,
      chapterId: 5,
      pageNum: 11,
      seriesId: 3,
      libraryId: 2,
      bookScrollId: '//body/p[3]',
      lastModifiedUtc: new Date(12_345).toISOString(),
    });
  });

  it('converts between Readest XPointer and Kavita-scoped element XPath', () => {
    expect(toKavitaBookScrollId('/body/DocFragment[8]/body/div/p[3]/text()[2].14')).toBe(
      '//body/div/p[3]',
    );
    expect(fromKavitaBookScrollId('//body/div/p[3]', 7)).toBe('/body/DocFragment[8]/body/div/p[3]');
    expect(fromKavitaBookScrollId('id("chapter-3")', 7)).toBeNull();
  });

  it('asks only when a newer exact remote position differs materially', () => {
    expect(decideKavitaProgress('ask', 10_000, 0.25, remote(20_000, 0.75))).toBe('ask');
    expect(decideKavitaProgress('ask', 10_000, 0.75, remote(20_000, 0.755))).toBe('apply-remote');
    expect(decideKavitaProgress('ask', 30_000, 0.25, remote(20_000, 0.75))).toBe('push-local');
    expect(decideKavitaProgress('prefer-local', 10_000, 0.25, remote(20_000))).toBe('push-local');
    expect(decideKavitaProgress('prefer-remote', 10_000, 0.25, remote(20_000))).toBe(
      'apply-remote',
    );
  });

  it('protects meaningful local progress from approximate legacy positions', () => {
    expect(decideKavitaProgress('prefer-remote', 10_000, 0.25, remote(20_000, 0.75, true))).toBe(
      'ask',
    );
    expect(decideKavitaProgress('prefer-local', 10_000, 0.25, remote(20_000, 0.75, true))).toBe(
      'push-local',
    );
    expect(decideKavitaProgress('ask', 0, 0, remote(20_000, 0.75, true))).toBe('apply-remote');
  });

  it('does not treat the initial page-one relocate as newer local reading', () => {
    expect(getKavitaLocalProgressUpdatedAt([1, 100], 50_000)).toBe(0);
    expect(getKavitaLocalProgressUpdatedAt([2, 100], 50_000)).toBe(50_000);
  });

  it('interprets Kavita zone-less lastModifiedUtc values as UTC', () => {
    const zoneLess = {
      ...dto(0),
      lastModifiedUtc: '2026-08-24T07:25:16.1120414',
    };
    expect(getKavitaRemoteProgressUpdatedAt(zoneLess)).toBe(
      Date.parse('2026-08-24T07:25:16.1120414Z'),
    );

    const explicitOffset = {
      ...dto(0),
      lastModifiedUtc: '2026-08-24T07:25:16.112+08:00',
    };
    expect(getKavitaRemoteProgressUpdatedAt(explicitOffset)).toBe(
      Date.parse('2026-08-24T07:25:16.112+08:00'),
    );
  });

  it('discards the r1 KOReader queue instead of replaying its coarse payload', () => {
    localStorage.setItem('readest_kavita_progress_queue_v1', '[{"progress":"old"}]');
    expect(discardLegacyKavitaProgressQueue()).toBe(true);
    expect(localStorage.getItem('readest_kavita_progress_queue_v1')).toBeNull();
  });

  it('does not let an offline queue overwrite newer remote progress', async () => {
    const payload = buildKavitaProgressPayload(source, progress, '//body/p[3]', 10_000);
    enqueueKavitaProgress({
      connectionId: 'connection',
      chapterId: 5,
      payload,
      localUpdatedAt: 10_000,
      queuedAt: 11_000,
    });
    const saveReaderProgress = vi.fn();
    const client = {
      getReaderProgress: vi.fn().mockResolvedValue(dto(20_000)),
      saveReaderProgress,
    } as unknown as KavitaClient;

    await expect(flushPendingKavitaProgress(client, 'connection', 5)).resolves.toBe('remote-newer');
    expect(saveReaderProgress).not.toHaveBeenCalled();
    expect(listPendingKavitaProgress()).toEqual([]);
  });

  it('flushes the newest local offline progress when the server is older', async () => {
    const payload = buildKavitaProgressPayload(source, progress, '//body/p[3]', 20_000);
    enqueueKavitaProgress({
      connectionId: 'connection',
      chapterId: 5,
      payload,
      localUpdatedAt: 20_000,
      queuedAt: 21_000,
    });
    const saveReaderProgress = vi.fn().mockResolvedValue(undefined);
    const client = {
      getReaderProgress: vi.fn().mockResolvedValue(dto(10_000)),
      saveReaderProgress,
    } as unknown as KavitaClient;

    await expect(flushPendingKavitaProgress(client, 'connection', 5)).resolves.toBe('pushed');
    expect(saveReaderProgress).toHaveBeenCalledWith(payload);
    expect(listPendingKavitaProgress()).toEqual([]);
  });
});
