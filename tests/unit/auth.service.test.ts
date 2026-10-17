import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryApiKeyRepository } from '../../src/modules/auth/api-key.repository.js';
import { ApiKeyService } from '../../src/modules/auth/api-key.service.js';

describe('ApiKeyService (Unit)', () => {
  let repo: InMemoryApiKeyRepository;
  let service: ApiKeyService;

  beforeEach(() => {
    repo = new InMemoryApiKeyRepository();
    service = new ApiKeyService(repo);
  });

  it('should generate consistent SHA-256 hashes for raw keys', () => {
    const rawKey = 'ak_live_samplekey123';
    const hash1 = ApiKeyService.hashKey(rawKey);
    const hash2 = ApiKeyService.hashKey(rawKey);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex string length
  });

  it('should generate random unique API keys with specified prefix', () => {
    const key1 = ApiKeyService.generateKey('ak_custom_');
    const key2 = ApiKeyService.generateKey('ak_custom_');

    expect(key1.rawKey.startsWith('ak_custom_')).toBe(true);
    expect(key2.rawKey.startsWith('ak_custom_')).toBe(true);
    expect(key1.rawKey).not.toBe(key2.rawKey);
    expect(key1.keyHash).not.toBe(key2.keyHash);
  });

  it('should authenticate a valid active key and return client context', async () => {
    const generated = ApiKeyService.generateKey();
    await repo.createKey({
      id: 'key_1',
      orgId: 'org_1',
      orgName: 'Org 1',
      billingMode: 'PREPAID',
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      name: 'Key 1',
      isActive: true,
      rateLimitPerSec: 50,
    });

    const client = await service.authenticate(generated.rawKey);
    expect(client).not.toBeNull();
    expect(client?.orgId).toBe('org_1');
    expect(client?.keyId).toBe('key_1');
    expect(client?.billingMode).toBe('PREPAID');
    expect(client?.rateLimitPerSec).toBe(50);
  });

  it('should return null for an inactive key', async () => {
    const generated = ApiKeyService.generateKey();
    await repo.createKey({
      id: 'key_inactive',
      orgId: 'org_1',
      orgName: 'Org 1',
      billingMode: 'PREPAID',
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      name: 'Deactivated Key',
      isActive: false,
      rateLimitPerSec: 50,
    });

    const client = await service.authenticate(generated.rawKey);
    expect(client).toBeNull();
  });

  it('should return null for unknown keys or malformed inputs', async () => {
    const client = await service.authenticate('non_existent_key');
    expect(client).toBeNull();

    // @ts-expect-error testing invalid input types
    expect(await service.authenticate(null)).toBeNull();
    // @ts-expect-error testing invalid input types
    expect(await service.authenticate(undefined)).toBeNull();
  });
});
