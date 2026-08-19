import { useCallback, useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { getKavitaConnectionRepository } from '@/services/kavita/connections';
import { syncAllKavitaCatalogs } from '@/services/kavita/catalogManager';

const FOREGROUND_REFRESH_MS = 15 * 60 * 1000;

export function useKavitaCatalogSync() {
  const { envConfig } = useEnv();
  const libraryLoaded = useLibraryStore((state) => state.libraryLoaded);
  const controllerRef = useRef<AbortController | null>(null);

  const syncNow = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      return await syncAllKavitaCatalogs(envConfig, controller.signal);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [envConfig]);

  useEffect(() => {
    if (!libraryLoaded) return;
    void syncNow().catch(() => undefined);
  }, [libraryLoaded, syncNow]);

  useEffect(() => {
    const shouldRefresh = () => {
      const repository = getKavitaConnectionRepository();
      return repository?.list().some((connection) => {
        const last = repository.getDeviceConfig(connection.id).lastSuccessfulSyncAt ?? 0;
        return Date.now() - last >= FOREGROUND_REFRESH_MS;
      });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && shouldRefresh()) {
        void syncNow().catch(() => undefined);
      }
    };
    const onOnline = () => void syncNow().catch(() => undefined);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      controllerRef.current?.abort();
    };
  }, [syncNow]);

  return { syncKavitaNow: syncNow };
}
