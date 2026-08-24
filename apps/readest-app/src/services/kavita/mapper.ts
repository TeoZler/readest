import type { Book } from '@/types/book';
import { createKavitaBookId } from './identity';
import type {
  KavitaBookSource,
  KavitaChapterDto,
  KavitaMappedMetadata,
  KavitaSeriesDto,
  KavitaVolumeDto,
} from './types';
import { KavitaMangaFormat } from './types';

const unique = (values: Array<string | null | undefined>): string[] =>
  Array.from(
    new Set(
      values
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => value.trim()),
    ),
  );

export function isSupportedKavitaChapter(chapter: KavitaChapterDto): boolean {
  return (
    chapter.format === KavitaMangaFormat.Epub &&
    chapter.files?.length === 1 &&
    chapter.files[0]?.format === KavitaMangaFormat.Epub &&
    Boolean(chapter.files[0]?.koreaderHash) &&
    chapter.files[0]!.bytes > 0
  );
}

export function mapKavitaMetadata(
  series: KavitaSeriesDto,
  volume: KavitaVolumeDto,
  chapter: KavitaChapterDto,
): KavitaMappedMetadata {
  const title =
    chapter.titleName?.trim() ||
    chapter.title?.trim() ||
    series.localizedName?.trim() ||
    series.name?.trim() ||
    `Chapter ${chapter.id}`;
  const writers = unique((chapter.writers ?? []).map((writer) => writer.name));
  const author = writers.join(', ') || 'Unknown author';
  const tags = unique([
    ...(chapter.genres ?? []).map((tag) => tag.title),
    ...(chapter.tags ?? []).map((tag) => tag.title),
  ]);
  const language = chapter.language?.trim() || '';
  return {
    title,
    author,
    tags,
    primaryLanguage: language || undefined,
    metadata: {
      title,
      author,
      language,
      description: chapter.summary ?? undefined,
      series: series.name ?? undefined,
      belongsTo: series.name
        ? { series: { name: series.name, position: volume.name ?? undefined } }
        : undefined,
    },
  };
}

export function mapKavitaChapterToBook(
  connectionId: string,
  serverId: string,
  libraryName: string,
  series: KavitaSeriesDto,
  volume: KavitaVolumeDto,
  chapter: KavitaChapterDto,
  now = Date.now(),
): Book | null {
  if (!isSupportedKavitaChapter(chapter)) return null;
  const file = chapter.files![0]!;
  const mapped = mapKavitaMetadata(series, volume, chapter);
  const createdAt = Date.parse(chapter.createdUtc) || now;
  const updatedAt = Date.parse(chapter.lastModifiedUtc) || now;
  const kavitaSource: KavitaBookSource = {
    kind: 'kavita',
    connectionId,
    serverId,
    libraryId: series.libraryId,
    libraryName,
    seriesId: series.id,
    seriesName: series.name ?? '',
    volumeId: volume.id,
    chapterId: chapter.id,
    fileId: file.id,
    filePages: file.pages,
    fileBytes: file.bytes,
    fileCreated: file.created,
    fileExtension: file.extension ?? '.epub',
    koreaderHash: file.koreaderHash!,
    offlineState: 'remote',
    lastSeenAt: now,
  };
  return {
    hash: createKavitaBookId(serverId, chapter.id),
    format: 'EPUB',
    title: mapped.title,
    sourceTitle: mapped.title,
    author: mapped.author,
    groupName: series.name ?? undefined,
    tags: mapped.tags,
    coverImageUrl: null,
    createdAt,
    updatedAt,
    primaryLanguage: mapped.primaryLanguage,
    metadata: mapped.metadata,
    kavitaSource,
  };
}

export function mergeKavitaBookMetadata(local: Book, incoming: Book): Book {
  const overrides = new Set(local.kavitaSource?.localMetadataOverrides ?? []);
  return {
    ...local,
    title: overrides.has('title') ? local.title : incoming.title,
    author: overrides.has('author') ? local.author : incoming.author,
    tags: overrides.has('tags') ? local.tags : incoming.tags,
    metadata: overrides.has('metadata') ? local.metadata : incoming.metadata,
    groupName: incoming.groupName,
    primaryLanguage: incoming.primaryLanguage,
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    kavitaSource: incoming.kavitaSource
      ? {
          ...incoming.kavitaSource,
          offlineState: local.kavitaSource?.offlineState ?? incoming.kavitaSource.offlineState,
          localMetadataOverrides: local.kavitaSource?.localMetadataOverrides,
        }
      : local.kavitaSource,
  };
}
