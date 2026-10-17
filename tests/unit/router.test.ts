import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '../../src/modules/routing/router.js';
import { ProviderRegistry } from '../../src/modules/providers/provider.registry.js';
import { CircuitBreaker } from '../../src/modules/routing/circuit-breaker.js';
import { ProviderMetricsTracker } from '../../src/modules/routing/provider-metrics.js';
import { MockProviderAlpha } from '../../src/modules/providers/mock/mock-provider-alpha.js';
import { MockProviderBeta } from '../../src/modules/providers/mock/mock-provider-beta.js';
import { TestClock } from '../../src/common/clock.js';

describe('Router (Unit)', () => {
  let clock: TestClock;
  let registry: ProviderRegistry;
  let circuitBreakers: Map<string, CircuitBreaker>;
  let metricsTrackers: Map<string, ProviderMetricsTracker>;
  let router: Router;

  let providerAlpha: MockProviderAlpha;
  let providerBeta: MockProviderBeta;

  beforeEach(() => {
    clock = new TestClock(1000000);
    registry = new ProviderRegistry();
    circuitBreakers = new Map();
    metricsTrackers = new Map();

    providerAlpha = new MockProviderAlpha(0.001, 50); // $0.001
    providerBeta = new MockProviderBeta(0.003, 20);   // $0.003

    registry.register(providerAlpha);
    registry.register(providerBeta);

    circuitBreakers.set(
      providerAlpha.id,
      new CircuitBreaker(providerAlpha.id, { failureThreshold: 3 }, clock)
    );
    circuitBreakers.set(
      providerBeta.id,
      new CircuitBreaker(providerBeta.id, { failureThreshold: 3 }, clock)
    );

    metricsTrackers.set(
      providerAlpha.id,
      new ProviderMetricsTracker(providerAlpha.id, providerAlpha.maxConcurrency, 60000, clock)
    );
    metricsTrackers.set(
      providerBeta.id,
      new ProviderMetricsTracker(providerBeta.id, providerBeta.maxConcurrency, 60000, clock)
    );

    router = new Router(registry, circuitBreakers, metricsTrackers);
  });

  it('should select cheapest provider (Alpha) first when both are healthy', () => {
    const candidates = router.getEligibleCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates[0].id).toBe('provider_alpha');
    expect(candidates[1].id).toBe('provider_beta');
  });

  it('should exclude an open-circuit provider and choose next eligible provider', () => {
    const cbAlpha = circuitBreakers.get(providerAlpha.id)!;
    cbAlpha.onFailure(false);
    cbAlpha.onFailure(false);
    cbAlpha.onFailure(false); // Trips Alpha circuit

    const candidates = router.getEligibleCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('provider_beta');
  });

  it('should exclude a capacity-saturated provider', () => {
    const alphaMetrics = metricsTrackers.get(providerAlpha.id)!;
    // Saturate Alpha's capacity
    for (let i = 0; i < providerAlpha.maxConcurrency; i++) {
      alphaMetrics.acquireConcurrency();
    }

    const candidates = router.getEligibleCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('provider_beta');
  });

  it('should prioritize preferredProviderId when requested and eligible', () => {
    const candidates = router.getEligibleCandidates({
      preferredProviderId: 'provider_beta',
    });
    expect(candidates[0].id).toBe('provider_beta');
    expect(candidates[1].id).toBe('provider_alpha');
  });

  it('should return empty array when all providers are disqualified', () => {
    circuitBreakers.get(providerAlpha.id)!.onFailure(false);
    circuitBreakers.get(providerAlpha.id)!.onFailure(false);
    circuitBreakers.get(providerAlpha.id)!.onFailure(false);

    circuitBreakers.get(providerBeta.id)!.onFailure(false);
    circuitBreakers.get(providerBeta.id)!.onFailure(false);
    circuitBreakers.get(providerBeta.id)!.onFailure(false);

    const candidates = router.getEligibleCandidates();
    expect(candidates).toHaveLength(0);
  });

  it('should break ties deterministically by provider ID when price and latency are equal', () => {
    const provider1 = new MockProviderAlpha(0.002, 30);
    const provider2 = new MockProviderBeta(0.002, 30);

    const customRegistry = new ProviderRegistry();
    customRegistry.register(provider1);
    customRegistry.register(provider2);

    const tieRouter = new Router(customRegistry, circuitBreakers, metricsTrackers);
    const candidates = tieRouter.getEligibleCandidates();

    expect(candidates[0].id).toBe('provider_alpha');
    expect(candidates[1].id).toBe('provider_beta');
  });
});
