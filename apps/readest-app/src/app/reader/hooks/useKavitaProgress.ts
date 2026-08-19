import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBookDataStore } from '@/store/bookDataStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useReaderStore } from '@/store/readerStore';
import { debounce } from '@/utils/debounce';
import { eventDispatcher } from '@/utils/event';
import { KavitaClient } from '@/services/kavita/client';
import { KavitaError } from '@/services/kavita/errors';
import {
  buildKavitaProgressPayload,
  decideKavitaProgress,
  getKavitaLocalProgressUpdatedAt,
  getKavitaProgressFraction,
} from '@/services/kavita/progress';
import { enqueueKavitaProgress, flushPendingKavitaProgress } from '@/services/kavita/progressQueue';
import { redactKavitaSecret } from '@/services/kavita/redaction';
import { getKavitaRuntimeBaseUrl, getKavitaRuntimeConnection } from '@/services/kavita/runtime';
import { createKavitaTransport } from '@/services/kavita/transport';
import { getKavitaConnectionRepository } from '@/services/kavita/connections';
import type { KavitaKoreaderProgress } from '@/services/kavita/types';
import type { SyncDetails } from './useKOSync';
import { useWindowActiveChanged } from './useWindowActiveChanged';

type SyncState = 'idle' | 'checking' | 'conflict' | 'synced' | 'error';

const OFFLINE_CATEGORIES = new Set(['network', 'cors', 'tls', 'mixed-content']);

export const useKavitaProgress = (bookKey: string) => {
  const getBookData = useBookDataStore((state) => state.getBookData);
  const book = useBookDataStore((state) => state.getBookData(bookKey)?.book ?? null);
  const getView = useReaderStore((state) => state.getView);
  const progress = useBookProgress(bookKey);
  const source = book?.kavitaSource;
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [conflictDetails, setConflictDetails] = useState<SyncDetails | null>(null);
  const conflictRemoteRef = useRef<KavitaKoreaderProgress | null>(null);
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

  const deviceId = useMemo(() => {
    if (!source) return '';
    const repository = getKavitaConnectionRepository();
    if (!repository) return '';
    const device = repository.getDeviceConfig(source.connectionId);
    if (device.progressDeviceId) return device.progressDeviceId;
    const id = crypto.randomUUID();
    repository.saveDeviceConfig({ ...device, progressDeviceId: id });
    return id;
  }, [source]);

  const queueLocal = useCallback(
    (payload: KavitaKoreaderProgress, localUpdatedAt: number) => {
      if (!source || typeof localStorage === 'undefined') return;
      enqueueKavitaProgress({
        connectionId: source.connectionId,
        koreaderHash: source.koreaderHash,
        payload,
        localUpdatedAt,
        queuedAt: Date.now(),
      });
    },
    [source],
  );

  const pushCurrent = useCallback(async () => {
    const bookData = getBookData(bookKey);
    const currentProgress = useReaderStore.getState().getProgress(bookKey);
    if (!source || !client || !deviceId || !bookData?.book || !currentProgress) return;
    if (useReaderStore.getState().getViewState(bookKey)?.previewMode) return;
    const localUpdatedAt = Math.max(
      getKavitaLocalProgressUpdatedAt(bookData.config?.progress, bookData.config?.updatedAt),
      Date.now(),
    );
    const payload = buildKavitaProgressPayload(
      source.koreaderHash,
      currentProgress,
      deviceId,
      localUpdatedAt,
    );
    try {
      await client.putProgress(payload);
      setSyncState('synced');
    } catch (error) {
      if (
        (error instanceof KavitaError && OFFLINE_CATEGORIES.has(error.category)) ||
        (typeof navigator !== 'undefined' && !navigator.onLine)
      ) {
        queueLocal(payload, localUpdatedAt);
        return;
      }
      setSyncState('error');
      console.warn('Kavita progress sync failed:', redactKavitaSecret(error, runtime?.authKey));
    }
  }, [bookKey, client, deviceId, getBookData, queueLocal, runtime?.authKey, source]);

  const pushDebounced = useMemo(() => debounce(pushCurrent, 5000), [pushCurrent]);

  const applyRemote = useCallback(
    (remote: KavitaKoreaderProgress) => {
      const view = getView(bookKey);
      if (!view || !Number.isFinite(remote.percentage)) return;
      view.goToFraction(Math.max(0, Math.min(1, remote.percentage)));
      eventDispatcher.dispatch('hint', { bookKey, message: 'Reading Progress Synced' });
      setSyncState('synced');
      setConflictDetails(null);
      conflictRemoteRef.current = null;
    },
    [bookKey, getView],
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
          source.koreaderHash,
          localStorage,
        );
      }
      const remote = await client.getProgress(source.koreaderHash);
      if (!remote) {
        setSyncState('synced');
        return;
      }
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
        applyRemote(remote);
      } else if (decision === 'ask') {
        conflictRemoteRef.current = remote;
        setConflictDetails({
          book,
          bookDoc: bookData.bookDoc,
          local: {
            cfi: progress.location,
            preview: `Approximately ${(getKavitaProgressFraction(progress) * 100).toFixed(2)}%`,
          },
          remote: {
            ...remote,
            preview: `Approximately ${(remote.percentage * 100).toFixed(2)}%`,
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
  }, [applyRemote, book, bookKey, client, getBookData, progress, pushCurrent, runtime, source]);

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
      if (remote) applyRemote(remote);
    },
  };
};
