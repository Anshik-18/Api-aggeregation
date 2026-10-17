import pg from 'pg';
import { config } from '../config/index.js';
import { rootLogger } from '../common/logger.js';

const { Pool } = pg;

export class Database {
  private static pool: pg.Pool | null = null;

  public static getPool(): pg.Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: config.DATABASE_URL,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      this.pool.on('error', (err) => {
        rootLogger.error({ err }, 'Unexpected PostgreSQL pool error');
      });
    }
    return this.pool;
  }

  public static async checkHealth(): Promise<{ isHealthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const pool = this.getPool();
      await pool.query('SELECT 1');
      return {
        isHealthy: true,
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
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      rootLogger.info('PostgreSQL connection pool closed');
    }
  }
}
