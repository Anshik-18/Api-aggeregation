import { UpstreamProvider } from '../providers/provider.interface.js';
import { ProviderRegistry } from '../providers/provider.registry.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { ProviderMetricsTracker } from './provider-metrics.js';
import { ProviderUnavailableError } from '../../common/errors.js';
import { rootLogger } from '../../common/logger.js';

export interface RouteSelectionOptions {
  preferredProviderId?: string;
  excludeProviderIds?: Set<string>;
}

export interface CandidateEvaluation {
  provider: UpstreamProvider;
  isEligible: boolean;
  disqualificationReason?: string;
  score: {
    cost: number;
    latencyMs: number;
    errorRate: number;
  };
}

export class Router {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly circuitBreakers: Map<string, CircuitBreaker>,
    private readonly metricsTrackers: Map<string, ProviderMetricsTracker>
  ) {}

  /**
   * Evaluates all registered providers and returns an ordered list of eligible
   * candidates for execution and failover.
   */
  public getEligibleCandidates(options: RouteSelectionOptions = {}): UpstreamProvider[] {
    const allProviders = this.providerRegistry.getAll();
    if (allProviders.length === 0) {
      throw new ProviderUnavailableError('No providers registered in gateway');
    }

    const { preferredProviderId, excludeProviderIds = new Set() } = options;
    const evaluated: CandidateEvaluation[] = [];

    for (const provider of allProviders) {
      // 1. Check if already attempted in this request failover chain
      if (excludeProviderIds.has(provider.id)) {
        continue;
      }

      // 2. Hard Eligibility Check: Circuit Breaker State
      const circuitBreaker = this.circuitBreakers.get(provider.id);
      if (circuitBreaker && !circuitBreaker.canExecute()) {
        evaluated.push({
          provider,
          isEligible: false,
          disqualificationReason: `Circuit breaker is ${circuitBreaker.getState()}`,
          score: { cost: provider.costPerUnit, latencyMs: 0, errorRate: 1 },
        });
        continue;
      }

      // 3. Hard Eligibility Check: Capacity / Concurrency Limit
      const metrics = this.metricsTrackers.get(provider.id);
      const activeConcurrency = metrics ? metrics.getActiveConcurrency() : 0;
      if (activeConcurrency >= provider.maxConcurrency) {
        evaluated.push({
          provider,
          isEligible: false,
          disqualificationReason: `Capacity saturated (${activeConcurrency}/${provider.maxConcurrency} active)`,
          score: { cost: provider.costPerUnit, latencyMs: 0, errorRate: 0 },
        });
        continue;
      }

      // Candidate is eligible! Gather metrics for ranking
      const snapshot = metrics?.getSnapshot();
      const latencyMs = snapshot?.ewmaLatencyMs ?? provider.baselineLatencyMs;
      const errorRate = snapshot?.rollingErrorRate ?? 0;

      evaluated.push({
        provider,
        isEligible: true,
        score: {
          cost: provider.costPerUnit,
          latencyMs,
          errorRate,
        },
      });
    }

    const eligible = evaluated.filter((e) => e.isEligible);

    if (eligible.length === 0) {
      const reasons = evaluated
        .map((e) => `${e.provider.id}: ${e.disqualificationReason ?? 'unavailable'}`)
        .join(', ');
      rootLogger.warn({ reasons }, 'No eligible providers available for request');
      return [];
    }

    // Sort eligible candidates deterministically:
    // 1. Preferred provider first (if specified and eligible)
    // 2. Cost-aware: cheapest cost per unit
    // 3. Latency: lower EWMA latency
    // 4. Reliability: lower rolling error rate
    // 5. Deterministic tie-breaker: provider ID lexicographical order
    eligible.sort((a, b) => {
      if (preferredProviderId) {
        if (a.provider.id === preferredProviderId) return -1;
        if (b.provider.id === preferredProviderId) return 1;
      }

      // Primary: Cost
      if (a.score.cost !== b.score.cost) {
        return a.score.cost - b.score.cost;
      }

      // Secondary: Latency (if difference > 10ms to avoid micro-jitter flipping)
      if (Math.abs(a.score.latencyMs - b.score.latencyMs) > 10) {
        return a.score.latencyMs - b.score.latencyMs;
      }

      // Tertiary: Error rate
      if (a.score.errorRate !== b.score.errorRate) {
        return a.score.errorRate - b.score.errorRate;
      }

      // Deterministic Tie-Breaker
      return a.provider.id.localeCompare(b.provider.id);
    });

    return eligible.map((e) => e.provider);
  }
}
