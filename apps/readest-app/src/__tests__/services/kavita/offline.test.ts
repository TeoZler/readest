import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { downloadKavitaBookOffline } from '@/services/kavita/offline';
import { openKavitaBookFile } from '@/services/kavita/content';

vi.mock('@/services/kavita/content', () => ({ openKavitaBookFile: vi.fn() }));
vi.mock('@/libs/document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/document')>();
  return {
    ...actual,
    DocumentLoader: class {
      async open() {
        return { book: {}, format: 'EPUB' };
      }
    },
  };
});

const book: Book = {
  hash: 'book',
  format: 'EPUB',
  title: 'Book',
  author: 'Author',
  createdAt: 1,
  updatedAt: 1,
  kavitaSource: {
    kind: 'kavita',
    connectionId: 'connection',
    serverId: 'server',
    libraryId: 1,
    libraryName: 'Books',
    seriesId: 2,
    seriesName: 'Series',
    volumeId: 3,
    chapterId: 4,
    fileId: 5,
    fileBytes: 4,
    fileCreated: 'v1',
    fileExtension: '.epub',
    koreaderHash: 'hash',
    offlineState: 'remote',
    lastSeenAt: 1,
  },
};

describe('Kavita offline download', () => {
  beforeEach(() => {
    vi.mocked(openKavitaBookFile).mockReset();
  });

  it('verifies size and EPUB parsing before switching to offline state', async () => {
    const remote = Object.assign(new File([new Uint8Array(4)], 'book.epub'), {
      close: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(openKavitaBookFile).mockResolvedValue(remote as never);
    const writes: string[] = [];
    const removes: string[] = [];
    const service = {
      writeFile: vi.fn(async (path: string) => void writes.push(path)),
      openFile: vi.fn(async () => new File([new Uint8Array(4)], 'book.epub')),
      deleteFile: vi.fn(async (path: string) => void removes.push(path)),
    } as unknown as AppService;
    const updated = await downloadKavitaBookOffline(service, book);
    expect(updated.kavitaSource?.offlineState).toBe('offline');
    expect(updated.downloadedAt).toBeTypeOf('number');
    expect(writes).toHaveLength(2);
    expect(removes.some((path) => path.endsWith('.kavita-part'))).toBe(true);
  });

  it('cleans the temporary file and keeps the row remote on a size mismatch', async () => {
    const remote = Object.assign(new File([new Uint8Array(4)], 'book.epub'), {
      close: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(openKavitaBookFile).mockResolvedValue(remote as never);
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const service = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      openFile: vi.fn(async () => new File([new Uint8Array(3)], 'book.epub')),
      deleteFile,
    } as unknown as AppService;
    await expect(downloadKavitaBookOffline(service, book)).rejects.toThrow('does not match');
    expect(deleteFile).toHaveBeenCalledWith(expect.stringContaining('.kavita-part'), 'Books');
  });
});
