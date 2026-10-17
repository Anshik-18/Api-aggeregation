import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import { CachedResponse } from './cache.types.js';
import { RedisClient } from '../../database/redis.js';
import { rootLogger } from '../../common/logger.js';
import { Clock, SystemClock } from '../../common/clock.js';
import { config } from '../../config/index.js';

export interface CoalesceResult {
  isLeader: boolean;
  cachedResponse?: CachedResponse;
}

export interface ICoalescingService {
  executeCoalesced(
    cacheKey: string,
    timeoutMs: number,
    checkCache: () => Promise<CachedResponse | null>
  ): Promise<CoalesceResult>;

  publishSuccess(cacheKey: string, response: CachedResponse): Promise<void>;
  publishFailure(cacheKey: string): Promise<void>;
  releaseLock(cacheKey: string): Promise<void>;
}

export class RedisCoalescingService implements ICoalescingService {
  private readonly pubClient: Redis;
  private subClient: Redis | null = null;
  private readonly eventEmitter = new EventEmitter();
  private readonly lockOwnerMap = new Map<string, string>(); // cacheKey -> workerLockId
  private isSubClientInitialized = false;

  constructor(pubClient: Redis = RedisClient.getInstance()) {
    this.pubClient = pubClient;
    this.eventEmitter.setMaxListeners(200);
  }

  private async ensureSubClient(): Promise<Redis | null> {
    if (this.subClient && this.isSubClientInitialized) {
      return this.subClient;
    }

    try {
      this.subClient = this.pubClient.duplicate();
      await this.subClient.connect().catch(() => {});

      this.subClient.on('message', (channel, message) => {
        this.eventEmitter.emit(channel, message);
      });

      this.subClient.on('error', (err) => {
        rootLogger.warn({ err }, 'Redis coalescing subscriber error');
      });

      this.isSubClientInitialized = true;
      return this.subClient;
    } catch (err) {
      rootLogger.warn({ err }, 'Failed to initialize Redis coalescing subscriber, degrading');
      return null;
    }
  }

  public async executeCoalesced(
    cacheKey: string,
    timeoutMs = config.CACHE_COALESCING_TIMEOUT_MS,
    checkCache: () => Promise<CachedResponse | null>
  ): Promise<CoalesceResult> {
    const lockKey = `coalesce:lock:${cacheKey}`;
    const channelKey = `coalesce:chan:${cacheKey}`;
    const workerLockId = crypto.randomUUID();

    try {
      // 1. Attempt to acquire leader distributed lock with TTL
      // 'NX' ensures only one concurrent request acquires it
      // 'PX' sets lease expiry to prevent indefinite deadlocks if leader process crashes
      const acquired = await this.pubClient.set(lockKey, workerLockId, 'PX', timeoutMs + 1000, 'NX');

      if (acquired === 'OK') {
        // This request is the LEADER
        this.lockOwnerMap.set(cacheKey, workerLockId);
        return { isLeader: true };
      }
    } catch (err) {
      // Redis error during lock acquisition: fail-safe degrade to leader (execute upstream directly)
      rootLogger.warn({ err, cacheKey }, 'Failed to acquire coalescing lock in Redis, degrading to leader');
      return { isLeader: true };
    }

    // 2. This request is a WAITER: subscribe and wait for leader
    const sub = await this.ensureSubClient();
    if (!sub) {
      // Degradation: if subscriber cannot connect, check cache or fall through
      const existing = await checkCache();
      return { isLeader: false, cachedResponse: existing ?? undefined };
    }

    try {
      await sub.subscribe(channelKey);
    } catch (err) {
      rootLogger.warn({ err, channelKey }, 'Failed to subscribe to coalescing channel');
      const existing = await checkCache();
      return { isLeader: false, cachedResponse: existing ?? undefined };
    }

    return new Promise<CoalesceResult>((resolve) => {
      let resolved = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = async () => {
        if (timer) clearTimeout(timer);
        this.eventEmitter.off(channelKey, onMessage);
        try {
          await sub.unsubscribe(channelKey);
        } catch {
          // ignore unsubscribe failure on cleanup
        }
      };

      const finish = (result: CoalesceResult) => {
        if (resolved) return;
        resolved = true;
        cleanup().catch(() => {});
        resolve(result);
      };

      const onMessage = (messageStr: string) => {
        try {
          const parsed = JSON.parse(messageStr);
          if (parsed.status === 'SUCCESS' && parsed.data) {
            finish({ isLeader: false, cachedResponse: parsed.data });
            return;
          }
        } catch {
          // ignore malformed message
        }
        // If leader reported failure, check cache or fall through
        checkCache().then((cached) => {
          finish({ isLeader: false, cachedResponse: cached ?? undefined });
        }).catch(() => {
          finish({ isLeader: false, cachedResponse: undefined });
        });
      };

      // Set timeout for waiter
      timer = setTimeout(async () => {
        rootLogger.debug({ cacheKey }, 'Waiter timed out waiting for coalescing leader. Checking cache.');
        try {
          const cached = await checkCache();
          finish({ isLeader: false, cachedResponse: cached ?? undefined });
        } catch {
          finish({ isLeader: false, cachedResponse: undefined });
        }
      }, timeoutMs);

      // Listen on channel
      this.eventEmitter.once(channelKey, onMessage);
    });
  }

  public async publishSuccess(cacheKey: string, response: CachedResponse): Promise<void> {
    const channelKey = `coalesce:chan:${cacheKey}`;
    try {
      const payload = JSON.stringify({ status: 'SUCCESS', data: response });
      await this.pubClient.publish(channelKey, payload);
    } catch (err) {
      rootLogger.warn({ err, cacheKey }, 'Failed to publish coalescing success to Redis channel');
    }
  }

  public async publishFailure(cacheKey: string): Promise<void> {
    const channelKey = `coalesce:chan:${cacheKey}`;
    try {
      const payload = JSON.stringify({ status: 'FAILED' });
      await this.pubClient.publish(channelKey, payload);
    } catch (err) {
      rootLogger.warn({ err, cacheKey }, 'Failed to publish coalescing failure to Redis channel');
    }
  }

  public async releaseLock(cacheKey: string): Promise<void> {
    const lockKey = `coalesce:lock:${cacheKey}`;
    const workerLockId = this.lockOwnerMap.get(cacheKey);
    this.lockOwnerMap.delete(cacheKey);

    if (!workerLockId) return;

    // Safe lock release with Lua script to ensure only owner deletes it
    const releaseScript = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
    `;

    try {
      await this.pubClient.eval(releaseScript, 1, lockKey, workerLockId);
    } catch (err) {
      rootLogger.warn({ err, lockKey }, 'Failed to safely release coalescing lock in Redis');
    }
  }
}

export class InMemoryCoalescingService implements ICoalescingService {
  private readonly locks = new Map<string, { workerId: string; expiresAt: number }>();
  private readonly eventEmitter = new EventEmitter();

  constructor(private readonly clock: Clock = new SystemClock()) {
    this.eventEmitter.setMaxListeners(200);
  }

  public async executeCoalesced(
    cacheKey: string,
    timeoutMs = config.CACHE_COALESCING_TIMEOUT_MS,
    checkCache: () => Promise<CachedResponse | null>
  ): Promise<CoalesceResult> {
    const now = this.clock.now();
    const existingLock = this.locks.get(cacheKey);

    if (!existingLock || now >= existingLock.expiresAt) {
      // Acquire leader lock
      const workerId = crypto.randomUUID();
      this.locks.set(cacheKey, { workerId, expiresAt: now + timeoutMs + 1000 });
      return { isLeader: true };
    }

    // Waiter: wait for event or timeout
    const channelKey = `coalesce:${cacheKey}`;
    return new Promise<CoalesceResult>((resolve) => {
      let resolved = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (result: CoalesceResult) => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        this.eventEmitter.off(channelKey, onMessage);
        resolve(result);
      };

      const onMessage = (msg: { status: string; data?: CachedResponse }) => {
        if (msg.status === 'SUCCESS' && msg.data) {
          finish({ isLeader: false, cachedResponse: msg.data });
        } else {
          checkCache().then((cached) => {
            finish({ isLeader: false, cachedResponse: cached ?? undefined });
          });
        }
      };

      timer = setTimeout(async () => {
        const cached = await checkCache();
        finish({ isLeader: false, cachedResponse: cached ?? undefined });
      }, timeoutMs);

      this.eventEmitter.once(channelKey, onMessage);
    });
  }

  public async publishSuccess(cacheKey: string, response: CachedResponse): Promise<void> {
    const channelKey = `coalesce:${cacheKey}`;
    this.eventEmitter.emit(channelKey, { status: 'SUCCESS', data: response });
  }

  public async publishFailure(cacheKey: string): Promise<void> {
    const channelKey = `coalesce:${cacheKey}`;
    this.eventEmitter.emit(channelKey, { status: 'FAILED' });
  }

  public async releaseLock(cacheKey: string): Promise<void> {
    this.locks.delete(cacheKey);
  }
}
