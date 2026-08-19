import type { KavitaConnectionConfig, KavitaDeviceConnectionConfig } from './types';

export interface KavitaRuntimeConnection {
  config: KavitaConnectionConfig;
  device: KavitaDeviceConnectionConfig;
  authKey: string;
}

const runtimeConnections = new Map<string, KavitaRuntimeConnection>();

export function registerKavitaRuntimeConnection(connection: KavitaRuntimeConnection): void {
  runtimeConnections.set(connection.config.id, connection);
}

export function unregisterKavitaRuntimeConnection(connectionId: string): void {
  runtimeConnections.delete(connectionId);
}

export function getKavitaRuntimeConnection(
  connectionId: string,
): KavitaRuntimeConnection | undefined {
  return runtimeConnections.get(connectionId);
}

export function clearKavitaRuntimeConnections(): void {
  runtimeConnections.clear();
}

export function getKavitaRuntimeBaseUrl(connection: KavitaRuntimeConnection): string {
  return connection.device.baseUrlOverride?.trim() || connection.config.defaultBaseUrl;
}
