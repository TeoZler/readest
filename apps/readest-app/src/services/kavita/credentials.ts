import { clearSecureItem, getSecureItem, setSecureItem } from '@/utils/bridge';
import { isTauriAppPlatform } from '@/services/environment';
import { KavitaError } from './errors';

const DB_NAME = 'readest-kavita-credentials';
const DB_VERSION = 1;
const KEY_STORE = 'keys';
const SECRET_STORE = 'secrets';
const MASTER_KEY_ID = 'kavita-auth-key-aes-gcm-v1';
const NATIVE_KEY_PREFIX = 'readest.kavita.auth.';

interface EncryptedCredentialRecord {
  connectionId: string;
  version: 1;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

export interface KavitaCredentialStore {
  readonly persistent: boolean;
  readonly warning?: string;
  set(connectionId: string, authKey: string): Promise<void>;
  get(connectionId: string): Promise<string | null>;
  clear(connectionId: string): Promise<void>;
}

export class NativeKavitaCredentialStore implements KavitaCredentialStore {
  readonly persistent = true;

  async set(connectionId: string, authKey: string): Promise<void> {
    const result = await setSecureItem({ key: NATIVE_KEY_PREFIX + connectionId, value: authKey });
    if (!result.success) {
      throw new KavitaError('authentication', result.error || 'Failed to store Kavita Auth Key');
    }
  }

  async get(connectionId: string): Promise<string | null> {
    const result = await getSecureItem({ key: NATIVE_KEY_PREFIX + connectionId });
    if (result.error) throw new KavitaError('authentication', result.error);
    return result.value ?? null;
  }

  async clear(connectionId: string): Promise<void> {
    const result = await clearSecureItem({ key: NATIVE_KEY_PREFIX + connectionId });
    if (!result.success) {
      throw new KavitaError('authentication', result.error || 'Failed to clear Kavita Auth Key');
    }
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function openCredentialDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE);
    if (!database.objectStoreNames.contains(SECRET_STORE)) {
      database.createObjectStore(SECRET_STORE, { keyPath: 'connectionId' });
    }
  };
  return requestResult(request);
}

export class WebKavitaCredentialStore implements KavitaCredentialStore {
  persistent = true;
  warning?: string;
  private readonly session = new Map<string, string>();
  private databasePromise?: Promise<IDBDatabase>;

  constructor(
    private readonly factory: IDBFactory | null | undefined = globalThis.indexedDB,
    private readonly subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
  ) {}

  private fallback(error: unknown): void {
    this.persistent = false;
    this.warning =
      'This browser could not securely persist the Kavita Auth Key. It will be kept for this session only.';
    console.warn(this.warning, error);
  }

  private async database(): Promise<IDBDatabase> {
    if (!this.factory) throw new Error('IndexedDB is unavailable');
    this.databasePromise ??= openCredentialDatabase(this.factory);
    return this.databasePromise;
  }

  private async masterKey(database: IDBDatabase): Promise<CryptoKey> {
    if (!this.subtle) throw new Error('Web Crypto is unavailable');
    const read = database.transaction(KEY_STORE, 'readonly');
    const readDone = transactionDone(read);
    const existing = await requestResult<CryptoKey | undefined>(
      read.objectStore(KEY_STORE).get(MASTER_KEY_ID),
    );
    await readDone;
    if (existing) return existing;
    const key = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const write = database.transaction(KEY_STORE, 'readwrite');
    const writeDone = transactionDone(write);
    write.objectStore(KEY_STORE).put(key, MASTER_KEY_ID);
    await writeDone;
    return key;
  }

  private additionalData(connectionId: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(`readest:kavita:${connectionId}`);
  }

  async set(connectionId: string, authKey: string): Promise<void> {
    try {
      const database = await this.database();
      const key = await this.masterKey(database);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await this.subtle!.encrypt(
        { name: 'AES-GCM', iv, additionalData: this.additionalData(connectionId) },
        key,
        new TextEncoder().encode(authKey),
      );
      const record: EncryptedCredentialRecord = {
        connectionId,
        version: 1,
        iv: iv.buffer.slice(0),
        ciphertext,
      };
      const transaction = database.transaction(SECRET_STORE, 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore(SECRET_STORE).put(record);
      await done;
      this.session.delete(connectionId);
    } catch (error) {
      this.fallback(error);
      this.session.set(connectionId, authKey);
    }
  }

  async get(connectionId: string): Promise<string | null> {
    const sessionValue = this.session.get(connectionId);
    if (sessionValue !== undefined) return sessionValue;
    try {
      const database = await this.database();
      const transaction = database.transaction(SECRET_STORE, 'readonly');
      const done = transactionDone(transaction);
      const record = await requestResult<EncryptedCredentialRecord | undefined>(
        transaction.objectStore(SECRET_STORE).get(connectionId),
      );
      await done;
      if (!record) return null;
      const key = await this.masterKey(database);
      const plaintext = await this.subtle!.decrypt(
        {
          name: 'AES-GCM',
          iv: record.iv,
          additionalData: this.additionalData(connectionId),
        },
        key,
        record.ciphertext,
      );
      return new TextDecoder().decode(plaintext);
    } catch (error) {
      this.fallback(error);
      return null;
    }
  }

  async clear(connectionId: string): Promise<void> {
    this.session.delete(connectionId);
    try {
      const database = await this.database();
      const transaction = database.transaction(SECRET_STORE, 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore(SECRET_STORE).delete(connectionId);
      await done;
    } catch (error) {
      this.fallback(error);
    }
  }
}

export function createKavitaCredentialStore(): KavitaCredentialStore {
  return isTauriAppPlatform() ? new NativeKavitaCredentialStore() : new WebKavitaCredentialStore();
}
