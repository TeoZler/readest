import { describe, expect, it } from 'vitest';
import { DocumentLoader } from '@/libs/document';
import { RemoteFile } from '@/utils/file';

const EPUB_URL = new URL('../../fixtures/data/sample-alice.epub', import.meta.url).href;

describe('Kavita lazy EPUB path', () => {
  it('opens metadata, navigation, and the first chapter through foliate-js without a full response', async () => {
    const source = new Uint8Array(await (await fetch(EPUB_URL)).arrayBuffer());
    const ranges: Array<{ start: number; end: number }> = [];
    const transport = async (_url: string, init?: RequestInit): Promise<Response> => {
      const raw = new Headers(init?.headers).get('Range');
      const match = raw?.match(/^bytes=(\d+)-(\d+)$/);
      if (!match) return new Response(source.slice().buffer, { status: 200 });
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), source.byteLength - 1);
      ranges.push({ start, end });
      return new Response(source.slice(start, end + 1).buffer, {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${source.byteLength}` },
      });
    };
    const remote = await new RemoteFile(
      'https://kavita.test/api/Download/chapter?chapterId=338',
      'alice.epub',
      'application/epub+zip',
      Date.now(),
      {
        fetch: transport,
        knownSize: source.byteLength,
        strictRange: true,
        alignChunks: true,
        chunkSize: 128 * 1024,
      },
    ).open();

    const { book, format } = await new DocumentLoader(remote).open();
    let firstText = '';
    for (const section of book.sections) {
      if (section.linear === 'no') continue;
      const document = await section.createDocument();
      firstText = document.body.textContent?.trim() ?? '';
      if (firstText) break;
    }

    expect(format).toBe('EPUB');
    expect(book.metadata.title).toBeTruthy();
    expect(book.toc?.length).toBeGreaterThan(0);
    expect(firstText.length).toBeGreaterThan(0);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every(({ start, end }) => start !== 0 || end !== source.byteLength - 1)).toBe(
      true,
    );
    const uniqueBytes = new Set<number>();
    for (const { start, end } of ranges) {
      for (let offset = start; offset <= end; offset += 1) uniqueBytes.add(offset);
    }
    expect(uniqueBytes.size).toBeLessThan(source.byteLength);
    await remote.close();
  });
});
