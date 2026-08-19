import { afterEach, describe, expect, it } from 'vitest';
import { WebKavitaCredentialStore } from '@/services/kavita/credentials';

const connectionId = 'browser-credential-test';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  return requestResult(indexedDB.open('readest-kavita-credentials', 1));
}

describe('Web Kavita credential encryption', () => {
  const store = new WebKavitaCredentialStore();

  afterEach(async () => {
    await store.clear(connectionId);
  });

  it('round-trips through AES-GCM without storing plaintext or an extractable key', async () => {
    const secret = 'browser-auth-key-that-must-not-be-plaintext';
    await store.set(connectionId, secret);
    expect(store.persistent).toBe(true);
    expect(await store.get(connectionId)).toBe(secret);

    const database = await openDatabase();
    const secretRecord = await requestResult<{
      connectionId: string;
      iv: ArrayBuffer;
      ciphertext: ArrayBuffer;
    }>(database.transaction('secrets').objectStore('secrets').get(connectionId));
    const key = await requestResult<CryptoKey>(
      database.transaction('keys').objectStore('keys').get('kavita-auth-key-aes-gcm-v1'),
    );
    database.close();

    expect(key.extractable).toBe(false);
    expect(secretRecord.iv.byteLength).toBe(12);
    expect(new TextDecoder().decode(secretRecord.ciphertext)).not.toContain(secret);
  });

  it('falls back to session memory with a warning when IndexedDB is unavailable', async () => {
    const sessionStore = new WebKavitaCredentialStore(null, crypto.subtle);
    await sessionStore.set(connectionId, 'session-only');
    expect(sessionStore.persistent).toBe(false);
    expect(sessionStore.warning).toContain('session only');
    expect(await sessionStore.get(connectionId)).toBe('session-only');
  });
});
