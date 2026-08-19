import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookProgress } from '@/types/book';
import type { KavitaClient } from '@/services/kavita/client';
import {
  buildKavitaProgressPayload,
  decideKavitaProgress,
  getKavitaLocalProgressUpdatedAt,
} from '@/services/kavita/progress';
import {
  enqueueKavitaProgress,
  flushPendingKavitaProgress,
  listPendingKavitaProgress,
} from '@/services/kavita/progressQueue';
import type { KavitaKoreaderProgress } from '@/services/kavita/types';

const progress = {
  fraction: 0.42,
  index: 7,
  pageinfo: { current: 41, total: 100 },
} as BookProgress;

const remote = (timestamp: number, percentage = 0.75): KavitaKoreaderProgress => ({
  document: 'hash',
  device_id: 'other',
  device: 'KOReader',
  percentage,
  progress: '/body/DocFragment[9].0',
  timestamp,
});

describe('Kavita progress', () => {
  beforeEach(() => localStorage.clear());

  it('maps Readest progress to Kavita KOReader document and fragment fields', () => {
    expect(buildKavitaProgressPayload('hash', progress, 'device', 12_345)).toEqual({
      document: 'hash',
      device_id: 'device',
      device: 'Readest',
      percentage: 0.42,
      progress: '/body/DocFragment[8].0',
      timestamp: 12,
    });
  });

  it('asks only when a newer remote position differs materially', () => {
    expect(decideKavitaProgress('ask', 10_000, 0.25, remote(20, 0.75))).toBe('ask');
    expect(decideKavitaProgress('ask', 10_000, 0.75, remote(20, 0.755))).toBe('apply-remote');
    expect(decideKavitaProgress('ask', 30_000, 0.25, remote(20, 0.75))).toBe('push-local');
    expect(decideKavitaProgress('prefer-local', 10_000, 0.25, remote(20))).toBe('push-local');
    expect(decideKavitaProgress('prefer-remote', 10_000, 0.25, remote(20))).toBe('apply-remote');
  });

  it('does not treat the initial page-one relocate as newer local reading', () => {
    expect(getKavitaLocalProgressUpdatedAt([1, 100], 50_000)).toBe(0);
    expect(getKavitaLocalProgressUpdatedAt([2, 100], 50_000)).toBe(50_000);
  });

  it('does not let an offline queue overwrite newer remote progress', async () => {
    const payload = buildKavitaProgressPayload('hash', progress, 'device', 10_000);
    enqueueKavitaProgress({
      connectionId: 'connection',
      koreaderHash: 'hash',
      payload,
      localUpdatedAt: 10_000,
      queuedAt: 11_000,
    });
    const putProgress = vi.fn();
    const client = {
      getProgress: vi.fn().mockResolvedValue(remote(20)),
      putProgress,
    } as unknown as KavitaClient;

    await expect(flushPendingKavitaProgress(client, 'connection', 'hash')).resolves.toBe(
      'remote-newer',
    );
    expect(putProgress).not.toHaveBeenCalled();
    expect(listPendingKavitaProgress()).toEqual([]);
  });

  it('flushes the newest local offline progress when the server is older', async () => {
    const payload = buildKavitaProgressPayload('hash', progress, 'device', 20_000);
    enqueueKavitaProgress({
      connectionId: 'connection',
      koreaderHash: 'hash',
      payload,
      localUpdatedAt: 20_000,
      queuedAt: 21_000,
    });
    const putProgress = vi.fn().mockResolvedValue({ document: 'hash', timestamp: 'now' });
    const client = {
      getProgress: vi.fn().mockResolvedValue(remote(10)),
      putProgress,
    } as unknown as KavitaClient;

    await expect(flushPendingKavitaProgress(client, 'connection', 'hash')).resolves.toBe('pushed');
    expect(putProgress).toHaveBeenCalledWith(payload);
    expect(listPendingKavitaProgress()).toEqual([]);
  });
});
