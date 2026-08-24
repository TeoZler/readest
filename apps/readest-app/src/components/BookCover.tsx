import clsx from 'clsx';
import Image from 'next/image';
import { memo, useEffect, useRef, useState } from 'react';
import { Book } from '@/types/book';
import { LibraryCoverFitType, LibraryViewModeType } from '@/types/settings';
import { formatAuthors, formatTitle } from '@/utils/book';
import { eventDispatcher } from '@/utils/event';
import { acquireKavitaCoverUrl, peekKavitaCoverUrl } from '@/services/kavita/cover';

interface BookCoverProps {
  book: Book;
  mode?: LibraryViewModeType;
  coverFit?: LibraryCoverFitType;
  className?: string;
  imageClassName?: string;
  showSpine?: boolean;
  isPreview?: boolean;
  onImageError?: () => void;
  onAspectRatioChange?: (ratio: number) => void;
}

const BookCover: React.FC<BookCoverProps> = memo<BookCoverProps>(
  ({
    book,
    mode = 'grid',
    coverFit = 'crop',
    showSpine = false,
    className,
    imageClassName,
    isPreview,
    onImageError,
    onAspectRatioChange,
  }) => {
    const coverRef = useRef<HTMLDivElement>(null);
    const [imageLoaded, setImageLoaded] = useState(false);
    const [imageError, setImageError] = useState(false);
    const kavitaCoverKey = book.kavitaSource
      ? [
          book.hash,
          book.kavitaSource.connectionId,
          book.kavitaSource.serverId,
          book.kavitaSource.chapterId,
          book.kavitaSource.fileId,
          book.kavitaSource.fileBytes,
          book.kavitaSource.fileCreated,
        ].join(':')
      : null;
    const [kavitaCoverState, setKavitaCoverState] = useState<{
      key: string | null;
      url: string | null;
    }>(() => ({ key: kavitaCoverKey, url: peekKavitaCoverUrl(book) }));
    const [visibleKavitaCoverKey, setVisibleKavitaCoverKey] = useState<string | null>(null);
    const kavitaCoverUrl =
      kavitaCoverState.key === kavitaCoverKey ? kavitaCoverState.url : peekKavitaCoverUrl(book);

    const shouldShowSpine = showSpine && imageLoaded && !imageError;

    const toggleImageVisibility = (showImage: boolean) => {
      if (coverRef.current) {
        const coverImage = coverRef.current.querySelector('.cover-image');
        const fallbackCover = coverRef.current.querySelector('.fallback-cover');
        if (coverImage) {
          coverImage.classList.toggle('invisible', !showImage);
        }
        if (fallbackCover) {
          fallbackCover.classList.toggle('invisible', showImage);
        }
      }
    };

    const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
      setImageLoaded(true);
      setImageError(false);
      toggleImageVisibility(true);
      const img = e.currentTarget;
      if (onAspectRatioChange && img.naturalWidth > 0 && img.naturalHeight > 0) {
        onAspectRatioChange(img.naturalWidth / img.naturalHeight);
      }
    };

    const handleImageError = () => {
      setImageLoaded(false);
      setImageError(true);
      toggleImageVisibility(false);
      onImageError?.();
    };

    useEffect(() => {
      toggleImageVisibility(true);
    }, [book.metadata?.coverImageUrl, book.coverImageUrl]);

    useEffect(() => {
      setVisibleKavitaCoverKey(null);
      if (!kavitaCoverKey) return;
      const element = coverRef.current;
      if (!element || typeof IntersectionObserver === 'undefined') {
        setVisibleKavitaCoverKey(kavitaCoverKey);
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          setVisibleKavitaCoverKey(kavitaCoverKey);
          observer.disconnect();
        },
        { rootMargin: '200% 0px' },
      );
      observer.observe(element);
      return () => observer.disconnect();
    }, [kavitaCoverKey]);

    useEffect(() => {
      if (!book.kavitaSource || visibleKavitaCoverKey !== kavitaCoverKey) return;
      const cachedUrl = peekKavitaCoverUrl(book);
      setKavitaCoverState({ key: kavitaCoverKey, url: cachedUrl });
      if (cachedUrl) return;
      const lease = acquireKavitaCoverUrl(book);
      if (!lease) return;
      let active = true;
      void lease.url
        .then((url) => {
          if (active) setKavitaCoverState({ key: kavitaCoverKey, url });
        })
        .catch((error) => {
          if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
          setKavitaCoverState({ key: kavitaCoverKey, url: null });
        });
      return () => {
        active = false;
        lease.release();
      };
    }, [
      book.hash,
      book.kavitaSource?.connectionId,
      book.kavitaSource?.serverId,
      book.kavitaSource?.chapterId,
      book.kavitaSource?.fileId,
      book.kavitaSource?.fileBytes,
      book.kavitaSource?.fileCreated,
      kavitaCoverKey,
      visibleKavitaCoverKey,
    ]);

    useEffect(() => {
      if (!kavitaCoverKey) return;
      const updated = (event: CustomEvent) => {
        const detail = event.detail as { key?: string; url?: string };
        if (detail.key === kavitaCoverKey && detail.url) {
          setKavitaCoverState({ key: kavitaCoverKey, url: detail.url });
        }
      };
      eventDispatcher.on('kavita-cover-updated', updated);
      return () => eventDispatcher.off('kavita-cover-updated', updated);
    }, [kavitaCoverKey]);

    const coverUrl = kavitaCoverUrl || book.metadata?.coverImageUrl || book.coverImageUrl || '';

    return (
      <div
        ref={coverRef}
        className={clsx('book-cover-container relative flex h-full w-full', className)}
      >
        {coverFit === 'crop' ? (
          <>
            <Image
              src={coverUrl}
              alt={book.title}
              fill={true}
              loading='lazy'
              draggable={false}
              className={clsx('cover-image crop-cover-img object-cover', imageClassName)}
              onLoad={handleImageLoad}
              onError={handleImageError}
            />
            <div
              className={`book-spine absolute inset-0 ${shouldShowSpine ? 'visible' : 'invisible'}`}
            />
          </>
        ) : (
          <div className={clsx('flex h-full w-full justify-start')}>
            <div
              className={clsx(
                'flex h-full max-h-full items-end',
                mode === 'grid' ? 'items-end' : 'items-center',
              )}
            >
              <Image
                src={coverUrl}
                alt={book.title}
                width={0}
                height={0}
                sizes='100vw'
                loading='lazy'
                draggable={false}
                className={clsx(
                  'cover-image fit-cover-img h-auto max-h-full w-auto max-w-full shadow-md',
                  imageClassName,
                )}
                onLoad={handleImageLoad}
                onError={handleImageError}
              />
              <div
                className={`book-spine absolute inset-0 ${shouldShowSpine ? 'visible' : 'invisible'}`}
              />
            </div>
          </div>
        )}

        <div
          className={clsx(
            'fallback-cover invisible absolute inset-0 p-2',
            'text-neutral-content text-center font-serif font-medium',
            isPreview ? 'bg-base-200/50' : 'bg-base-100',
            imageClassName,
          )}
        >
          <div className='flex h-1/2 items-center justify-center'>
            <span
              className={clsx(
                isPreview ? 'line-clamp-2' : mode === 'grid' ? 'line-clamp-3' : 'line-clamp-2',
                isPreview ? 'text-[0.5em]' : mode === 'grid' ? 'text-lg' : 'text-sm',
              )}
            >
              {formatTitle(book.title)}
            </span>
          </div>
          <div className='h-1/6'></div>
          <div className='flex h-1/3 items-center justify-center'>
            <span
              className={clsx(
                'text-neutral-content/50 line-clamp-1',
                isPreview ? 'text-[0.4em]' : mode === 'grid' ? 'text-base' : 'text-xs',
              )}
            >
              {formatAuthors(book.author || book.metadata?.author || '')}
            </span>
          </div>
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.book.coverImageUrl === nextProps.book.coverImageUrl &&
      prevProps.book.hash === nextProps.book.hash &&
      prevProps.book.kavitaSource?.connectionId === nextProps.book.kavitaSource?.connectionId &&
      prevProps.book.kavitaSource?.serverId === nextProps.book.kavitaSource?.serverId &&
      prevProps.book.kavitaSource?.chapterId === nextProps.book.kavitaSource?.chapterId &&
      prevProps.book.kavitaSource?.fileId === nextProps.book.kavitaSource?.fileId &&
      prevProps.book.kavitaSource?.fileBytes === nextProps.book.kavitaSource?.fileBytes &&
      prevProps.book.kavitaSource?.fileCreated === nextProps.book.kavitaSource?.fileCreated &&
      prevProps.book.metadata?.coverImageUrl === nextProps.book.metadata?.coverImageUrl &&
      prevProps.book.updatedAt === nextProps.book.updatedAt &&
      prevProps.mode === nextProps.mode &&
      prevProps.coverFit === nextProps.coverFit &&
      prevProps.isPreview === nextProps.isPreview &&
      prevProps.showSpine === nextProps.showSpine &&
      prevProps.className === nextProps.className &&
      prevProps.imageClassName === nextProps.imageClassName
    );
  },
);

BookCover.displayName = 'BookCover';

export default BookCover;
