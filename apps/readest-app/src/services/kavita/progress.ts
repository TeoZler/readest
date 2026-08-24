import type { BookProgress } from '@/types/book';
import { normalizeProgressXPointer } from '@/utils/xcfi';
import type { KavitaBookSource, KavitaProgressStrategy, KavitaReaderProgressDto } from './types';

export const KAVITA_PROGRESS_CONFLICT_THRESHOLD = 0.01;

export type KavitaProgressDecision = 'push-local' | 'apply-remote' | 'ask' | 'none';

export interface KavitaResolvedRemoteProgress {
  dto: KavitaReaderProgressDto;
  fraction: number;
  cfi: string | null;
  approximate: boolean;
}

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

export function getKavitaRemoteProgressUpdatedAt(progress: KavitaReaderProgressDto): number {
  const parsed = Date.parse(progress.lastModifiedUtc || '');
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function hasKavitaReaderProgress(progress: KavitaReaderProgressDto): boolean {
  return (
    getKavitaRemoteProgressUpdatedAt(progress) > 0 ||
    progress.pageNum > 0 ||
    Boolean(progress.bookScrollId)
  );
}

/** Convert Readest/CREngine's full XPointer to the XPath Kavita Web stores. */
export function toKavitaBookScrollId(xpointer: string | null | undefined): string | null {
  if (!xpointer) return null;
  // Kavita Web evaluates BookScrollId as an element XPath. Text offsets are
  // not valid XPath in that reader, so retain the containing element/paragraph.
  const normalized = normalizeProgressXPointer(xpointer);
  const match = normalized.match(/^\/body\/DocFragment\[\d+\]\/body(.*)$/);
  return match ? `//body${match[1] ?? ''}` : null;
}

/** Convert Kavita Web's scoped XPath back to the XPointer shape XCFI accepts. */
export function fromKavitaBookScrollId(
  bookScrollId: string | null | undefined,
  pageNum: number,
): string | null {
  if (!bookScrollId) return null;
  if (bookScrollId.startsWith('/body/DocFragment[')) return bookScrollId;
  if (!bookScrollId.startsWith('//body')) return null;
  const section = Math.max(0, Math.floor(pageNum)) + 1;
  return `/body/DocFragment[${section}]/body${bookScrollId.slice('//body'.length)}`;
}

export function buildKavitaProgressPayload(
  source: KavitaBookSource,
  progress: BookProgress,
  bookScrollId: string | null,
  now = Date.now(),
): KavitaReaderProgressDto {
  const maximumPage = Math.max(0, (source.filePages ?? Number.POSITIVE_INFINITY) - 1);
  const pageNum = Math.max(0, Math.min(Math.floor(progress.index), maximumPage));
  return {
    volumeId: source.volumeId,
    chapterId: source.chapterId,
    pageNum,
    seriesId: source.seriesId,
    libraryId: source.libraryId,
    bookScrollId,
    lastModifiedUtc: new Date(now).toISOString(),
  };
}

export function decideKavitaProgress(
  strategy: KavitaProgressStrategy,
  localUpdatedAt: number,
  localFraction: number,
  remote: KavitaResolvedRemoteProgress | null,
  threshold = KAVITA_PROGRESS_CONFLICT_THRESHOLD,
): KavitaProgressDecision {
  if (!remote || !hasKavitaReaderProgress(remote.dto)) return 'none';
  const remoteUpdatedAt = getKavitaRemoteProgressUpdatedAt(remote.dto);
  if (remoteUpdatedAt <= localUpdatedAt) return 'push-local';
  const difference = Math.abs(localFraction - Math.max(0, Math.min(1, remote.fraction)));

  // A page-only legacy record is approximate. It may restore an otherwise
  // empty local book, but it must never silently replace a meaningful CFI.
  if (remote.approximate && localUpdatedAt > 0 && difference > threshold) {
    return strategy === 'prefer-local' ? 'push-local' : 'ask';
  }
  if (strategy === 'prefer-local') return 'push-local';
  if (strategy === 'prefer-remote' || difference <= threshold || localUpdatedAt === 0) {
    return 'apply-remote';
  }
  return 'ask';
}
