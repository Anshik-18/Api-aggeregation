import crypto from 'node:crypto';
import { IApiKeyRepository } from './api-key.repository.js';
import { AuthenticatedClient } from '../../common/types.js';

export class ApiKeyService {
  constructor(private readonly apiKeyRepo: IApiKeyRepository) {}

  public static hashKey(rawKey: string): string {
    return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
  }

  public static generateKey(prefix = 'ak_live_'): { rawKey: string; keyHash: string; keyPrefix: string } {
    const randomBytes = crypto.randomBytes(24).toString('base64url');
    const rawKey = `${prefix}${randomBytes}`;
    const keyHash = this.hashKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12);
    return { rawKey, keyHash, keyPrefix };
  }

  public async authenticate(rawKey: string): Promise<AuthenticatedClient | null> {
    if (!rawKey || typeof rawKey !== 'string') {
      return null;
    }

    const keyHash = ApiKeyService.hashKey(rawKey);
    const keyRecord = await this.apiKeyRepo.findByKeyHash(keyHash);

    if (!keyRecord || !keyRecord.isActive) {
      return null;
    }

    // Async update last_used without blocking request pipeline
    this.apiKeyRepo.touchLastUsed(keyRecord.id).catch(() => {});

    return {
      orgId: keyRecord.orgId,
      keyId: keyRecord.id,
      name: keyRecord.name,
      billingMode: keyRecord.billingMode,
      rateLimitPerSec: keyRecord.rateLimitPerSec,
      rateLimitWindowMs: keyRecord.rateLimitWindowMs ?? 1000,
      pricingMultiplierPercent: keyRecord.pricingMultiplierPercent ?? 150,
    };
  }
}
