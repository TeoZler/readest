import type { KavitaClient } from './client';
import { getKavitaRemoteProgressUpdatedAt } from './progress';
import type { KavitaPendingProgress } from './types';

const LEGACY_QUEUE_KEY = 'readest_kavita_progress_queue_v1';
const QUEUE_KEY = 'readest_kavita_progress_queue_v2';

const queueId = (item: Pick<KavitaPendingProgress, 'connectionId' | 'chapterId'>): string =>
  `${item.connectionId}:${item.chapterId}`;

export function discardLegacyKavitaProgressQueue(storage: Storage = localStorage): boolean {
  if (storage.getItem(LEGACY_QUEUE_KEY) === null) return false;
  storage.removeItem(LEGACY_QUEUE_KEY);
  return true;
}

export function listPendingKavitaProgress(
  storage: Storage = localStorage,
): KavitaPendingProgress[] {
  discardLegacyKavitaProgressQueue(storage);
  try {
    const parsed = JSON.parse(storage.getItem(QUEUE_KEY) ?? '[]') as KavitaPendingProgress[];
    return parsed.filter(
      (item) =>
        typeof item?.connectionId === 'string' &&
        Number.isInteger(item?.chapterId) &&
        item.chapterId > 0 &&
        item.payload?.chapterId === item.chapterId,
    );
  } catch {
    return [];
  }
}

function savePendingKavitaProgress(items: KavitaPendingProgress[], storage: Storage): void {
  storage.setItem(QUEUE_KEY, JSON.stringify(items));
}

export function enqueueKavitaProgress(
  item: KavitaPendingProgress,
  storage: Storage = localStorage,
): void {
  const id = queueId(item);
  savePendingKavitaProgress(
    [...listPendingKavitaProgress(storage).filter((candidate) => queueId(candidate) !== id), item],
    storage,
  );
}

export function removePendingKavitaProgress(
  connectionId: string,
  chapterId: number,
  storage: Storage = localStorage,
): void {
  savePendingKavitaProgress(
    listPendingKavitaProgress(storage).filter(
      (candidate) => candidate.connectionId !== connectionId || candidate.chapterId !== chapterId,
    ),
    storage,
  );
}

/** Flush one book without overwriting progress written by another device. */
export async function flushPendingKavitaProgress(
  client: KavitaClient,
  connectionId: string,
  chapterId: number,
  storage: Storage = localStorage,
): Promise<'none' | 'pushed' | 'remote-newer'> {
  const pending = listPendingKavitaProgress(storage).find(
    (candidate) => candidate.connectionId === connectionId && candidate.chapterId === chapterId,
  );
  if (!pending) return 'none';
  const remote = await client.getReaderProgress(chapterId);
  if (getKavitaRemoteProgressUpdatedAt(remote) > pending.localUpdatedAt) {
    removePendingKavitaProgress(connectionId, chapterId, storage);
    return 'remote-newer';
  }
  await client.saveReaderProgress(pending.payload);
  removePendingKavitaProgress(connectionId, chapterId, storage);
  return 'pushed';
}
