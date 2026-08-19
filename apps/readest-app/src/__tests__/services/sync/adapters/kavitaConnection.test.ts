import { describe, expect, it } from 'vitest';
import {
  KAVITA_CONNECTION_KIND,
  kavitaConnectionAdapter,
} from '@/services/sync/adapters/kavitaConnection';
import type { KavitaConnectionReplica } from '@/services/kavita/types';
import type { FieldEnvelope, Hlc, ReplicaRow } from '@/types/replica';

const HLC = '00000000000-00000000-dev' as Hlc;
const env = <T>(value: T): FieldEnvelope<T> => ({ v: value, t: HLC, s: 'dev' });
const connection: KavitaConnectionReplica = {
  id: 'connection-id',
  serverId: 'server-id',
  name: 'Home Kavita',
  defaultBaseUrl: 'https://books.example.test',
  selectedLibraryIds: [2, 4],
  progressStrategy: 'ask',
  createdAt: 10,
  updatedAt: 20,
  authKey: 'top-secret',
};

const row: ReplicaRow = {
  user_id: 'user',
  kind: KAVITA_CONNECTION_KIND,
  replica_id: connection.id,
  fields_jsonb: {
    serverId: env(connection.serverId),
    name: env(connection.name),
    defaultBaseUrl: env(connection.defaultBaseUrl),
    selectedLibraryIds: env(connection.selectedLibraryIds),
    progressStrategy: env(connection.progressStrategy),
    createdAt: env(connection.createdAt),
    updatedAt: env(connection.updatedAt),
    authKey: env(connection.authKey),
  },
  manifest_jsonb: null,
  deleted_at_ts: null,
  reincarnation: null,
  updated_at_ts: HLC,
  schema_version: 1,
};

describe('kavitaConnectionAdapter', () => {
  it('declares Auth Key as an encrypted metadata-only field', () => {
    expect(kavitaConnectionAdapter.binary).toBeUndefined();
    expect(kavitaConnectionAdapter.encryptedFields).toEqual(['serverId', 'authKey']);
  });

  it('packs plaintext only for the crypto middleware boundary', () => {
    const packed = kavitaConnectionAdapter.pack(connection);
    expect(packed).toMatchObject({
      serverId: 'server-id',
      defaultBaseUrl: 'https://books.example.test',
      selectedLibraryIds: [2, 4],
      authKey: 'top-secret',
    });
  });

  it('uses the explicit connection id as stable replica identity', async () => {
    await expect(kavitaConnectionAdapter.computeId(connection)).resolves.toBe('connection-id');
  });

  it('unpacks decrypted CRDT fields without device-local settings', () => {
    expect(kavitaConnectionAdapter.unpackRow(row, '')).toEqual(connection);
  });
});
