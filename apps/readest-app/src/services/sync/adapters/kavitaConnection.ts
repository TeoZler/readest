import type { ReplicaAdapter } from '@/services/sync/replicaRegistry';
import type { FieldsObject, ReplicaRow } from '@/types/replica';
import type { KavitaConnectionReplica, KavitaProgressStrategy } from '@/services/kavita/types';
import { unwrap } from './helpers';

export const KAVITA_CONNECTION_KIND = 'kavita_connection';
export const KAVITA_CONNECTION_SCHEMA_VERSION = 1;

const isProgressStrategy = (value: unknown): value is KavitaProgressStrategy =>
  value === 'ask' || value === 'prefer-local' || value === 'prefer-remote';

function unpackFields(fields: FieldsObject): Partial<KavitaConnectionReplica> {
  const selectedLibraryIds = unwrap(fields['selectedLibraryIds']);
  const progressStrategy = unwrap(fields['progressStrategy']);
  const authKey = unwrap(fields['authKey']);
  return {
    serverId:
      typeof unwrap(fields['serverId']) === 'string'
        ? String(unwrap(fields['serverId']))
        : undefined,
    name: typeof unwrap(fields['name']) === 'string' ? String(unwrap(fields['name'])) : undefined,
    defaultBaseUrl:
      typeof unwrap(fields['defaultBaseUrl']) === 'string'
        ? String(unwrap(fields['defaultBaseUrl']))
        : undefined,
    selectedLibraryIds: Array.isArray(selectedLibraryIds)
      ? selectedLibraryIds.filter((value): value is number => Number.isInteger(value))
      : undefined,
    progressStrategy: isProgressStrategy(progressStrategy) ? progressStrategy : undefined,
    createdAt:
      typeof unwrap(fields['createdAt']) === 'number'
        ? Number(unwrap(fields['createdAt']))
        : undefined,
    updatedAt:
      typeof unwrap(fields['updatedAt']) === 'number'
        ? Number(unwrap(fields['updatedAt']))
        : undefined,
    authKey: typeof authKey === 'string' ? authKey : undefined,
  };
}

export const kavitaConnectionAdapter: ReplicaAdapter<KavitaConnectionReplica> = {
  kind: KAVITA_CONNECTION_KIND,
  schemaVersion: KAVITA_CONNECTION_SCHEMA_VERSION,

  pack(connection) {
    const fields: Record<string, unknown> = {
      serverId: connection.serverId,
      name: connection.name,
      defaultBaseUrl: connection.defaultBaseUrl,
      selectedLibraryIds: connection.selectedLibraryIds,
      progressStrategy: connection.progressStrategy,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
    if (connection.authKey !== undefined) fields['authKey'] = connection.authKey;
    return fields;
  },

  unpack(fields) {
    return {
      id: String(fields['id'] ?? ''),
      serverId: String(fields['serverId'] ?? ''),
      name: String(fields['name'] ?? ''),
      defaultBaseUrl: String(fields['defaultBaseUrl'] ?? ''),
      selectedLibraryIds: Array.isArray(fields['selectedLibraryIds'])
        ? fields['selectedLibraryIds'].filter((value): value is number => Number.isInteger(value))
        : [],
      progressStrategy: isProgressStrategy(fields['progressStrategy'])
        ? fields['progressStrategy']
        : 'ask',
      createdAt: Number(fields['createdAt'] ?? 0),
      updatedAt: Number(fields['updatedAt'] ?? 0),
      authKey: typeof fields['authKey'] === 'string' ? fields['authKey'] : undefined,
    };
  },

  async computeId(connection) {
    return connection.id;
  },

  unpackRow(row: ReplicaRow) {
    const fields = unpackFields(row.fields_jsonb);
    if (!fields.serverId || !fields.name || !fields.defaultBaseUrl) return null;
    return {
      id: row.replica_id,
      serverId: fields.serverId,
      name: fields.name,
      defaultBaseUrl: fields.defaultBaseUrl,
      selectedLibraryIds: fields.selectedLibraryIds ?? [],
      progressStrategy: fields.progressStrategy ?? 'ask',
      createdAt: fields.createdAt ?? Date.now(),
      updatedAt: fields.updatedAt ?? Date.now(),
      authKey: fields.authKey,
    };
  },

  encryptedFields: ['serverId', 'authKey'] as const,
};
