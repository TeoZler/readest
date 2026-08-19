import { describe, expect, it } from 'vitest';
import { KavitaConnectionRepository } from '@/services/kavita/connections';
import type { KavitaCredentialStore } from '@/services/kavita/credentials';
import {
  clearKavitaRuntimeConnections,
  getKavitaRuntimeConnection,
} from '@/services/kavita/runtime';
import type { KavitaConnectionConfig, KavitaDeviceConnectionConfig } from '@/services/kavita/types';

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

class MemoryCredentials implements KavitaCredentialStore {
  readonly persistent = false;
  readonly values = new Map<string, string>();
  async set(id: string, value: string) {
    this.values.set(id, value);
  }
  async get(id: string) {
    return this.values.get(id) ?? null;
  }
  async clear(id: string) {
    this.values.delete(id);
  }
}

const connection: KavitaConnectionConfig = {
  id: 'connection',
  serverId: 'server',
  name: 'Home Kavita',
  defaultBaseUrl: 'https://books.example.test',
  selectedLibraryIds: [2],
  progressStrategy: 'ask',
  createdAt: 1,
  updatedAt: 1,
};
const device: KavitaDeviceConnectionConfig = {
  connectionId: 'connection',
  baseUrlOverride: 'http://192.168.1.2:5000',
  allowInvalidTls: false,
  cacheEnabled: true,
  cacheCapacityBytes: 123,
};

describe('KavitaConnectionRepository', () => {
  it('persists only non-secret configuration and unlocks runtime credentials', async () => {
    clearKavitaRuntimeConnections();
    const storage = new MemoryStorage();
    const credentials = new MemoryCredentials();
    const repository = new KavitaConnectionRepository(storage, credentials);
    await repository.save(connection, device, 'top-secret');
    expect(
      Array.from({ length: storage.length }, (_, index) =>
        storage.getItem(storage.key(index)!),
      ).join(' '),
    ).not.toContain('top-secret');
    expect(credentials.values.get('connection')).toBe('top-secret');
    expect(getKavitaRuntimeConnection('connection')).toMatchObject({ authKey: 'top-secret' });
  });

  it('requires exact server-name confirmation before removal', async () => {
    const storage = new MemoryStorage();
    const credentials = new MemoryCredentials();
    const repository = new KavitaConnectionRepository(storage, credentials);
    await repository.save(connection, device, 'key');
    await expect(repository.remove('connection', 'wrong')).rejects.toThrow('does not match');
    expect(repository.get('connection')).toBeDefined();
    await repository.remove('connection', 'Home Kavita');
    expect(repository.get('connection')).toBeUndefined();
    expect(credentials.values.has('connection')).toBe(false);
  });
});
