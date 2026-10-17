import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { InMemoryApiKeyRepository } from '../../src/modules/auth/api-key.repository.js';
import { ApiKeyService } from '../../src/modules/auth/api-key.service.js';
import { ProviderRegistry } from '../../src/modules/providers/provider.registry.js';
import { MockProviderAlpha } from '../../src/modules/providers/mock/mock-provider-alpha.js';
import { MockProviderBeta } from '../../src/modules/providers/mock/mock-provider-beta.js';
import { RoutingService } from '../../src/modules/routing/routing.service.js';
import { InMemoryBillingRepository } from '../../src/modules/billing/billing.repository.js';
import { BillingService } from '../../src/modules/billing/billing.service.js';
import { InMemoryCacheService } from '../../src/modules/caching/cache.service.js';
import { InMemoryCoalescingService } from '../../src/modules/caching/coalescing.service.js';
import { InMemoryRateLimiterService } from '../../src/modules/rate-limiting/rate-limiter.service.js';
import { TestClock } from '../../src/common/clock.js';
import { CircuitBreakerConfig } from '../../src/modules/routing/circuit-breaker.js';
import { ICacheService } from '../../src/modules/caching/cache.types.js';
import { ICoalescingService } from '../../src/modules/caching/coalescing.service.js';
import { IRateLimiterService } from '../../src/modules/rate-limiting/rate-limiter.types.js';

export interface TestAppOptions {
  circuitBreakerConfig?: CircuitBreakerConfig;
  customProviders?: { alpha?: MockProviderAlpha; beta?: MockProviderBeta };
  initialBalanceMicros?: bigint;
  cacheService?: ICacheService;
  coalescingService?: ICoalescingService;
  rateLimiterService?: IRateLimiterService;
  rateLimitPerSec?: number;
}

export interface TestContext {
  app: FastifyInstance;
  apiKeyRepo: InMemoryApiKeyRepository;
  providerRegistry: ProviderRegistry;
  routingService: RoutingService;
  billingRepo: InMemoryBillingRepository;
  billingService: BillingService;
  cacheService: InMemoryCacheService;
  coalescingService: InMemoryCoalescingService;
  rateLimiterService: InMemoryRateLimiterService;
  clock: TestClock;
  providerAlpha: MockProviderAlpha;
  providerBeta: MockProviderBeta;
  validApiKey: string;
  inactiveApiKey: string;
  orgId: string;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestContext> {
  const apiKeyRepo = new InMemoryApiKeyRepository();
  const providerRegistry = new ProviderRegistry();
  const billingRepo = new InMemoryBillingRepository();
  const clock = new TestClock();

  const providerAlpha = options.customProviders?.alpha ?? new MockProviderAlpha(0.001000, 10);
  const providerBeta = options.customProviders?.beta ?? new MockProviderBeta(0.003000, 5);

  providerRegistry.register(providerAlpha);
  providerRegistry.register(providerBeta);

  const routingService = new RoutingService(providerRegistry, {
    circuitBreakerConfig: options.circuitBreakerConfig,
    clock,
  });

  const billingService = new BillingService(billingRepo, clock);
  const cacheService = (options.cacheService as InMemoryCacheService) ?? new InMemoryCacheService(clock);
  const coalescingService =
    (options.coalescingService as InMemoryCoalescingService) ?? new InMemoryCoalescingService(clock);
  const rateLimiterService =
    (options.rateLimiterService as InMemoryRateLimiterService) ?? new InMemoryRateLimiterService(clock);

  const orgId = 'org_acme_corp';
  // Seed account with default $10.00 (10,000,000 micros) or custom balance
  const initialBalance = options.initialBalanceMicros ?? 10_000_000n;
  await billingRepo.createAccount(orgId, initialBalance);

  // Generate test keys
  const validKeyData = ApiKeyService.generateKey('ak_test_valid_');
  await apiKeyRepo.createKey({
    id: 'key_valid_123',
    orgId,
    orgName: 'Acme Corporation',
    billingMode: 'PREPAID',
    keyHash: validKeyData.keyHash,
    keyPrefix: validKeyData.keyPrefix,
    name: 'Test Production Key',
    isActive: true,
    rateLimitPerSec: options.rateLimitPerSec ?? 100,
  });

  const inactiveKeyData = ApiKeyService.generateKey('ak_test_inactive_');
  await apiKeyRepo.createKey({
    id: 'key_inactive_456',
    orgId,
    orgName: 'Acme Corporation',
    billingMode: 'PREPAID',
    keyHash: inactiveKeyData.keyHash,
    keyPrefix: inactiveKeyData.keyPrefix,
    name: 'Revoked Key',
    isActive: false,
    rateLimitPerSec: 10,
  });

  const app = buildApp(
    {
      apiKeyRepository: apiKeyRepo,
      providerRegistry,
      routingService,
      billingRepository: billingRepo,
      billingService,
      cacheService,
      coalescingService,
      rateLimiterService,
      clock,
    },
    { logger: false } // Silence server logs in tests
  );

  await app.ready();

  return {
    app,
    apiKeyRepo,
    providerRegistry,
    routingService,
    billingRepo,
    billingService,
    cacheService,
    coalescingService,
    rateLimiterService,
    clock,
    providerAlpha,
    providerBeta,
    validApiKey: validKeyData.rawKey,
    inactiveApiKey: inactiveKeyData.rawKey,
    orgId,
  };
}
