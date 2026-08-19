import type { KavitaClient } from './client';
import type { KavitaPendingProgress } from './types';

const QUEUE_KEY = 'readest_kavita_progress_queue_v1';

const queueId = (item: Pick<KavitaPendingProgress, 'connectionId' | 'koreaderHash'>): string =>
  `${item.connectionId}:${item.koreaderHash}`;

export function listPendingKavitaProgress(
  storage: Storage = localStorage,
): KavitaPendingProgress[] {
  try {
    return JSON.parse(storage.getItem(QUEUE_KEY) ?? '[]') as KavitaPendingProgress[];
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
  koreaderHash: string,
  storage: Storage = localStorage,
): void {
  savePendingKavitaProgress(
    listPendingKavitaProgress(storage).filter(
      (candidate) =>
        candidate.connectionId !== connectionId || candidate.koreaderHash !== koreaderHash,
    ),
    storage,
  );
}

/**
 * Flush one book after reconnect. A newer server timestamp always wins, so a
 * stale offline device can never overwrite progress made elsewhere.
 */
export async function flushPendingKavitaProgress(
  client: KavitaClient,
  connectionId: string,
  koreaderHash: string,
  storage: Storage = localStorage,
): Promise<'none' | 'pushed' | 'remote-newer'> {
  const pending = listPendingKavitaProgress(storage).find(
    (candidate) =>
      candidate.connectionId === connectionId && candidate.koreaderHash === koreaderHash,
  );
  if (!pending) return 'none';
  const remote = await client.getProgress(koreaderHash);
  if ((remote?.timestamp ?? 0) * 1000 > pending.localUpdatedAt) {
    removePendingKavitaProgress(connectionId, koreaderHash, storage);
    return 'remote-newer';
  }
  await client.putProgress(pending.payload);
  removePendingKavitaProgress(connectionId, koreaderHash, storage);
  return 'pushed';
}
