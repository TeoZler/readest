import type { Book } from '@/types/book';
import { KavitaClient } from './client';
import { getKavitaRuntimeBaseUrl, getKavitaRuntimeConnection } from './runtime';
import { createKavitaTransport } from './transport';

const coverUrls = new Map<string, Promise<string>>();

export function loadKavitaCoverUrl(book: Book, signal?: AbortSignal): Promise<string> | null {
  const source = book.kavitaSource;
  if (!source) return null;
  const runtime = getKavitaRuntimeConnection(source.connectionId);
  if (!runtime) return null;
  const cacheKey = `${source.serverId}:${source.chapterId}:${source.fileCreated}`;
  const existing = coverUrls.get(cacheKey);
  if (existing) return existing;
  const pending = (async () => {
    const client = new KavitaClient(
      getKavitaRuntimeBaseUrl(runtime),
      runtime.authKey,
      createKavitaTransport({ allowInvalidTls: runtime.device.allowInvalidTls }),
    );
    const request = client.getChapterCoverRequest(source.chapterId);
    const response = await client.createAuthenticatedTransport()(request.url, {
      headers: request.headers,
      signal,
    });
    if (!response.ok) throw new Error(`Kavita cover failed with HTTP ${response.status}`);
    return URL.createObjectURL(await response.blob());
  })();
  coverUrls.set(cacheKey, pending);
  pending.catch(() => coverUrls.delete(cacheKey));
  return pending;
}
