import { KAVITA_API_KEY_HEADER, KAVITA_COVER_QUERY_PLACEHOLDER } from './constants';
import { KavitaError, classifyKavitaHttpError, classifyKavitaNetworkError } from './errors';
import { validateKavitaRangeResponse } from './range';
import { normalizeKavitaBaseUrl } from './security';
import type { KavitaTransport } from './transport';
import { createKavitaTransport } from './transport';
import type {
  KavitaKoreaderProgress,
  KavitaLibraryDto,
  KavitaPagination,
  KavitaPluginAuthenticationDto,
  KavitaSeriesDto,
  KavitaSeriesPage,
  KavitaVolumeDto,
} from './types';

interface RequestOptions extends RequestInit {
  context?: string;
  retries?: number;
}

export class KavitaClient {
  readonly baseUrl: string;
  private readonly transport: KavitaTransport;

  constructor(
    baseUrl: string,
    private readonly authKey: string,
    transport: KavitaTransport = createKavitaTransport(),
  ) {
    this.baseUrl = normalizeKavitaBaseUrl(baseUrl);
    this.transport = transport;
  }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const { context = 'Kavita request', retries = 0, ...init } = options;
    const headers = new Headers(init.headers);
    headers.set(KAVITA_API_KEY_HEADER, this.authKey);
    headers.set('Accept', 'application/json');
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const url = path.startsWith('http') ? path : this.url(path);
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.transport(url, { ...init, headers });
        if (
          attempt < retries &&
          (init.method ?? 'GET') === 'GET' &&
          [408, 429, 500, 502, 503, 504].includes(response.status)
        ) {
          continue;
        }
        if (!response.ok) throw classifyKavitaHttpError(response.status, context);
        return response;
      } catch (error) {
        lastError = classifyKavitaNetworkError(error, url);
        if (attempt >= retries || init.signal?.aborted || (init.method ?? 'GET') !== 'GET') {
          throw lastError;
        }
      }
    }
    throw lastError;
  }

  private async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, options);
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new KavitaError('invalid-response', 'Kavita returned invalid JSON', response.status, {
        cause: error,
      });
    }
  }

  authenticatePlugin(signal?: AbortSignal): Promise<KavitaPluginAuthenticationDto> {
    return this.json(
      this.url('/api/Plugin/authenticate', {
        apiKey: this.authKey,
        pluginName: 'Readest',
      }),
      {
        method: 'POST',
        context: 'Kavita Auth Key authentication',
        signal,
      },
    );
  }

  getLibraries(signal?: AbortSignal): Promise<KavitaLibraryDto[]> {
    return this.json('/api/Library/libraries', {
      context: 'Kavita libraries',
      retries: 2,
      signal,
    });
  }

  async getSeriesPage(
    libraryId: number,
    pageNumber: number,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<KavitaSeriesPage> {
    const url = this.url('/api/Series/all-v2', { PageNumber: pageNumber, PageSize: pageSize });
    const response = await this.request(url, {
      method: 'POST',
      context: 'Kavita series page',
      signal,
      body: JSON.stringify({
        statements: [{ comparison: 0, field: 19, value: String(libraryId) }],
        combination: 1,
        sortOptions: { sortField: 1, isAscending: true },
        entityType: 0,
        limitTo: 0,
      }),
    });
    const items = (await response.json()) as KavitaSeriesDto[];
    const rawPagination = response.headers.get('Pagination');
    if (!rawPagination) {
      throw new KavitaError(
        'invalid-response',
        'Kavita did not expose the Pagination response header; check reverse-proxy CORS headers',
      );
    }
    let pagination: KavitaPagination;
    try {
      pagination = JSON.parse(rawPagination) as KavitaPagination;
    } catch (error) {
      throw new KavitaError(
        'invalid-response',
        'Kavita returned an invalid Pagination header',
        200,
        {
          cause: error,
        },
      );
    }
    return { items, pagination };
  }

  getVolumes(seriesId: number, signal?: AbortSignal): Promise<KavitaVolumeDto[]> {
    return this.json(this.url('/api/Series/volumes', { seriesId }), {
      context: 'Kavita series volumes',
      retries: 2,
      signal,
    });
  }

  getChapterSize(chapterId: number, signal?: AbortSignal): Promise<number> {
    return this.json(this.url('/api/Download/chapter-size', { chapterId }), {
      context: 'Kavita chapter size',
      retries: 2,
      signal,
    });
  }

  getChapterDownloadUrl(chapterId: number): string {
    return this.url('/api/Download/chapter', { chapterId });
  }

  getChapterCoverRequest(chapterId: number): { url: string; headers: Headers } {
    return {
      url: this.url('/api/Image/chapter-cover', {
        chapterId,
        apiKey: KAVITA_COVER_QUERY_PLACEHOLDER,
      }),
      headers: new Headers({ [KAVITA_API_KEY_HEADER]: this.authKey }),
    };
  }

  async probeChapterRange(
    chapterId: number,
    totalBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const end = Math.min(1023, totalBytes - 1);
    const response = await this.transport(this.getChapterDownloadUrl(chapterId), {
      headers: {
        [KAVITA_API_KEY_HEADER]: this.authKey,
        Range: `bytes=0-${end}`,
      },
      signal,
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw classifyKavitaHttpError(response.status, 'Kavita EPUB download');
    }
    validateKavitaRangeResponse(response, 0, end, totalBytes);
    const body = await response.arrayBuffer();
    if (body.byteLength !== end + 1) {
      throw new KavitaError(
        'range-unsupported',
        `Kavita Range body length was ${body.byteLength}, expected ${end + 1}`,
      );
    }
  }

  async getProgress(
    koreaderHash: string,
    signal?: AbortSignal,
  ): Promise<KavitaKoreaderProgress | null> {
    const path = `/api/Koreader/${encodeURIComponent(this.authKey)}/syncs/progress/${encodeURIComponent(koreaderHash)}`;
    try {
      return await this.json(path, { context: 'Kavita reading progress', retries: 2, signal });
    } catch (error) {
      if (error instanceof KavitaError && (error.status === 400 || error.status === 404))
        return null;
      throw error;
    }
  }

  putProgress(
    progress: KavitaKoreaderProgress,
    signal?: AbortSignal,
  ): Promise<{ document: string; timestamp: string }> {
    const path = `/api/Koreader/${encodeURIComponent(this.authKey)}/syncs/progress`;
    return this.json(path, {
      method: 'PUT',
      context: 'Kavita reading progress',
      signal,
      body: JSON.stringify(progress),
    });
  }

  createAuthenticatedTransport(): KavitaTransport {
    return async (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set(KAVITA_API_KEY_HEADER, this.authKey);
      return this.transport(url, { ...init, headers });
    };
  }
}
