import type { BookProgress } from '@/types/book';
import type { KavitaKoreaderProgress, KavitaProgressStrategy } from './types';

export const KAVITA_PROGRESS_CONFLICT_THRESHOLD = 0.01;

export type KavitaProgressDecision = 'push-local' | 'apply-remote' | 'ask' | 'none';

export function getKavitaLocalProgressUpdatedAt(
  progress: [number, number] | null | undefined,
  configUpdatedAt: number | null | undefined,
): number {
  // A fresh EPUB relocates to page 1 while opening. That is not a user reading
  // event and must not make a newly-imported row look newer than Kavita.
  return progress && progress[0] > 1 ? (configUpdatedAt ?? 0) : 0;
}

export function getKavitaProgressFraction(progress: BookProgress): number {
  const pageTotal = progress.pageinfo?.total ?? 0;
  const fallback = pageTotal > 0 ? (progress.pageinfo.current + 1) / pageTotal : 0;
  const fraction = Number.isFinite(progress.fraction) ? progress.fraction : fallback;
  return Math.max(0, Math.min(1, fraction));
}

export function buildKavitaProgressPayload(
  koreaderHash: string,
  progress: BookProgress,
  deviceId: string,
  now = Date.now(),
): KavitaKoreaderProgress {
  return {
    document: koreaderHash,
    device_id: deviceId,
    device: 'Readest',
    percentage: getKavitaProgressFraction(progress),
    progress: `/body/DocFragment[${Math.max(1, progress.index + 1)}].0`,
    timestamp: Math.floor(now / 1000),
  };
}

export function decideKavitaProgress(
  strategy: KavitaProgressStrategy,
  localUpdatedAt: number,
  localFraction: number,
  remote: KavitaKoreaderProgress | null,
  threshold = KAVITA_PROGRESS_CONFLICT_THRESHOLD,
): KavitaProgressDecision {
  if (!remote) return 'none';
  const remoteUpdatedAt = Math.max(0, remote.timestamp || 0) * 1000;
  if (remoteUpdatedAt <= localUpdatedAt) return 'push-local';
  const difference = Math.abs(localFraction - Math.max(0, Math.min(1, remote.percentage || 0)));
  if (strategy === 'prefer-local') return 'push-local';
  if (strategy === 'prefer-remote' || difference <= threshold) return 'apply-remote';
  return 'ask';
}
