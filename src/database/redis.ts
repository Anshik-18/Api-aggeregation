import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { rootLogger } from '../common/logger.js';

export class RedisClient {
  private static instance: Redis | null = null;

  public static getInstance(): Redis {
    if (!this.instance) {
      this.instance = new Redis(config.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        retryStrategy: (times) => {
          if (times > 3) {
            return null; // Stop retrying after 3 attempts
          }
          return Math.min(times * 100, 1000);
        },
      });

      this.instance.on('error', (err) => {
        rootLogger.warn({ err }, 'Redis connection error (degraded cache mode)');
      });
    }
    return this.instance;
  }

  public static async checkHealth(): Promise<{ isHealthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const client = this.getInstance();
      if (client.status !== 'ready') {
        await client.connect().catch(() => {});
      }
      const pingRes = await client.ping();
      return {
        isHealthy: pingRes === 'PONG',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        isHealthy: false,
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  public static async close(): Promise<void> {
    if (this.instance) {
      await this.instance.quit().catch(() => this.instance?.disconnect());
      this.instance = null;
      rootLogger.info('Redis client closed');
    }
  }
}
