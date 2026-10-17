import { describe, it, expect, beforeEach } from 'vitest';
import {
  CacheUtils,
  InMemoryCacheService,
  RedisCacheService,
} from '../../src/modules/caching/cache.service.js';
import { TestClock } from '../../src/common/clock.js';
import { CachedResponse } from '../../src/modules/caching/cache.types.js';

describe('CacheUtils and InMemoryCacheService (Unit)', () => {
  let clock: TestClock;
  let cacheService: InMemoryCacheService;

  beforeEach(() => {
    clock = new TestClock(1000000);
    cacheService = new InMemoryCacheService(clock);
  });

  describe('Cache Key Generation & Canonicalization', () => {
    it('should generate deterministic cache keys regardless of query parameter order', () => {
      const key1 = CacheUtils.buildCacheKey(
        'org_1',
        '/v1/data',
        'GET',
        { b: '2', a: '1', c: '3' },
        undefined
      );
      const key2 = CacheUtils.buildCacheKey(
        'org_1',
        '/v1/data',
        'GET',
        { a: '1', c: '3', b: '2' },
        undefined
      );

      expect(key1).toBe(key2);
      expect(key1).toContain('cache:resp:org_1:/v1/data:');
    });

    it('should generate deterministic cache keys regardless of JSON body key order', () => {
      const body1 = { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }], temperature: 0.7 };
      const body2 = { temperature: 0.7, messages: [{ role: 'user', content: 'hello' }], model: 'gpt-4' };

      const key1 = CacheUtils.buildCacheKey('org_1', '/v1/chat', 'POST', undefined, body1);
      const key2 = CacheUtils.buildCacheKey('org_1', '/v1/chat', 'POST', undefined, body2);

      expect(key1).toBe(key2);
    });

    it('should isolate cache keys by organization / tenant scope', () => {
      const keyOrg1 = CacheUtils.buildCacheKey('org_1', '/v1/data', 'GET', { id: '10' });
      const keyOrg2 = CacheUtils.buildCacheKey('org_2', '/v1/data', 'GET', { id: '10' });

      expect(keyOrg1).not.toBe(keyOrg2);
      expect(keyOrg1).toContain(':org_1:');
      expect(keyOrg2).toContain(':org_2:');
    });
  });

  describe('Cache Eligibility & Opt-In', () => {
    it('should be disabled by default for GET without opt-in', () => {
      expect(CacheUtils.isCacheEligible('GET', {})).toBe(false);
      expect(CacheUtils.isCacheEligible('POST', {})).toBe(false);
    });

    it('should opt in when x-cache-eligible header is present', () => {
      expect(CacheUtils.isCacheEligible('GET', { 'x-cache-eligible': 'true' })).toBe(true);
      expect(CacheUtils.isCacheEligible('POST', { 'x-cache-eligible': 'true' })).toBe(true);
    });

    it('should opt in when body contains cacheEligible: true', () => {
      expect(CacheUtils.isCacheEligible('POST', {}, { cacheEligible: true, prompt: 'test' })).toBe(true);
    });

    it('should reject state-changing methods even with opt-in', () => {
      expect(CacheUtils.isCacheEligible('DELETE', { 'x-cache-eligible': 'true' })).toBe(false);
      expect(CacheUtils.isCacheEligible('PUT', { 'x-cache-eligible': 'true' })).toBe(false);
    });
  });

  describe('Cache Bypass', () => {
    it('should detect cache bypass via x-cache-bypass header', () => {
      expect(CacheUtils.isCacheBypass({ 'x-cache-bypass': 'true' })).toBe(true);
      expect(CacheUtils.isCacheBypass({ 'x-cache-bypass': 'false' })).toBe(false);
    });

    it('should detect cache bypass via Cache-Control no-cache or no-store', () => {
      expect(CacheUtils.isCacheBypass({ 'cache-control': 'no-cache' })).toBe(true);
      expect(CacheUtils.isCacheBypass({ 'cache-control': 'no-store' })).toBe(true);
      expect(CacheUtils.isCacheBypass({ 'cache-control': 'max-age=3600' })).toBe(false);
    });

    it('should detect cache bypass via Pragma no-cache', () => {
      expect(CacheUtils.isCacheBypass({ pragma: 'no-cache' })).toBe(true);
    });
  });

  describe('TTL Configuration', () => {
    it('should use default TTL when no headers are supplied', () => {
      expect(CacheUtils.getTtlSeconds(undefined, 60)).toBe(60);
    });

    it('should parse x-cache-ttl header', () => {
      expect(CacheUtils.getTtlSeconds({ 'x-cache-ttl': '120' }, 60)).toBe(120);
    });

    it('should parse Cache-Control max-age directive', () => {
      expect(CacheUtils.getTtlSeconds({ 'cache-control': 'public, max-age=300' }, 60)).toBe(300);
    });
  });

  describe('Cache Storage & Expiration', () => {
    it('should set and get cached items before TTL expires', async () => {
      const sampleItem: CachedResponse = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: { result: 'cached_data' },
        providerId: 'provider_alpha',
        originalCost: 0.001,
        cachedAt: new Date(clock.now()).toISOString(),
        ttlSeconds: 60,
      };

      await cacheService.set('test_key', sampleItem, 60);

      const retrieved = await cacheService.get('test_key');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.body).toEqual({ result: 'cached_data' });
      expect(retrieved?.originalCost).toBe(0.001);
    });

    it('should return null after TTL expires', async () => {
      const sampleItem: CachedResponse = {
        statusCode: 200,
        headers: {},
        body: { result: 'expires_soon' },
        providerId: 'provider_alpha',
        originalCost: 0.001,
        cachedAt: new Date(clock.now()).toISOString(),
        ttlSeconds: 10,
      };

      await cacheService.set('expire_key', sampleItem, 10);

      // Advance clock past TTL (10s = 10,000ms)
      clock.advance(10001);

      const retrieved = await cacheService.get('expire_key');
      expect(retrieved).toBeNull();
    });
  });

  describe('RedisCacheService Graceful Degradation', () => {
    it('should handle Redis errors gracefully and return null without throwing', async () => {
      const mockRedis = {
        get: async () => {
          throw new Error('Connection refused');
        },
        set: async () => {
          throw new Error('Connection refused');
        },
      } as any;

      const redisCache = new RedisCacheService(mockRedis);

      const result = await redisCache.get('any_key');
      expect(result).toBeNull();

      // Setting shouldn't throw either
      await expect(
        redisCache.set(
          'any_key',
          {
            statusCode: 200,
            headers: {},
            body: {},
            providerId: 'alpha',
            originalCost: 0.001,
            cachedAt: new Date().toISOString(),
            ttlSeconds: 60,
          },
          60
        )
      ).resolves.toBeUndefined();
    });
  });
});
