import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { RedisCacheService } from '../../src/modules/caching/cache.service.js';
import { RedisRateLimiterService } from '../../src/modules/rate-limiting/rate-limiter.service.js';
import { RedisCoalescingService } from '../../src/modules/caching/coalescing.service.js';
import { CachedResponse } from '../../src/modules/caching/cache.types.js';
import { SystemClock } from '../../src/common/clock.js';
import { config } from '../../src/config/index.js';

describe('Live Redis Integration Tests (Redis container on 6379)', () => {
  let redisClient: Redis;
  let cacheService: RedisCacheService;
  let rateLimiter: RedisRateLimiterService;
  let coalescing: RedisCoalescingService;

  beforeAll(async () => {
    redisClient = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    try {
      await redisClient.connect();
    } catch (e) {
      // Redis might not be reachable if running in an environment without docker
      console.warn('Live Redis could not connect, skipping live tests');
    }

    cacheService = new RedisCacheService(redisClient);
    rateLimiter = new RedisRateLimiterService(redisClient, new SystemClock());
    coalescing = new RedisCoalescingService(redisClient);
  });

  afterAll(async () => {
    if (redisClient.status === 'ready') {
      await redisClient.quit().catch(() => {});
    }
  });

  it('should read and write cached entries to real Redis with TTL', async () => {
    if (redisClient.status !== 'ready') return;

    const testKey = 'test:cache:live_redis_entry';
    const sample: CachedResponse = {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: { message: 'hello from live redis' },
      providerId: 'provider_alpha',
      originalCost: 0.001,
      cachedAt: new Date().toISOString(),
      ttlSeconds: 2,
    };

    await cacheService.set(testKey, sample, 2);

    const retrieved = await cacheService.get(testKey);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.body).toEqual({ message: 'hello from live redis' });

    const rawTtl = await redisClient.ttl(testKey);
    expect(rawTtl).toBeGreaterThan(0);
    expect(rawTtl).toBeLessThanOrEqual(2);

    // Clean up
    await redisClient.del(testKey);
  });

  it('should enforce sliding window rate limiting in real Redis via atomic Lua script', async () => {
    if (redisClient.status !== 'ready') return;

    const tenantId = `live_test_tenant_${Date.now()}`;
    const limit = 3;
    const windowMs = 1000;

    // First 3 requests allowed
    const r1 = await rateLimiter.checkLimit(tenantId, limit, windowMs);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await rateLimiter.checkLimit(tenantId, limit, windowMs);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await rateLimiter.checkLimit(tenantId, limit, windowMs);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // 4th request rejected
    const r4 = await rateLimiter.checkLimit(tenantId, limit, windowMs);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    // Clean up
    await redisClient.del(`ratelimit:${tenantId}`);
  });

  it('should coordinate single-flight leadership and Pub/Sub over real Redis', async () => {
    if (redisClient.status !== 'ready') return;

    const cacheKey = `live_coalesce_${Date.now()}`;
    const sample: CachedResponse = {
      statusCode: 200,
      headers: {},
      body: { answer: 42 },
      providerId: 'provider_beta',
      originalCost: 0.003,
      cachedAt: new Date().toISOString(),
      ttlSeconds: 60,
    };

    // 1. Leader acquires lock
    const leaderRes = await coalescing.executeCoalesced(cacheKey, 2000, async () => null);
    expect(leaderRes.isLeader).toBe(true);

    // 2. Waiter starts waiting on pub/sub channel
    const waiterPromise = coalescing.executeCoalesced(cacheKey, 2000, async () => {
      return cacheService.get(cacheKey);
    });

    // 3. Leader caches result, publishes success and releases lock
    await cacheService.set(cacheKey, sample, 60);
    await coalescing.publishSuccess(cacheKey, sample);
    await coalescing.releaseLock(cacheKey);

    // 4. Waiter receives notification over real Redis Pub/Sub
    const waiterRes = await waiterPromise;
    expect(waiterRes.isLeader).toBe(false);
    expect(waiterRes.cachedResponse).toEqual(sample);

    // Clean up
    await redisClient.del(`coalesce:lock:${cacheKey}`);
    await redisClient.del(cacheKey);
  });
});
