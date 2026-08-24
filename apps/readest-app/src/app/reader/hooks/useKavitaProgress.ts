import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';
import { getBookProgress, useBookProgress } from '@/store/readerProgressStore';
import { useReaderStore } from '@/store/readerStore';
import { debounce } from '@/utils/debounce';
import { eventDispatcher } from '@/utils/event';
import { buildSectionFractionTable, getCFIFromXPointer, getXPointerFromCFI } from '@/utils/xcfi';
import { KavitaClient } from '@/services/kavita/client';
import { KavitaError } from '@/services/kavita/errors';
import {
  buildKavitaProgressPayload,
  decideKavitaProgress,
  fromKavitaBookScrollId,
  getKavitaLocalProgressUpdatedAt,
  getKavitaProgressFraction,
  hasKavitaReaderProgress,
  toKavitaBookScrollId,
  type KavitaResolvedRemoteProgress,
} from '@/services/kavita/progress';
import { enqueueKavitaProgress, flushPendingKavitaProgress } from '@/services/kavita/progressQueue';
import { redactKavitaSecret } from '@/services/kavita/redaction';
import { getKavitaRuntimeBaseUrl, getKavitaRuntimeConnection } from '@/services/kavita/runtime';
import { createKavitaTransport } from '@/services/kavita/transport';
import type { KavitaReaderProgressDto } from '@/services/kavita/types';
import type { SyncDetails, SyncRemotePreview } from './useKOSync';
import { useWindowActiveChanged } from './useWindowActiveChanged';

type SyncState = 'idle' | 'checking' | 'conflict' | 'synced' | 'error';

interface KavitaConflictRemote extends SyncRemotePreview {
  dto: KavitaReaderProgressDto;
  cfi: string | null;
  fraction: number;
  approximate: boolean;
}

const OFFLINE_CATEGORIES = new Set(['network', 'cors', 'tls', 'mixed-content']);

const pageFraction = (pageNum: number, sections: Array<{ size?: number }>): number => {
  const boundaries = buildSectionFractionTable(sections);
  if (boundaries.length <= 1) return 0;
  const index = Math.max(0, Math.min(Math.floor(pageNum), boundaries.length - 2));
  return boundaries[index] ?? 0;
};

export const useKavitaProgress = (bookKey: string) => {
  const _ = useTranslation();
  const getBookData = useBookDataStore((state) => state.getBookData);
  const book = useBookDataStore((state) => state.getBookData(bookKey)?.book ?? null);
  const getView = useReaderStore((state) => state.getView);
  const progress = useBookProgress(bookKey);
  const source = book?.kavitaSource;
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [conflictDetails, setConflictDetails] = useState<SyncDetails<KavitaConflictRemote> | null>(
    null,
  );
  const conflictRemoteRef = useRef<KavitaResolvedRemoteProgress | null>(null);
  const hasPulledOnce = useRef(false);

  const runtime = source ? getKavitaRuntimeConnection(source.connectionId) : undefined;
  const client = useMemo(() => {
    if (!runtime) return null;
    return new KavitaClient(
      getKavitaRuntimeBaseUrl(runtime),
      runtime.authKey,
      createKavitaTransport({ allowInvalidTls: runtime.device.allowInvalidTls }),
    );
  }, [runtime]);

  const queueLocal = useCallback(
    (payload: KavitaReaderProgressDto, localUpdatedAt: number) => {
      if (!source || typeof localStorage === 'undefined') return;
      enqueueKavitaProgress({
        connectionId: source.connectionId,
        chapterId: source.chapterId,
        payload,
        localUpdatedAt,
        queuedAt: Date.now(),
      });
    },
    [source],
  );

  const pushCurrent = useCallback(async () => {
    const bookData = getBookData(bookKey);
    const currentProgress = getBookProgress(bookKey);
    if (!source || !client || !bookData?.book || !bookData.bookDoc || !currentProgress) return;
    if (useReaderStore.getState().getViewState(bookKey)?.previewMode) return;
    const localUpdatedAt = Math.max(
      getKavitaLocalProgressUpdatedAt(bookData.config?.progress, bookData.config?.updatedAt),
      Date.now(),
    );
    try {
      const pointer = await getXPointerFromCFI(
        currentProgress.location,
        currentProgress.range?.startContainer?.ownerDocument ?? undefined,
        currentProgress.index,
        bookData.bookDoc,
      );
      const bookScrollId = toKavitaBookScrollId(pointer.xpointer);
      if (!bookScrollId) throw new Error('Failed to convert Readest CFI to Kavita XPath');
      const payload = buildKavitaProgressPayload(
        source,
        currentProgress,
        bookScrollId,
        localUpdatedAt,
      );
      try {
        await client.saveReaderProgress(payload);
        setSyncState('synced');
      } catch (error) {
        if (
          (error instanceof KavitaError && OFFLINE_CATEGORIES.has(error.category)) ||
          (typeof navigator !== 'undefined' && !navigator.onLine)
        ) {
          queueLocal(payload, localUpdatedAt);
          return;
        }
        throw error;
      }
    } catch (error) {
      setSyncState('error');
      console.warn('Kavita progress sync failed:', redactKavitaSecret(error, runtime?.authKey));
    }
  }, [bookKey, client, getBookData, queueLocal, runtime?.authKey, source]);

  const pushDebounced = useMemo(() => debounce(pushCurrent, 5000), [pushCurrent]);

  const resolveRemote = useCallback(
    async (dto: KavitaReaderProgressDto): Promise<KavitaResolvedRemoteProgress> => {
      const bookData = getBookData(bookKey);
      const view = getView(bookKey);
      const sections = bookData?.bookDoc?.sections ?? [];
      const fallbackFraction = pageFraction(dto.pageNum, sections);
      const xpointer = fromKavitaBookScrollId(dto.bookScrollId, dto.pageNum);
      if (!xpointer || !bookData?.bookDoc || !view) {
        return { dto, cfi: null, fraction: fallbackFraction, approximate: true };
      }
      try {
        const cfi = await getCFIFromXPointer(xpointer, undefined, undefined, bookData.bookDoc);
        const converted = await view.getCFIProgress(cfi);
        if (!converted) throw new Error('Kavita XPath did not resolve to foliate progress');
        return { dto, cfi, fraction: converted.fraction, approximate: false };
      } catch (error) {
        console.warn(
          'Kavita progress XPath is invalid; using its section start:',
          redactKavitaSecret(error, runtime?.authKey),
        );
        return { dto, cfi: null, fraction: fallbackFraction, approximate: true };
      }
    },
    [bookKey, getBookData, getView, runtime?.authKey],
  );

  const applyRemote = useCallback(
    async (remote: KavitaResolvedRemoteProgress) => {
      const view = getView(bookKey);
      if (!view) return;
      if (remote.cfi) await Promise.resolve(view.goTo(remote.cfi));
      else await Promise.resolve(view.goTo(Math.max(0, remote.dto.pageNum)));
      eventDispatcher.dispatch('hint', { bookKey, message: _('Reading Progress Synced') });
      setSyncState('synced');
      setConflictDetails(null);
      conflictRemoteRef.current = null;
    },
    [_, bookKey, getView],
  );

  const pullProgress = useCallback(async () => {
    if (!source || !client || !progress || !book) return;
    const bookData = getBookData(bookKey);
    if (!bookData?.bookDoc) return;
    hasPulledOnce.current = true;
    setSyncState('checking');
    try {
      if (typeof localStorage !== 'undefined') {
        await flushPendingKavitaProgress(
          client,
          source.connectionId,
          source.chapterId,
          localStorage,
        );
      }
      const dto = await client.getReaderProgress(source.chapterId);
      if (!hasKavitaReaderProgress(dto)) {
        setSyncState('synced');
        return;
      }
      const remote = await resolveRemote(dto);
      const localUpdatedAt = getKavitaLocalProgressUpdatedAt(
        bookData.config?.progress,
        bookData.config?.updatedAt,
      );
      const decision = decideKavitaProgress(
        runtime?.config.progressStrategy ?? 'ask',
        localUpdatedAt,
        getKavitaProgressFraction(progress),
        remote,
      );
      if (decision === 'push-local') {
        await pushCurrent();
      } else if (decision === 'apply-remote') {
        await applyRemote(remote);
      } else if (decision === 'ask') {
        conflictRemoteRef.current = remote;
        setConflictDetails({
          book,
          bookDoc: bookData.bookDoc,
          local: {
            cfi: progress.location,
            preview: _('Approximately {{percentage}}%', {
              percentage: (getKavitaProgressFraction(progress) * 100).toFixed(2),
            }),
          },
          remote: {
            dto,
            cfi: remote.cfi,
            fraction: remote.fraction,
            approximate: remote.approximate,
            device: 'Kavita',
            preview: remote.approximate
              ? _('Approximate legacy position · {{percentage}}%', {
                  percentage: (remote.fraction * 100).toFixed(2),
                })
              : _('Approximately {{percentage}}%', {
                  percentage: (remote.fraction * 100).toFixed(2),
                }),
          },
        });
        setSyncState('conflict');
      } else {
        setSyncState('synced');
      }
    } catch (error) {
      if (
        (error instanceof KavitaError && OFFLINE_CATEGORIES.has(error.category)) ||
        (typeof navigator !== 'undefined' && !navigator.onLine)
      ) {
        setSyncState('idle');
        return;
      }
      setSyncState('error');
      console.warn('Kavita progress pull failed:', redactKavitaSecret(error, runtime?.authKey));
    }
  }, [
    _,
    applyRemote,
    book,
    bookKey,
    client,
    getBookData,
    progress,
    pushCurrent,
    resolveRemote,
    runtime,
    source,
  ]);

  useEffect(() => {
    if (!source || !progress?.location || hasPulledOnce.current) return;
    void pullProgress();
  }, [progress?.location, pullProgress, source]);

  useEffect(() => {
    if (!source || !progress || syncState !== 'synced') return;
    pushDebounced();
  }, [progress, pushDebounced, source, syncState]);

  useEffect(() => {
    if (!source) return;
    const flush = (event: CustomEvent) => {
      if (event.detail.bookKey !== bookKey) return;
      pushDebounced.flush();
    };
    const online = () => void pullProgress();
    const visibility = () => {
      if (document.visibilityState === 'hidden') pushDebounced.flush();
    };
    eventDispatcher.on('flush-kavita', flush);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      eventDispatcher.off('flush-kavita', flush);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visibility);
      pushDebounced.flush();
    };
  }, [bookKey, pullProgress, pushDebounced, source]);

  useWindowActiveChanged((active) => {
    if (!source) return;
    if (active) void pullProgress();
    else pushDebounced.flush();
  });

  return {
    syncState,
    conflictDetails,
    resolveWithLocal: () => {
      setConflictDetails(null);
      conflictRemoteRef.current = null;
      setSyncState('synced');
      void pushCurrent();
    },
    resolveWithRemote: () => {
      const remote = conflictRemoteRef.current;
      if (remote) void applyRemote(remote);
    },
  };
};
