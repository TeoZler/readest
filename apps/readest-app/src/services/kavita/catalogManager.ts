import type { EnvConfigType } from '@/services/environment';
import { useLibraryStore } from '@/store/libraryStore';
import { syncKavitaCatalog, type KavitaCatalogSyncResult } from './catalogSync';
import { KavitaClient } from './client';
import { getKavitaConnectionRepository } from './connections';
import { KavitaError } from './errors';
import { getKavitaRuntimeBaseUrl, getKavitaRuntimeConnection } from './runtime';
import { createKavitaTransport } from './transport';

let activeSync: Promise<KavitaCatalogSyncResult[]> | null = null;

export async function syncAllKavitaCatalogs(
  envConfig: EnvConfigType,
  signal?: AbortSignal,
): Promise<KavitaCatalogSyncResult[]> {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    const repository = getKavitaConnectionRepository();
    if (!repository) return [];
    await repository.unlockAll();
    const appService = await envConfig.getAppService();
    if (!useLibraryStore.getState().libraryLoaded) {
      useLibraryStore.getState().setLibrary(await appService.loadLibraryBooks());
    }
    const results: KavitaCatalogSyncResult[] = [];
    for (const connection of repository.list()) {
      signal?.throwIfAborted();
      if (connection.selectedLibraryIds.length === 0) continue;
      const runtime = getKavitaRuntimeConnection(connection.id);
      if (!runtime) continue;
      const client = new KavitaClient(
        getKavitaRuntimeBaseUrl(runtime),
        runtime.authKey,
        createKavitaTransport({ allowInvalidTls: runtime.device.allowInvalidTls }),
      );
      try {
        const result = await syncKavitaCatalog({
          client,
          connection,
          currentBooks: useLibraryStore.getState().library,
          signal,
          persistStage: async ({ books }) => {
            await appService.saveLibraryBooks(books);
            useLibraryStore.getState().setLibrary(books);
          },
        });
        const device = repository.getDeviceConfig(connection.id);
        repository.saveDeviceConfig({
          ...device,
          lastSuccessfulSyncAt: Date.now(),
          lastDiagnostic: { checkedAt: Date.now(), ok: true },
        });
        results.push(result);
      } catch (error) {
        const device = repository.getDeviceConfig(connection.id);
        repository.saveDeviceConfig({
          ...device,
          lastDiagnostic: {
            checkedAt: Date.now(),
            ok: false,
            category: error instanceof KavitaError ? error.category : 'unknown',
            message: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
    }
    return results;
  })();
  try {
    return await activeSync;
  } finally {
    activeSync = null;
  }
}
