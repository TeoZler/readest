import { isTauriAppPlatform } from '@/services/environment';
import { getOSPlatform } from '@/utils/misc';
import {
  KAVITA_DEFAULT_DESKTOP_CACHE_BYTES,
  KAVITA_DEFAULT_MOBILE_CACHE_BYTES,
  KAVITA_DEFAULT_WEB_CACHE_BYTES,
} from './constants';
import { createKavitaCredentialStore, type KavitaCredentialStore } from './credentials';
import { KavitaError } from './errors';
import { registerKavitaRuntimeConnection, unregisterKavitaRuntimeConnection } from './runtime';
import type { KavitaConnectionConfig, KavitaDeviceConnectionConfig } from './types';
import type { KavitaConnectionReplica } from './types';

const CONNECTIONS_KEY = 'readest_kavita_connections_v1';
const DEVICE_CONFIGS_KEY = 'readest_kavita_device_configs_v1';

function parseList<T>(storage: Storage, key: string): T[] {
  try {
    const value = storage.getItem(key);
    return value ? (JSON.parse(value) as T[]) : [];
  } catch {
    return [];
  }
}

function defaultCacheCapacity(): number {
  if (!isTauriAppPlatform()) return KAVITA_DEFAULT_WEB_CACHE_BYTES;
  return getOSPlatform() === 'android'
    ? KAVITA_DEFAULT_MOBILE_CACHE_BYTES
    : KAVITA_DEFAULT_DESKTOP_CACHE_BYTES;
}

export class KavitaConnectionRepository {
  private readonly unlocks = new Map<string, Promise<boolean>>();

  constructor(
    private readonly storage: Storage,
    private readonly credentials: KavitaCredentialStore = createKavitaCredentialStore(),
  ) {}

  get credentialWarning(): string | undefined {
    return this.credentials.warning;
  }

  list(): KavitaConnectionConfig[] {
    return parseList<KavitaConnectionConfig>(this.storage, CONNECTIONS_KEY);
  }

  listDeviceConfigs(): KavitaDeviceConnectionConfig[] {
    return parseList<KavitaDeviceConnectionConfig>(this.storage, DEVICE_CONFIGS_KEY);
  }

  get(connectionId: string): KavitaConnectionConfig | undefined {
    return this.list().find((connection) => connection.id === connectionId);
  }

  getDeviceConfig(connectionId: string): KavitaDeviceConnectionConfig {
    return (
      this.listDeviceConfigs().find((config) => config.connectionId === connectionId) ?? {
        connectionId,
        allowInvalidTls: false,
        cacheEnabled: true,
        cacheCapacityBytes: defaultCacheCapacity(),
      }
    );
  }

  saveDeviceConfig(device: KavitaDeviceConnectionConfig): void {
    const devices = this.listDeviceConfigs().filter(
      (item) => item.connectionId !== device.connectionId,
    );
    this.storage.setItem(DEVICE_CONFIGS_KEY, JSON.stringify([...devices, device]));
  }

  async save(
    config: KavitaConnectionConfig,
    device: KavitaDeviceConnectionConfig,
    authKey?: string,
    options: { publish?: boolean } = {},
  ): Promise<void> {
    if (authKey !== undefined) await this.credentials.set(config.id, authKey);
    const connections = this.list().filter((item) => item.id !== config.id);
    const devices = this.listDeviceConfigs().filter((item) => item.connectionId !== config.id);
    this.storage.setItem(CONNECTIONS_KEY, JSON.stringify([...connections, config]));
    this.storage.setItem(DEVICE_CONFIGS_KEY, JSON.stringify([...devices, device]));
    const key = authKey ?? (await this.credentials.get(config.id));
    if (key) registerKavitaRuntimeConnection({ config, device, authKey: key });
    void import('./cover').then(({ resetKavitaCoverFailureState }) =>
      resetKavitaCoverFailureState(config.id),
    );
    if (options.publish !== false) {
      const { KAVITA_CONNECTION_KIND } = await import('@/services/sync/adapters/kavitaConnection');
      const { publishReplicaUpsert } = await import('@/services/sync/replicaPublish');
      await publishReplicaUpsert<KavitaConnectionReplica>(
        KAVITA_CONNECTION_KIND,
        { ...config, authKey: key ?? undefined },
        config.id,
      );
    }
  }

  async applyRemote(replica: KavitaConnectionReplica): Promise<void> {
    const { authKey, ...config } = replica;
    await this.save(config, this.getDeviceConfig(config.id), authKey, { publish: false });
  }

  async unlock(connectionId: string): Promise<boolean> {
    const existing = this.unlocks.get(connectionId);
    if (existing) return existing;
    const operation = (async () => {
      const config = this.get(connectionId);
      if (!config) return false;
      const authKey = await this.credentials.get(connectionId);
      if (!authKey) return false;
      registerKavitaRuntimeConnection({
        config,
        device: this.getDeviceConfig(connectionId),
        authKey,
      });
      return true;
    })();
    this.unlocks.set(connectionId, operation);
    try {
      return await operation;
    } finally {
      if (this.unlocks.get(connectionId) === operation) this.unlocks.delete(connectionId);
    }
  }

  async unlockAll(): Promise<void> {
    await Promise.all(this.list().map((connection) => this.unlock(connection.id)));
  }

  async remove(connectionId: string, typedServerName: string): Promise<void> {
    const connection = this.get(connectionId);
    if (!connection) return;
    if (typedServerName !== connection.name) {
      throw new KavitaError('invalid-response', 'Server name confirmation does not match');
    }
    this.storage.setItem(
      CONNECTIONS_KEY,
      JSON.stringify(this.list().filter((item) => item.id !== connectionId)),
    );
    this.storage.setItem(
      DEVICE_CONFIGS_KEY,
      JSON.stringify(this.listDeviceConfigs().filter((item) => item.connectionId !== connectionId)),
    );
    await this.credentials.clear(connectionId);
    unregisterKavitaRuntimeConnection(connectionId);
    void import('./cover').then(({ clearKavitaCoverUrls }) => clearKavitaCoverUrls(connectionId));
    const { KAVITA_CONNECTION_KIND } = await import('@/services/sync/adapters/kavitaConnection');
    const { publishReplicaDelete } = await import('@/services/sync/replicaPublish');
    await publishReplicaDelete(KAVITA_CONNECTION_KIND, connectionId);
  }

  async removeRemote(connectionId: string): Promise<void> {
    this.storage.setItem(
      CONNECTIONS_KEY,
      JSON.stringify(this.list().filter((item) => item.id !== connectionId)),
    );
    this.storage.setItem(
      DEVICE_CONFIGS_KEY,
      JSON.stringify(this.listDeviceConfigs().filter((item) => item.connectionId !== connectionId)),
    );
    await this.credentials.clear(connectionId);
    unregisterKavitaRuntimeConnection(connectionId);
    void import('./cover').then(({ clearKavitaCoverUrls }) => clearKavitaCoverUrls(connectionId));
  }
}

let defaultRepository: KavitaConnectionRepository | undefined;

export function getKavitaConnectionRepository(): KavitaConnectionRepository | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  defaultRepository ??= new KavitaConnectionRepository(localStorage);
  return defaultRepository;
}

export function findKavitaConnectionById(
  connectionId: string,
): KavitaConnectionReplica | undefined {
  return getKavitaConnectionRepository()?.get(connectionId);
}

export function applyRemoteKavitaConnection(connection: KavitaConnectionReplica): void {
  const repository = getKavitaConnectionRepository();
  if (repository) void repository.applyRemote(connection);
}

export function softDeleteRemoteKavitaConnection(connectionId: string): void {
  const repository = getKavitaConnectionRepository();
  if (repository) void repository.removeRemote(connectionId);
}
