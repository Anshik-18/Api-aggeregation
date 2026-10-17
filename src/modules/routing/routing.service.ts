import { Clock, SystemClock } from '../../common/clock.js';
import { UpstreamProvider } from '../providers/provider.interface.js';
import { ProviderRegistry } from '../providers/provider.registry.js';
import { CircuitBreaker, CircuitBreakerConfig } from './circuit-breaker.js';
import { ProviderMetricsTracker } from './provider-metrics.js';
import { Router } from './router.js';
import { config } from '../../config/index.js';

export interface RoutingServiceOptions {
  circuitBreakerConfig?: CircuitBreakerConfig;
  metricsWindowMs?: number;
  clock?: Clock;
}

export class RoutingService {
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private metricsTrackers = new Map<string, ProviderMetricsTracker>();
  private router: Router;
  private clock: Clock;

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    options: RoutingServiceOptions = {}
  ) {
    this.clock = options.clock ?? new SystemClock();

    const cbConfig: CircuitBreakerConfig = options.circuitBreakerConfig ?? {
      failureThreshold: config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      cooldownPeriodMs: config.CIRCUIT_BREAKER_COOLDOWN_MS,
      errorRateThreshold: config.CIRCUIT_BREAKER_ERROR_RATE_THRESHOLD,
      minRequestsForErrorRate: config.CIRCUIT_BREAKER_MIN_REQUESTS,
    };

    const windowMs = options.metricsWindowMs ?? config.PROVIDER_METRICS_WINDOW_MS;

    // Initialize trackers for all currently registered providers
    for (const provider of this.providerRegistry.getAll()) {
      this.initProvider(provider, cbConfig, windowMs);
    }

    this.router = new Router(
      this.providerRegistry,
      this.circuitBreakers,
      this.metricsTrackers
    );
  }

  public initProvider(
    provider: UpstreamProvider,
    cbConfig?: CircuitBreakerConfig,
    windowMs?: number
  ): void {
    if (!this.circuitBreakers.has(provider.id)) {
      this.circuitBreakers.set(
        provider.id,
        new CircuitBreaker(
          provider.id,
          cbConfig ?? {
            failureThreshold: config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
            cooldownPeriodMs: config.CIRCUIT_BREAKER_COOLDOWN_MS,
            errorRateThreshold: config.CIRCUIT_BREAKER_ERROR_RATE_THRESHOLD,
            minRequestsForErrorRate: config.CIRCUIT_BREAKER_MIN_REQUESTS,
          },
          this.clock
        )
      );
    }

    if (!this.metricsTrackers.has(provider.id)) {
      this.metricsTrackers.set(
        provider.id,
        new ProviderMetricsTracker(
          provider.id,
          provider.maxConcurrency,
          windowMs ?? config.PROVIDER_METRICS_WINDOW_MS,
          this.clock
        )
      );
    }
  }

  public getRouter(): Router {
    return this.router;
  }

  public getCircuitBreaker(providerId: string): CircuitBreaker | undefined {
    return this.circuitBreakers.get(providerId);
  }

  public getMetricsTracker(providerId: string): ProviderMetricsTracker | undefined {
    return this.metricsTrackers.get(providerId);
  }

  public getProviderStatus(providerId: string) {
    const provider = this.providerRegistry.get(providerId);
    if (!provider) return null;

    const cb = this.circuitBreakers.get(providerId);
    const metrics = this.metricsTrackers.get(providerId);

    return {
      id: provider.id,
      name: provider.name,
      costPerUnit: provider.costPerUnit,
      baselineLatencyMs: provider.baselineLatencyMs,
      maxConcurrency: provider.maxConcurrency,
      circuitBreaker: cb ? cb.getSnapshot() : null,
      metrics: metrics ? metrics.getSnapshot() : null,
    };
  }

  public getAllProviderStatuses() {
    return this.providerRegistry.getAll().map((p) => this.getProviderStatus(p.id));
  }
}
