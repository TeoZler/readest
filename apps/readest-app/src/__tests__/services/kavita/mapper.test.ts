import { describe, expect, it } from 'vitest';
import { mapKavitaChapterToBook, mergeKavitaBookMetadata } from '@/services/kavita/mapper';
import { KavitaMangaFormat } from '@/services/kavita/types';
import type { KavitaChapterDto, KavitaSeriesDto, KavitaVolumeDto } from '@/services/kavita/types';

const series: KavitaSeriesDto = {
  id: 10,
  name: 'Series',
  format: KavitaMangaFormat.Epub,
  libraryId: 2,
  libraryName: 'Books',
  created: '2026-01-01T00:00:00Z',
  lastChapterAddedUtc: '2026-01-02T00:00:00Z',
};
const chapter: KavitaChapterDto = {
  id: 30,
  title: 'Chapter Title',
  titleName: 'Book Title',
  volumeId: 20,
  volumeTitle: 'Volume 1',
  summary: 'Summary',
  language: 'en',
  createdUtc: '2026-01-01T00:00:00Z',
  lastModifiedUtc: '2026-01-03T00:00:00Z',
  writers: [{ id: 1, name: 'Writer' }],
  genres: [{ id: 1, title: 'Fantasy' }],
  tags: [
    { id: 2, title: 'Fantasy' },
    { id: 3, title: 'Long' },
  ],
  format: KavitaMangaFormat.Epub,
  files: [
    {
      id: 40,
      filePath: '/books/a.epub',
      pages: 1,
      bytes: 1234,
      format: KavitaMangaFormat.Epub,
      created: '2026-01-01T00:00:00Z',
      extension: '.epub',
      koreaderHash: 'ko-hash',
    },
  ],
};
const volume: KavitaVolumeDto = {
  id: 20,
  name: 'Volume 1',
  seriesId: 10,
  lastModifiedUtc: '2026-01-03T00:00:00Z',
  chapters: [chapter],
};

describe('Kavita DTO mapper', () => {
  it('maps exactly one EPUB file to an independent Readest book identity', () => {
    const book = mapKavitaChapterToBook('connection', 'install', 'Books', series, volume, chapter)!;
    expect(book).toMatchObject({
      format: 'EPUB',
      title: 'Book Title',
      author: 'Writer',
      tags: ['Fantasy', 'Long'],
      groupName: 'Series',
      kavitaSource: {
        chapterId: 30,
        fileId: 40,
        koreaderHash: 'ko-hash',
      },
    });
    expect(book.hash).not.toBe('ko-hash');
  });

  it('rejects multi-file, non-EPUB, and missing KOReader hash chapters', () => {
    expect(
      mapKavitaChapterToBook('c', 'i', 'Books', series, volume, {
        ...chapter,
        files: [...chapter.files!, ...chapter.files!],
      }),
    ).toBeNull();
    expect(
      mapKavitaChapterToBook('c', 'i', 'Books', series, volume, {
        ...chapter,
        format: KavitaMangaFormat.Pdf,
      }),
    ).toBeNull();
    expect(
      mapKavitaChapterToBook('c', 'i', 'Books', series, volume, {
        ...chapter,
        files: [{ ...chapter.files![0]!, koreaderHash: null }],
      }),
    ).toBeNull();
  });

  it('preserves locally overridden fields while refreshing source metadata', () => {
    const local = mapKavitaChapterToBook(
      'connection',
      'install',
      'Books',
      series,
      volume,
      chapter,
    )!;
    local.title = 'My title';
    local.kavitaSource!.localMetadataOverrides = ['title'];
    const incoming = mapKavitaChapterToBook('connection', 'install', 'Books', series, volume, {
      ...chapter,
      titleName: 'Server title',
      writers: [{ id: 2, name: 'New writer' }],
      files: [{ ...chapter.files![0]!, bytes: 9999 }],
    })!;
    const merged = mergeKavitaBookMetadata(local, incoming);
    expect(merged.title).toBe('My title');
    expect(merged.author).toBe('New writer');
    expect(merged.kavitaSource?.fileBytes).toBe(9999);
  });
});
