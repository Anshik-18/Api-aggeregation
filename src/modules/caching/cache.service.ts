import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import { CachedResponse, ICacheService } from './cache.types.js';
import { RedisClient } from '../../database/redis.js';
import { config } from '../../config/index.js';
import { rootLogger } from '../../common/logger.js';
import { Clock, SystemClock } from '../../common/clock.js';

export class CacheUtils {
  public static canonicalizeBody(body: unknown): string {
    if (body === undefined || body === null) {
      return '';
    }
    if (typeof body !== 'object') {
      return String(body);
    }
    // Deep key-sorting for JSON
    const sortObject = (obj: any): any => {
      if (obj === null || typeof obj !== 'object') {
        return obj;
      }
      if (Array.isArray(obj)) {
        return obj.map(sortObject);
      }
      const sortedKeys = Object.keys(obj).sort();
      const result: Record<string, any> = {};
      for (const key of sortedKeys) {
        result[key] = sortObject(obj[key]);
      }
      return result;
    };

    return JSON.stringify(sortObject(body));
  }

  public static canonicalizeParams(params?: Record<string, string>): string {
    if (!params) return '';
    const sortedKeys = Object.keys(params).sort();
    return sortedKeys.map((k) => `${k}=${params[k]}`).join('&');
  }

  public static buildCacheKey(
    orgId: string,
    endpoint: string,
    method: string,
    params?: Record<string, string>,
    body?: unknown
  ): string {
    const normParams = this.canonicalizeParams(params);
    const normBody = this.canonicalizeBody(body);
    const rawInput = `${method.toUpperCase()}:${endpoint}:${normParams}:${normBody}`;
    const hash = crypto.createHash('sha256').update(rawInput).digest('hex');
    return `cache:resp:${orgId}:${endpoint}:${hash}`;
  }

  public static isCacheEligible(
    method: string,
    headers?: Record<string, unknown>,
    body?: unknown
  ): boolean {
    // Caching is strictly disabled by default.
    // Explicit opt-in via header 'x-cache-eligible: true' or body flag 'cacheEligible: true'.
    const headerOptIn = headers?.['x-cache-eligible'] === 'true' || headers?.['x-cache-eligible'] === true;
    const bodyOptIn = (body as any)?.cacheEligible === true;

    if (!headerOptIn && !bodyOptIn) {
      return false;
    }

    // Only allow deterministic read operations
    const upperMethod = method.toUpperCase();
    if (upperMethod === 'GET') {
      return true;
    }
    // Allow POST only if explicitly opted in (e.g. search/query requests)
    if (upperMethod === 'POST' && (headerOptIn || bodyOptIn)) {
      return true;
    }

    return false;
  }

  public static isCacheBypass(headers?: Record<string, unknown>): boolean {
    if (!headers) return false;

    if (headers['x-cache-bypass'] === 'true' || headers['x-cache-bypass'] === true) {
      return true;
    }

    const cacheControl = headers['cache-control'] as string | undefined;
    if (typeof cacheControl === 'string') {
      const lower = cacheControl.toLowerCase();
      if (lower.includes('no-cache') || lower.includes('no-store')) {
        return true;
      }
    }

    const pragma = headers['pragma'] as string | undefined;
    if (typeof pragma === 'string' && pragma.toLowerCase().includes('no-cache')) {
      return true;
    }

    return false;
  }

  public static getTtlSeconds(
    headers?: Record<string, unknown>,
    defaultTtl = config.CACHE_DEFAULT_TTL_SECONDS
  ): number {
    if (!headers) return defaultTtl;

    const ttlHeader = headers['x-cache-ttl'];
    if (ttlHeader) {
      const parsed = parseInt(String(ttlHeader), 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }

    const cacheControl = headers['cache-control'] as string | undefined;
    if (typeof cacheControl === 'string') {
      const match = cacheControl.match(/max-age=(\d+)/i);
      if (match && match[1]) {
        const parsed = parseInt(match[1], 10);
        if (!isNaN(parsed) && parsed > 0) {
          return parsed;
        }
      }
    }

    return defaultTtl;
  }
}

export class RedisCacheService implements ICacheService {
  constructor(private readonly redisClient: Redis = RedisClient.getInstance()) {}

  public async get(key: string): Promise<CachedResponse | null> {
    try {
      const data = await this.redisClient.get(key);
      if (!data) {
        return null;
      }
      return JSON.parse(data) as CachedResponse;
    } catch (err) {
      rootLogger.warn({ err, key }, 'Redis cache get failed, treating as cache miss');
      return null;
    }
  }

  public async set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await this.redisClient.set(key, serialized, 'EX', ttlSeconds);
    } catch (err) {
      rootLogger.warn({ err, key }, 'Redis cache set failed, continuing without caching');
    }
  }

  public buildCacheKey(
    orgId: string,
    endpoint: string,
    method: string,
    params?: Record<string, string>,
    body?: unknown
  ): string {
    return CacheUtils.buildCacheKey(orgId, endpoint, method, params, body);
  }

  public isCacheEligible(
    method: string,
    headers?: Record<string, unknown>,
    body?: unknown
  ): boolean {
    return CacheUtils.isCacheEligible(method, headers, body);
  }

  public isCacheBypass(headers?: Record<string, unknown>): boolean {
    return CacheUtils.isCacheBypass(headers);
  }

  public getTtlSeconds(headers?: Record<string, unknown>, defaultTtl?: number): number {
    return CacheUtils.getTtlSeconds(headers, defaultTtl);
  }
}

export class InMemoryCacheService implements ICacheService {
  private readonly store = new Map<string, { value: CachedResponse; expiresAt: number }>();

  constructor(private readonly clock: Clock = new SystemClock()) {}

  public async get(key: string): Promise<CachedResponse | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    const now = this.clock.now();
    if (now >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  public async set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void> {
    const expiresAt = this.clock.now() + ttlSeconds * 1000;
    this.store.set(key, { value, expiresAt });
  }

  public buildCacheKey(
    orgId: string,
    endpoint: string,
    method: string,
    params?: Record<string, string>,
    body?: unknown
  ): string {
    return CacheUtils.buildCacheKey(orgId, endpoint, method, params, body);
  }

  public isCacheEligible(
    method: string,
    headers?: Record<string, unknown>,
    body?: unknown
  ): boolean {
    return CacheUtils.isCacheEligible(method, headers, body);
  }

  public isCacheBypass(headers?: Record<string, unknown>): boolean {
    return CacheUtils.isCacheBypass(headers);
  }

  public getTtlSeconds(headers?: Record<string, unknown>, defaultTtl?: number): number {
    return CacheUtils.getTtlSeconds(headers, defaultTtl);
  }

  public clear(): void {
    this.store.clear();
  }
}
