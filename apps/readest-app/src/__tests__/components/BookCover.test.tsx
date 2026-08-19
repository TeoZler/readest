import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

import BookCover from '@/components/BookCover';
import { Book } from '@/types/book';

const acquireKavitaCoverUrl = vi.hoisted(() => vi.fn());

vi.mock('@/services/kavita/cover', () => ({ acquireKavitaCoverUrl }));

vi.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    // biome-ignore lint/a11y/useAltText: test mock; alt comes from spread props
    return <img {...props} />;
  },
}));

afterEach(() => {
  cleanup();
  acquireKavitaCoverUrl.mockReset();
  vi.unstubAllGlobals();
});

const makeBook = (overrides?: Partial<Book>): Book =>
  ({
    hash: 'abc123',
    title: 'Test Book',
    author: 'Test Author',
    format: 'epub',
    coverImageUrl: 'https://example.com/cover.jpg',
    ...overrides,
  }) as Book;

const makeKavitaSource = (): NonNullable<Book['kavitaSource']> => ({
  kind: 'kavita',
  connectionId: 'connection',
  serverId: 'server',
  libraryId: 2,
  libraryName: 'Books',
  seriesId: 3,
  seriesName: 'Series',
  volumeId: 4,
  chapterId: 5,
  fileId: 6,
  fileBytes: 1024,
  fileCreated: '2026-08-19T00:00:00Z',
  fileExtension: '.epub',
  koreaderHash: 'ko-hash',
  offlineState: 'remote',
  lastSeenAt: 1,
});

describe('BookCover', () => {
  it('passes loading="lazy" to crop-mode Image', () => {
    const { container } = render(<BookCover book={makeBook()} coverFit='crop' />);
    const img = container.querySelector('img.cover-image');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('loading')).toBe('lazy');
  });

  it('passes loading="lazy" to fit-mode Image', () => {
    const { container } = render(<BookCover book={makeBook()} coverFit='fit' />);
    const img = container.querySelector('img.cover-image');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('loading')).toBe('lazy');
  });

  it('reports natural aspect ratio via onAspectRatioChange when fit-mode image loads', () => {
    const onAspectRatioChange = vi.fn();
    const { container } = render(
      <BookCover book={makeBook()} coverFit='fit' onAspectRatioChange={onAspectRatioChange} />,
    );
    const img = container.querySelector('img.cover-image') as HTMLImageElement;
    expect(img).toBeTruthy();

    Object.defineProperty(img, 'naturalWidth', { value: 600, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 900, configurable: true });
    fireEvent.load(img);

    expect(onAspectRatioChange).toHaveBeenCalledWith(600 / 900);
  });

  it('falls back to metadata.author on the fallback cover when book.author is empty', () => {
    const book = makeBook({
      author: '',
      coverImageUrl: undefined,
      metadata: { author: 'Edited Author' } as Book['metadata'],
    });
    const { container } = render(<BookCover book={book} coverFit='crop' />);
    const fallback = container.querySelector('.fallback-cover');
    expect(fallback?.textContent).toContain('Edited Author');
  });

  it('uses the extracted Kavita cover and releases its lease when the file version changes', async () => {
    const releaseFirst = vi.fn();
    const releaseSecond = vi.fn();
    acquireKavitaCoverUrl
      .mockReturnValueOnce({ url: Promise.resolve('blob:kavita-cover-v1'), release: releaseFirst })
      .mockReturnValueOnce({
        url: Promise.resolve('blob:kavita-cover-v2'),
        release: releaseSecond,
      });
    const kavitaSource = makeKavitaSource();
    const { container, rerender, unmount } = render(
      <BookCover book={makeBook({ kavitaSource })} coverFit='crop' />,
    );

    await waitFor(() => {
      expect(container.querySelector('img.cover-image')?.getAttribute('src')).toBe(
        'blob:kavita-cover-v1',
      );
    });
    rerender(
      <BookCover
        book={makeBook({
          kavitaSource: { ...kavitaSource, fileCreated: '2026-08-19T00:01:00Z' },
        })}
        coverFit='crop'
      />,
    );
    await waitFor(() => {
      expect(releaseFirst).toHaveBeenCalledOnce();
      expect(container.querySelector('img.cover-image')?.getAttribute('src')).toBe(
        'blob:kavita-cover-v2',
      );
    });
    unmount();
    expect(releaseSecond).toHaveBeenCalledOnce();
  });

  it('does not extract a Kavita cover until the card approaches the viewport', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }
        observe() {}
        unobserve() {}
        disconnect = disconnect;
        takeRecords() {
          return [];
        }
        root = null;
        rootMargin = '50% 0px';
        thresholds = [0];
      },
    );
    const release = vi.fn();
    acquireKavitaCoverUrl.mockReturnValue({
      url: Promise.resolve('blob:visible-kavita-cover'),
      release,
    });
    const { container, unmount } = render(
      <BookCover book={makeBook({ kavitaSource: makeKavitaSource() })} coverFit='crop' />,
    );

    expect(acquireKavitaCoverUrl).not.toHaveBeenCalled();
    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    await waitFor(() => {
      expect(acquireKavitaCoverUrl).toHaveBeenCalledOnce();
      expect(container.querySelector('img.cover-image')?.getAttribute('src')).toBe(
        'blob:visible-kavita-cover',
      );
    });
    expect(disconnect).toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledOnce();
  });
});
