import pg from 'pg';
import { ApiKeyRecord } from './api-key.entity.js';
import { Database } from '../../database/index.js';

export interface IApiKeyRepository {
  findByKeyHash(keyHash: string): Promise<ApiKeyRecord | null>;
  createKey(record: Omit<ApiKeyRecord, 'createdAt' | 'lastUsedAt'>): Promise<ApiKeyRecord>;
  touchLastUsed(keyId: string): Promise<void>;
}

export class PostgresApiKeyRepository implements IApiKeyRepository {
  private pool: pg.Pool;

  constructor(pool: pg.Pool = Database.getPool()) {
    this.pool = pool;
  }

  public async findByKeyHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const query = `
      SELECT 
        k.id,
        k.org_id AS "orgId",
        o.name AS "orgName",
        o.billing_mode AS "billingMode",
        k.key_hash AS "keyHash",
        k.key_prefix AS "keyPrefix",
        k.name,
        k.is_active AS "isActive",
        k.rate_limit_per_sec AS "rateLimitPerSec",
        COALESCE(k.rate_limit_window_ms, 1000) AS "rateLimitWindowMs",
        COALESCE(k.pricing_multiplier_percent, 150) AS "pricingMultiplierPercent",
        k.created_at AS "createdAt",
        k.last_used_at AS "lastUsedAt"
      FROM api_keys k
      INNER JOIN organizations o ON o.id = k.org_id
      WHERE k.key_hash = $1 AND k.is_active = TRUE
      LIMIT 1;
    `;
    const res = await this.pool.query(query, [keyHash]);
    if (res.rows.length === 0) return null;
    return res.rows[0] as ApiKeyRecord;
  }

  public async createKey(record: Omit<ApiKeyRecord, 'createdAt' | 'lastUsedAt'>): Promise<ApiKeyRecord> {
    const query = `
      INSERT INTO api_keys (id, org_id, key_hash, key_prefix, name, is_active, rate_limit_per_sec)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING 
        id, 
        org_id AS "orgId", 
        key_hash AS "keyHash", 
        key_prefix AS "keyPrefix", 
        name, 
        is_active AS "isActive", 
        rate_limit_per_sec AS "rateLimitPerSec",
        created_at AS "createdAt", 
        last_used_at AS "lastUsedAt";
    `;
    const res = await this.pool.query(query, [
      record.id,
      record.orgId,
      record.keyHash,
      record.keyPrefix,
      record.name,
      record.isActive,
      record.rateLimitPerSec,
    ]);
    return {
      ...res.rows[0],
      orgName: record.orgName,
      billingMode: record.billingMode,
    };
  }

  public async touchLastUsed(keyId: string): Promise<void> {
    await this.pool.query(
      'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
      [keyId]
    );
  }
}

export class InMemoryApiKeyRepository implements IApiKeyRepository {
  private keys: Map<string, ApiKeyRecord> = new Map();

  public async findByKeyHash(keyHash: string): Promise<ApiKeyRecord | null> {
    for (const key of this.keys.values()) {
      if (key.keyHash === keyHash && key.isActive) {
        return { ...key };
      }
    }
    return null;
  }

  public async createKey(record: Omit<ApiKeyRecord, 'createdAt' | 'lastUsedAt'>): Promise<ApiKeyRecord> {
    const now = new Date();
    const created: ApiKeyRecord = {
      ...record,
      createdAt: now,
      lastUsedAt: null,
    };
    this.keys.set(record.id, created);
    return { ...created };
  }

  public async touchLastUsed(keyId: string): Promise<void> {
    const record = this.keys.get(keyId);
    if (record) {
      record.lastUsedAt = new Date();
    }
  }

  public clear(): void {
    this.keys.clear();
  }
}
