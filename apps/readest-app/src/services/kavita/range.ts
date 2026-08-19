import { KavitaError } from './errors';

export interface ParsedContentRange {
  start: number;
  end: number;
  total: number;
}

export function parseContentRange(value: string | null): ParsedContentRange | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

export function validateKavitaRangeResponse(
  response: Response,
  expectedStart: number,
  expectedEnd: number,
  expectedTotal?: number,
): ParsedContentRange {
  if (response.status === 200) {
    throw new KavitaError(
      'range-unsupported',
      'The server or reverse proxy ignored Range and returned HTTP 200; download offline to open this book',
      200,
    );
  }
  if (response.status !== 206) {
    throw new KavitaError(
      'range-unsupported',
      `Expected HTTP 206 for EPUB Range request, received ${response.status}`,
      response.status,
    );
  }
  const parsed = parseContentRange(response.headers.get('content-range'));
  if (!parsed || parsed.start !== expectedStart || parsed.end !== expectedEnd) {
    throw new KavitaError(
      'range-unsupported',
      `Invalid Content-Range header: ${response.headers.get('content-range') ?? '(missing)'}`,
      response.status,
    );
  }
  if (expectedTotal !== undefined && parsed.total !== expectedTotal) {
    throw new KavitaError(
      'invalid-response',
      `Kavita file size changed (expected ${expectedTotal}, received ${parsed.total})`,
      response.status,
    );
  }
  return parsed;
}
