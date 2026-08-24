import { describe, expect, it } from 'vitest';
import { getKavitaBadgeKeys } from '@/app/library/components/BookItem';
import type { Book } from '@/types/book';

const book = {
  kavitaSource: { offlineState: 'remote' },
} as Book;

describe('Kavita shelf badge visibility', () => {
  it.each([
    [true, true, ['Kavita', 'Online']],
    [true, false, ['Kavita']],
    [false, true, ['Online']],
    [false, false, []],
  ])('supports source=%s and status=%s independently', (source, status, expected) => {
    expect(
      getKavitaBadgeKeys(book, {
        libraryShowKavitaSourceBadge: source,
        libraryShowKavitaStatusBadge: status,
      }),
    ).toEqual(expected);
  });

  it('treats missing legacy settings as enabled', () => {
    expect(getKavitaBadgeKeys(book, {} as never)).toEqual(['Kavita', 'Online']);
  });
});
