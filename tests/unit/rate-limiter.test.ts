import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryRateLimiterService,
  RedisRateLimiterService,
} from '../../src/modules/rate-limiting/rate-limiter.service.js';
import { TestClock } from '../../src/common/clock.js';
import { config } from '../../config/index.js';

describe('RateLimiterService (Unit)', () => {
  let clock: TestClock;
  let limiter: InMemoryRateLimiterService;

  beforeEach(() => {
    clock = new TestClock(1000000);
    limiter = new InMemoryRateLimiterService(clock);
  });

  it('should allow requests within the rate limit', async () => {
    const id = 'org_alpha:key_1';
    const limit = 3;
    const windowMs = 1000;

    const r1 = await limiter.checkLimit(id, limit, windowMs);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await limiter.checkLimit(id, limit, windowMs);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await limiter.checkLimit(id, limit, windowMs);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it('should reject requests exceeding the limit and return retryAfterSeconds', async () => {
    const id = 'org_alpha:key_1';
    const limit = 2;
    const windowMs = 1000;

    await limiter.checkLimit(id, limit, windowMs);
    await limiter.checkLimit(id, limit, windowMs);

    const r3 = await limiter.checkLimit(id, limit, windowMs);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
    expect(r3.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('should reset capacity once the rolling window has advanced', async () => {
    const id = 'org_alpha:key_1';
    const limit = 2;
    const windowMs = 1000;

    await limiter.checkLimit(id, limit, windowMs);
    await limiter.checkLimit(id, limit, windowMs);

    const rejected = await limiter.checkLimit(id, limit, windowMs);
    expect(rejected.allowed).toBe(false);

    // Advance clock past the 1s window
    clock.advance(1001);

    const allowedAgain = await limiter.checkLimit(id, limit, windowMs);
    expect(allowedAgain.allowed).toBe(true);
    expect(allowedAgain.remaining).toBe(1);
  });

  it('should isolate limits between different tenants/keys', async () => {
    const limit = 1;
    const windowMs = 1000;

    const r1 = await limiter.checkLimit('org_1:key_1', limit, windowMs);
    expect(r1.allowed).toBe(true);

    const r2 = await limiter.checkLimit('org_1:key_1', limit, windowMs);
    expect(r2.allowed).toBe(false);

    // org_2 should have separate capacity
    const r3 = await limiter.checkLimit('org_2:key_2', limit, windowMs);
    expect(r3.allowed).toBe(true);
  });

  describe('RedisRateLimiterService Fallback', () => {
    it('should fall back to in-memory limiter when Redis fails under FAIL_OPEN_LOCAL_FALLBACK', async () => {
      const mockRedis = {
        eval: async () => {
          throw new Error('Redis connection down');
        },
      } as any;

      const fallback = new InMemoryRateLimiterService(clock);
      const redisLimiter = new RedisRateLimiterService(mockRedis, clock, fallback);

      // Should succeed using local fallback limiter
      const r1 = await redisLimiter.checkLimit('org_failover:key', 2, 1000);
      expect(r1.allowed).toBe(true);

      const r2 = await redisLimiter.checkLimit('org_failover:key', 2, 1000);
      expect(r2.allowed).toBe(true);

      const r3 = await redisLimiter.checkLimit('org_failover:key', 2, 1000);
      expect(r3.allowed).toBe(false);
    });
  });
});
