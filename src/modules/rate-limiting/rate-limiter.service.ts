import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import { IRateLimiterService, RateLimitResult } from './rate-limiter.types.js';
import { RedisClient } from '../../database/redis.js';
import { rootLogger } from '../../common/logger.js';
import { Clock, SystemClock } from '../../common/clock.js';
import { config } from '../../config/index.js';

export class InMemoryRateLimiterService implements IRateLimiterService {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly clock: Clock = new SystemClock()) {}

  public async checkLimit(
    identifier: string,
    limit: number,
    windowMs: number
  ): Promise<RateLimitResult> {
    const now = this.clock.now();
    const clearBefore = now - windowMs;

    let timestamps = this.windows.get(identifier) ?? [];
    // Evict timestamps outside rolling window
    timestamps = timestamps.filter((t) => t > clearBefore);

    const resetSeconds = Math.max(1, Math.ceil(windowMs / 1000));

    if (timestamps.length < limit) {
      timestamps.push(now);
      this.windows.set(identifier, timestamps);
      return {
        allowed: true,
        limit,
        remaining: limit - timestamps.length,
        resetSeconds,
        retryAfterSeconds: 0,
      };
    }

    // Limit exceeded: calculate retry-after based on oldest entry in window
    const oldest = timestamps[0] ?? now;
    const retryAfterMs = Math.max(1, oldest + windowMs - now);
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

    return {
      allowed: false,
      limit,
      remaining: 0,
      resetSeconds,
      retryAfterSeconds,
    };
  }

  public reset(identifier?: string): void {
    if (identifier) {
      this.windows.delete(identifier);
    } else {
      this.windows.clear();
    }
  }
}

export class RedisRateLimiterService implements IRateLimiterService {
  private readonly fallbackLimiter: InMemoryRateLimiterService;

  // Atomic Lua script for sliding window counter
  private static readonly SLIDING_WINDOW_LUA = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local windowMs = tonumber(ARGV[2])
    local maxRequests = tonumber(ARGV[3])
    local requestId = ARGV[4]

    local clearBefore = now - windowMs
    redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
    local currentCount = redis.call('ZCARD', key)

    if currentCount < maxRequests then
      redis.call('ZADD', key, now, requestId)
      redis.call('PEXPIRE', key, windowMs * 2)
      local remaining = maxRequests - (currentCount + 1)
      local resetSec = math.max(1, math.ceil(windowMs / 1000))
      return { 1, maxRequests, remaining, resetSec, 0 }
    else
      local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
      local resetMs = windowMs
      if #oldest >= 2 then
        resetMs = math.max(1, (tonumber(oldest[2]) + windowMs) - now)
      end
      local retryAfterSec = math.max(1, math.ceil(resetMs / 1000))
      local resetSec = math.max(1, math.ceil(resetMs / 1000))
      return { 0, maxRequests, 0, resetSec, retryAfterSec }
    end
  `;

  constructor(
    private readonly redisClient: Redis = RedisClient.getInstance(),
    private readonly clock: Clock = new SystemClock(),
    fallbackLimiter?: InMemoryRateLimiterService
  ) {
    this.fallbackLimiter = fallbackLimiter ?? new InMemoryRateLimiterService(clock);
  }

  public async checkLimit(
    identifier: string,
    limit: number,
    windowMs: number
  ): Promise<RateLimitResult> {
    const key = `ratelimit:${identifier}`;
    const now = this.clock.now();
    const requestId = crypto.randomUUID();

    try {
      const res = (await this.redisClient.eval(
        RedisRateLimiterService.SLIDING_WINDOW_LUA,
        1,
        key,
        now,
        windowMs,
        limit,
        requestId
      )) as [number, number, number, number, number];

      const [allowedNum, maxReqs, remaining, resetSec, retryAfterSec] = res;

      return {
        allowed: allowedNum === 1,
        limit: maxReqs,
        remaining,
        resetSeconds: resetSec,
        retryAfterSeconds: retryAfterSec,
      };
    } catch (err) {
      rootLogger.warn(
        { err, identifier, fallbackPolicy: config.RATE_LIMIT_FALLBACK_POLICY },
        'Redis rate limiter failed, invoking fallback policy'
      );

      if (config.RATE_LIMIT_FALLBACK_POLICY === 'FAIL_CLOSED') {
        // Reject request when Redis is unavailable under FAIL_CLOSED policy
        return {
          allowed: false,
          limit,
          remaining: 0,
          resetSeconds: Math.ceil(windowMs / 1000),
          retryAfterSeconds: 5,
        };
      }

      // FAIL_OPEN_LOCAL_FALLBACK: use in-memory sliding window limiter
      return this.fallbackLimiter.checkLimit(identifier, limit, windowMs);
    }
  }
}
