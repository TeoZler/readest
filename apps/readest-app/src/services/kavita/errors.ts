import type { KavitaErrorCategory } from './types';

export class KavitaError extends Error {
  constructor(
    public readonly category: KavitaErrorCategory,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'KavitaError';
  }
}

export function classifyKavitaHttpError(status: number, context = 'Kavita request'): KavitaError {
  if (status === 401)
    return new KavitaError('authentication', `${context} was not authenticated`, status);
  if (status === 403)
    return new KavitaError('permission', `${context} requires Download permission`, status);
  if (status === 404) return new KavitaError('not-found', `${context} was not found`, status);
  return new KavitaError('invalid-response', `${context} failed with HTTP ${status}`, status);
}

export function classifyKavitaNetworkError(error: unknown, url?: string): KavitaError {
  if (error instanceof KavitaError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new KavitaError('cancelled', 'Kavita request was cancelled', undefined, {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('certificate') || lower.includes('cert_') || lower.includes('ssl')) {
    return new KavitaError('tls', 'Kavita TLS certificate was rejected', undefined, {
      cause: error,
    });
  }
  if (
    typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    url?.startsWith('http:')
  ) {
    return new KavitaError(
      'mixed-content',
      'HTTPS pages cannot connect to an HTTP Kavita server',
      undefined,
      {
        cause: error,
      },
    );
  }
  if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
    return new KavitaError(
      'cors',
      'Kavita could not be reached; check CORS, certificate trust, and network access',
      undefined,
      { cause: error },
    );
  }
  return new KavitaError('network', `Kavita network request failed: ${message}`, undefined, {
    cause: error,
  });
}
