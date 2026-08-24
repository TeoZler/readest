import type { BookMetadata } from '@/libs/document';

export type KavitaProgressStrategy = 'ask' | 'prefer-local' | 'prefer-remote';

export interface KavitaConnectionConfig {
  id: string;
  /** Readest-owned stable UUID. This is not Kavita's admin-only installId. */
  serverId: string;
  name: string;
  defaultBaseUrl: string;
  selectedLibraryIds: number[];
  progressStrategy: KavitaProgressStrategy;
  createdAt: number;
  updatedAt: number;
  lastSeenCipher?: Record<string, string>;
}

export interface KavitaDeviceConnectionConfig {
  connectionId: string;
  /** Stable only on this device; never included in the connection replica. */
  progressDeviceId?: string;
  baseUrlOverride?: string;
  allowInvalidTls: boolean;
  cacheEnabled: boolean;
  cacheCapacityBytes: number;
  syncCursor?: string;
  lastSuccessfulSyncAt?: number;
  lastDiagnostic?: KavitaDiagnosticSummary;
}

export interface KavitaDiagnosticSummary {
  checkedAt: number;
  ok: boolean;
  category?: KavitaErrorCategory;
  message?: string;
}

export type KavitaOfflineState = 'remote' | 'cached' | 'downloading' | 'offline' | 'orphaned';

export interface KavitaBookSource {
  kind: 'kavita';
  connectionId: string;
  serverId: string;
  libraryId: number;
  libraryName: string;
  seriesId: number;
  seriesName: string;
  volumeId: number;
  chapterId: number;
  fileId: number;
  /** Kavita's EPUB spine/page count. Optional for rows created by r1. */
  filePages?: number;
  fileBytes: number;
  fileCreated: string;
  fileExtension: string;
  koreaderHash: string;
  offlineState: KavitaOfflineState;
  localMetadataOverrides?: Array<'title' | 'author' | 'tags' | 'metadata'>;
  lastSeenAt: number;
}

export interface KavitaConnectionReplica extends KavitaConnectionConfig {
  authKey?: string;
}

export enum KavitaMangaFormat {
  Image = 0,
  Archive = 1,
  Unknown = 2,
  Epub = 3,
  Pdf = 4,
}

export interface KavitaPluginAuthenticationDto {
  username: string | null;
  token: string | null;
  kavitaVersion: string | null;
}

export interface KavitaLibraryDto {
  id: number;
  name: string | null;
  type: number;
  lastScanned: string;
}

export interface KavitaSeriesDto {
  id: number;
  name: string | null;
  localizedName?: string | null;
  sortName?: string | null;
  format: KavitaMangaFormat;
  libraryId: number;
  libraryName: string | null;
  created: string;
  lastChapterAddedUtc: string;
}

export interface KavitaPersonDto {
  id: number;
  name: string | null;
}

export interface KavitaTagDto {
  id: number;
  title: string | null;
}

export interface KavitaMangaFileDto {
  id: number;
  filePath: string | null;
  pages: number;
  bytes: number;
  format: KavitaMangaFormat;
  created: string;
  extension: string | null;
  koreaderHash: string | null;
}

export interface KavitaChapterDto {
  id: number;
  title: string | null;
  titleName: string | null;
  volumeId: number;
  volumeTitle: string | null;
  summary: string | null;
  language: string | null;
  createdUtc: string;
  lastModifiedUtc: string;
  files: KavitaMangaFileDto[] | null;
  writers: KavitaPersonDto[] | null;
  genres: KavitaTagDto[] | null;
  tags: KavitaTagDto[] | null;
  format: KavitaMangaFormat;
}

export interface KavitaVolumeDto {
  id: number;
  name: string | null;
  seriesId: number;
  lastModifiedUtc: string;
  chapters: KavitaChapterDto[] | null;
}

export interface KavitaPagination {
  currentPage: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface KavitaSeriesPage {
  items: KavitaSeriesDto[];
  pagination: KavitaPagination;
}

export interface KavitaReaderProgressDto {
  volumeId: number;
  chapterId: number;
  /** Zero-based EPUB spine/page index in Kavita. */
  pageNum: number;
  seriesId: number;
  libraryId: number;
  /** Kavita-scoped XPath such as `//body/p[3]`; null is a legacy coarse position. */
  bookScrollId: string | null;
  lastModifiedUtc: string;
}

export interface KavitaPendingProgress {
  connectionId: string;
  chapterId: number;
  payload: KavitaReaderProgressDto;
  localUpdatedAt: number;
  queuedAt: number;
}

export interface KavitaMappedMetadata {
  title: string;
  author: string;
  tags: string[];
  primaryLanguage?: string;
  metadata: BookMetadata;
}

export type KavitaErrorCategory =
  | 'invalid-url'
  | 'insecure-public-http'
  | 'unsupported-version'
  | 'authentication'
  | 'permission'
  | 'not-found'
  | 'cors'
  | 'mixed-content'
  | 'tls'
  | 'range-unsupported'
  | 'invalid-response'
  | 'network'
  | 'quota'
  | 'cancelled'
  | 'unknown';
