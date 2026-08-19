import { KavitaClient } from './client';
import { KAVITA_MIN_VERSION } from './constants';
import { KavitaError } from './errors';
import { createKavitaServerId } from './identity';
import { isSupportedKavitaChapter } from './mapper';
import { createKavitaTransport, type KavitaTransport } from './transport';
import type { KavitaChapterDto, KavitaLibraryDto, KavitaSeriesDto, KavitaVolumeDto } from './types';
import { isSupportedKavitaVersion } from './version';

export interface KavitaConnectionDiagnosticOptions {
  baseUrl: string;
  authKey: string;
  allowInvalidTls?: boolean;
  transport?: KavitaTransport;
  signal?: AbortSignal;
  pageSize?: number;
  volumeConcurrency?: number;
  existingServerId?: string;
}

export interface KavitaRepresentativeEpub {
  library: KavitaLibraryDto;
  series: KavitaSeriesDto;
  volume: KavitaVolumeDto;
  chapter: KavitaChapterDto;
  bytes: number;
}

export interface KavitaConnectionDiagnosticResult {
  server: { serverId: string; kavitaVersion: string; username: string };
  libraries: KavitaLibraryDto[];
  representative: KavitaRepresentativeEpub;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R | null>,
): Promise<R | null> {
  let cursor = 0;
  let result: R | null = null;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (result === null) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      const mapped = await mapper(values[index]!);
      if (mapped !== null) result = mapped;
    }
  });
  await Promise.all(workers);
  return result;
}

async function findRepresentativeEpub(
  client: KavitaClient,
  libraries: KavitaLibraryDto[],
  pageSize: number,
  volumeConcurrency: number,
  signal?: AbortSignal,
): Promise<KavitaRepresentativeEpub | null> {
  for (const library of libraries) {
    let pageNumber = 1;
    let totalPages = 1;
    do {
      const page = await client.getSeriesPage(library.id, pageNumber, pageSize, signal);
      totalPages = page.pagination.totalPages;
      const match = await mapConcurrent(page.items, volumeConcurrency, async (series) => {
        const volumes = await client.getVolumes(series.id, signal);
        for (const volume of volumes) {
          const chapter = (volume.chapters ?? []).find(isSupportedKavitaChapter);
          if (chapter) {
            return { library, series, volume, chapter, bytes: chapter.files![0]!.bytes };
          }
        }
        return null;
      });
      if (match) return match;
      pageNumber += 1;
    } while (pageNumber <= totalPages);
  }
  return null;
}

export async function diagnoseKavitaConnection(
  options: KavitaConnectionDiagnosticOptions,
): Promise<KavitaConnectionDiagnosticResult> {
  if (!options.authKey.trim()) throw new KavitaError('authentication', 'Enter a Kavita Auth Key');
  const transport =
    options.transport ?? createKavitaTransport({ allowInvalidTls: options.allowInvalidTls });
  const client = new KavitaClient(options.baseUrl, options.authKey, transport);
  const authentication = await client.authenticatePlugin(options.signal);
  if (!authentication.kavitaVersion || !authentication.username) {
    throw new KavitaError(
      'invalid-response',
      'Kavita authentication is missing version or username',
    );
  }
  if (!isSupportedKavitaVersion(authentication.kavitaVersion)) {
    throw new KavitaError(
      'unsupported-version',
      `Kavita ${authentication.kavitaVersion} is unsupported; Readest requires ${KAVITA_MIN_VERSION} or newer`,
    );
  }
  const libraries = await client.getLibraries(options.signal);
  if (libraries.length === 0) {
    throw new KavitaError('permission', 'This Auth Key cannot see any Kavita libraries');
  }
  const representative = await findRepresentativeEpub(
    client,
    libraries,
    options.pageSize ?? 50,
    options.volumeConcurrency ?? 4,
    options.signal,
  );
  if (!representative) {
    throw new KavitaError(
      'not-found',
      'No supported single-file EPUB chapter is visible to this Auth Key',
    );
  }
  const reportedBytes = await client.getChapterSize(representative.chapter.id, options.signal);
  if (reportedBytes !== representative.bytes) {
    throw new KavitaError(
      'invalid-response',
      `Kavita chapter size ${reportedBytes} does not match file size ${representative.bytes}`,
    );
  }
  await client.probeChapterRange(representative.chapter.id, representative.bytes, options.signal);
  return {
    server: {
      serverId: options.existingServerId ?? createKavitaServerId(),
      kavitaVersion: authentication.kavitaVersion,
      username: authentication.username,
    },
    libraries,
    representative,
  };
}
