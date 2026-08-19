import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { KavitaError, classifyKavitaNetworkError } from './errors';

export type KavitaTransport = (url: string, init?: RequestInit) => Promise<Response>;

export interface KavitaTransportOptions {
  allowInvalidTls?: boolean;
  forcePlatform?: 'web' | 'native';
}

export function createKavitaTransport(options: KavitaTransportOptions = {}): KavitaTransport {
  const native = options.forcePlatform ? options.forcePlatform === 'native' : isTauriAppPlatform();
  if (!native && options.allowInvalidTls) {
    throw new KavitaError('tls', 'Invalid certificates can only be allowed on native platforms');
  }

  return async (url, init = {}) => {
    if (
      !native &&
      typeof location !== 'undefined' &&
      location.protocol === 'https:' &&
      url.startsWith('http:')
    ) {
      throw new KavitaError('mixed-content', 'HTTPS pages cannot connect to an HTTP Kavita server');
    }
    try {
      if (native) {
        return await tauriFetch(url, {
          ...init,
          danger: options.allowInvalidTls
            ? { acceptInvalidCerts: true, acceptInvalidHostnames: true }
            : undefined,
        });
      }
      return await globalThis.fetch(url, init);
    } catch (error) {
      throw classifyKavitaNetworkError(error, url);
    }
  };
}
