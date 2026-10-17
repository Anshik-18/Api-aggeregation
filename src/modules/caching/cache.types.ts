export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  providerId: string;
  originalCost: number;
  cachedAt: string;
  ttlSeconds: number;
}

export interface ICacheService {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void>;
  buildCacheKey(
    orgId: string,
    endpoint: string,
    method: string,
    params?: Record<string, string>,
    body?: unknown
  ): string;
  isCacheEligible(
    method: string,
    headers?: Record<string, unknown>,
    body?: unknown
  ): boolean;
  isCacheBypass(headers?: Record<string, unknown>): boolean;
  getTtlSeconds(headers?: Record<string, unknown>, defaultTtl?: number): number;
}
