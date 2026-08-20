import { invoke } from '@tauri-apps/api/core';
import { KavitaError } from './errors';

export interface NativeCoverFileResult {
  status: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  retryAfter?: string;
  bodyBase64?: string;
  networkMs?: number;
  optimizeMs?: number;
  bodyBytes?: number;
}

export interface NativeKavitaCoverRequest {
  baseUrl: string;
  chapterId: number;
  authKey: string;
  allowInvalidTls: boolean;
  etag?: string;
  lastModified?: string;
  signal: AbortSignal;
}

const responseHeaders = (result: NativeCoverFileResult): Headers => {
  if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) {
    throw new KavitaError('invalid-response', 'Native Kavita cover status is invalid');
  }
  const headers = new Headers();
  if (result.contentType) headers.set('Content-Type', result.contentType);
  if (result.etag) headers.set('ETag', result.etag);
  if (result.lastModified) headers.set('Last-Modified', result.lastModified);
  if (result.retryAfter) headers.set('Retry-After', result.retryAfter);
  return headers;
};

export function createNativeCoverResponse(
  result: NativeCoverFileResult,
  body: BodyInit | null = null,
): Response {
  const headers = responseHeaders(result);
  if (result.status === 304) body = null;
  if (result.status >= 200 && result.status < 300 && result.status !== 204 && !body) {
    throw new KavitaError('invalid-response', 'Native Kavita cover file is missing');
  }
  return new Response(body, { status: result.status, headers });
}

const decodeBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new KavitaError('invalid-response', 'Native Kavita cover body is invalid');
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

type NativeCoverProbe = (metric: {
  invokeMs: number;
  decodeMs: number;
  networkMs: number;
  optimizeMs: number;
  bodyBytes: number;
}) => void;

const emitProbe = (result: NativeCoverFileResult, invokeMs: number, decodeMs: number): void => {
  const probe = (
    globalThis as typeof globalThis & { __READEST_KAVITA_COVER_PROBE__?: NativeCoverProbe }
  ).__READEST_KAVITA_COVER_PROBE__;
  probe?.({
    invokeMs,
    decodeMs,
    networkMs: result.networkMs ?? 0,
    optimizeMs: result.optimizeMs ?? 0,
    bodyBytes: result.bodyBytes ?? 0,
  });
};

const nativeFailure = (error: unknown, signal: AbortSignal): KavitaError => {
  if (signal.aborted || String(error) === 'cancelled') {
    return new KavitaError('cancelled', 'Kavita cover request was cancelled');
  }
  if (String(error) === 'tls') {
    return new KavitaError('tls', 'Kavita TLS certificate was rejected');
  }
  if (
    String(error) === 'invalid-response' ||
    String(error) === 'invalid-request' ||
    String(error) === 'storage'
  ) {
    return new KavitaError('invalid-response', 'Native Kavita cover request was rejected');
  }
  return new KavitaError('network', 'Native Kavita cover request failed');
};

export async function fetchNativeKavitaCover(request: NativeKavitaCoverRequest): Promise<Response> {
  request.signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  const cancel = () => {
    void invoke('cancel_kavita_cover_fetch', { requestId }).catch(() => undefined);
  };
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    const invokeStarted = performance.now();
    const result = await invoke<NativeCoverFileResult>('fetch_kavita_cover', {
      request: {
        requestId,
        baseUrl: request.baseUrl,
        chapterId: request.chapterId,
        authKey: request.authKey,
        allowInvalidTls: request.allowInvalidTls,
        etag: request.etag,
        lastModified: request.lastModified,
      },
    });
    const invokeMs = performance.now() - invokeStarted;
    request.signal.throwIfAborted();
    if (!result.bodyBase64) {
      emitProbe(result, invokeMs, 0);
      return createNativeCoverResponse(result);
    }
    const decodeStarted = performance.now();
    const body = decodeBase64(result.bodyBase64);
    const decodeMs = performance.now() - decodeStarted;
    request.signal.throwIfAborted();
    emitProbe(result, invokeMs, decodeMs);
    return createNativeCoverResponse(result, body.buffer);
  } catch (error) {
    if (error instanceof KavitaError) throw error;
    throw nativeFailure(error, request.signal);
  } finally {
    request.signal.removeEventListener('abort', cancel);
  }
}
