import { RoutingService } from '../routing/routing.service.js';
import { BillingService } from '../billing/billing.service.js';
import { ICacheService } from '../caching/cache.types.js';
import { CachedResponse } from '../caching/cache.types.js';
import { ICoalescingService, CoalesceResult } from '../caching/coalescing.service.js';
import {
  NormalizedRequest,
  NormalizedResponse,
  UpstreamProvider,
} from '../providers/provider.interface.js';
import {
  UpstreamProviderError,
  UpstreamTimeoutError,
  ProviderUnavailableError,
  AmbiguousOutcomeError,
} from '../../common/errors.js';
import { rootLogger } from '../../common/logger.js';
import { config } from '../../config/index.js';

export interface ExecuteOptions {
  orgId: string;
  requestId: string;
  idempotencyKey?: string;
  preferredProviderId?: string;
  pricingMultiplierPercent?: number;
  maxRetries?: number;
  cacheEligible?: boolean;
  cacheBypass?: boolean;
  cacheTtlSeconds?: number;
  headers?: Record<string, unknown>;
}

export interface GatewayExecutionResult {
  response: NormalizedResponse;
  provider: {
    id: string;
    name: string;
    costPerUnit: number;
  };
  customerChargeMicros: bigint;
  attempts: number;
  isReplay?: boolean;
  cacheStatus: 'HIT' | 'MISS' | 'BYPASS';
  isCoalesced: boolean;
}

export class GatewayService {
  constructor(
    private readonly routingService: RoutingService,
    private readonly billingService: BillingService,
    private readonly cacheService: ICacheService,
    private readonly coalescingService: ICoalescingService
  ) {}

  public async execute(
    request: NormalizedRequest,
    options: ExecuteOptions
  ): Promise<GatewayExecutionResult> {
    const { orgId, requestId, idempotencyKey, preferredProviderId } = options;
    const maxRetries = options.maxRetries ?? config.ROUTING_MAX_RETRIES;
    const multiplier = options.pricingMultiplierPercent ?? 150;

    // 1. Calculate Request Identity Hash for Idempotency
    const requestHash = BillingService.calculateRequestHash(
      request.endpoint,
      request.method,
      request.body
    );

    // 2. Pre-flight Balance Reservation
    // Estimate hold based on highest provider cost and customer multiplier
    const defaultHoldMicros = this.billingService.estimateHoldAmount(0.003000, multiplier);
    const reservation = await this.billingService.reserveFunds(
      orgId,
      requestId,
      idempotencyKey ?? null,
      requestHash,
      defaultHoldMicros
    );

    // If this is an idempotent replay of a previously completed request, return stored result immediately
    if (reservation.isReplay) {
      rootLogger.info(
        { requestId, idempotencyKey, orgId },
        'Returning completed idempotent replay from database'
      );

      const cached = reservation.record;
      return {
        response: {
          providerId: cached.providerId ?? 'cached_replay',
          statusCode: cached.responseStatus ?? 200,
          headers: (cached.responseHeaders as Record<string, string>) ?? {},
          body: cached.responseBody,
          latencyMs: 0,
          cost: 0,
        },
        provider: {
          id: cached.providerId ?? 'cached_replay',
          name: 'Idempotent Replay',
          costPerUnit: 0,
        },
        customerChargeMicros: cached.capturedAmountMicros,
        attempts: 1,
        isReplay: true,
        cacheStatus: 'HIT',
        isCoalesced: false,
      };
    }

    // 3. Cache & Request Coalescing Evaluation
    const reqHeaders = options.headers ?? (request.headers as Record<string, unknown> | undefined);
    const isEligible =
      this.cacheService.isCacheEligible(request.method, reqHeaders, request.body) ||
      options.cacheEligible === true ||
      request.endpoint.includes('/market') ||
      (request.body as any)?.cacheEligible === true;
    const isBypass =
      this.cacheService.isCacheBypass(reqHeaders) || options.cacheBypass === true;
    const ttlSeconds = this.cacheService.getTtlSeconds(reqHeaders, options.cacheTtlSeconds);
    const cacheKey = this.cacheService.buildCacheKey(
      orgId,
      request.endpoint,
      request.method,
      request.params,
      request.body
    );

    // 3a. Cache Lookup (if eligible and not bypassed)
    if (isEligible && !isBypass) {
      const cached = await this.cacheService.get(cacheKey);
      if (cached) {
        rootLogger.info({ requestId, orgId, cacheKey }, 'Cache HIT: returning cached response');
        const chargeMicros = this.billingService.calculateCacheHitCharge(cached.originalCost, undefined, multiplier);
        await this.billingService.captureSettlement(
          requestId,
          chargeMicros,
          `cache:${cached.providerId}`,
          {
            providerId: cached.providerId,
            statusCode: cached.statusCode,
            headers: cached.headers,
            body: cached.body,
            latencyMs: 1,
            cost: 0,
          }
        );

        return {
          response: {
            providerId: cached.providerId,
            statusCode: cached.statusCode,
            headers: cached.headers,
            body: cached.body,
            latencyMs: 1,
            cost: 0,
          },
          provider: {
            id: cached.providerId,
            name: `Cache (${cached.providerId})`,
            costPerUnit: 0,
          },
          customerChargeMicros: chargeMicros,
          attempts: 0,
          cacheStatus: 'HIT',
          isCoalesced: false,
        };
      }
    }

    // 3b. Request Coalescing (Single Flight) for Cache Misses
    let coalesceResult: CoalesceResult = { isLeader: true };
    if (isEligible && !isBypass) {
      coalesceResult = await this.coalescingService.executeCoalesced(
        cacheKey,
        config.CACHE_COALESCING_TIMEOUT_MS,
        () => this.cacheService.get(cacheKey)
      );

      // If not leader and waiter received the coalesced response
      if (!coalesceResult.isLeader && coalesceResult.cachedResponse) {
        const cached = coalesceResult.cachedResponse;
        rootLogger.info(
          { requestId, orgId, cacheKey },
          'Request coalescing WAITER hit: reusing leader response'
        );
        const chargeMicros = this.billingService.calculateCacheHitCharge(cached.originalCost, undefined, multiplier);
        await this.billingService.captureSettlement(
          requestId,
          chargeMicros,
          `coalesce:${cached.providerId}`,
          {
            providerId: cached.providerId,
            statusCode: cached.statusCode,
            headers: cached.headers,
            body: cached.body,
            latencyMs: 2,
            cost: 0,
          }
        );

        return {
          response: {
            providerId: cached.providerId,
            statusCode: cached.statusCode,
            headers: cached.headers,
            body: cached.body,
            latencyMs: 2,
            cost: 0,
          },
          provider: {
            id: cached.providerId,
            name: `Coalesced (${cached.providerId})`,
            costPerUnit: 0,
          },
          customerChargeMicros: chargeMicros,
          attempts: 0,
          cacheStatus: 'HIT',
          isCoalesced: true,
        };
      }
    }

    // 4. Upstream Execution & Failover Dispatch (Leader or non-cacheable execution)
    const router = this.routingService.getRouter();
    const attemptedProviderIds = new Set<string>();
    let lastError: Error | null = null;
    let attempts = 0;
    let hasEncounteredTimeout = false;

    try {
      while (attempts <= maxRetries) {
        const candidates = router.getEligibleCandidates({
          preferredProviderId: attempts === 0 ? preferredProviderId : undefined,
          excludeProviderIds: attemptedProviderIds,
        });

        if (candidates.length === 0) {
          break; // No further eligible providers
        }

        const provider: UpstreamProvider = candidates[0];
        attemptedProviderIds.add(provider.id);

        const metrics = this.routingService.getMetricsTracker(provider.id);
        const circuitBreaker = this.routingService.getCircuitBreaker(provider.id);

        const acquired = metrics ? metrics.acquireConcurrency() : true;
        if (!acquired) {
          continue;
        }

        attempts++;

        try {
          // Upstream Execution
          const response = await provider.execute(request);

          // Semantic Response Validation
          const validation = provider.validateResponse(response.body, response.statusCode);
          if (!validation.isValid) {
            rootLogger.warn(
              {
                requestId,
                providerId: provider.id,
                reason: validation.errorReason,
              },
              'Upstream response failed semantic validation'
            );

            const snapshot = metrics?.getSnapshot();
            metrics?.recordFailure(response.statusCode, response.latencyMs, false);
            circuitBreaker?.onFailure(
              false,
              snapshot?.rollingErrorRate,
              snapshot?.rollingRequests
            );

            lastError = new UpstreamProviderError(
              provider.id,
              `Semantic validation failed: ${validation.errorReason ?? 'Unknown error'}`,
              502,
              true,
              { validationError: validation.errorReason }
            );

            continue; // Fall back to next provider
          }

          // Confirmed Success!
          metrics?.recordSuccess(response.latencyMs);
          circuitBreaker?.onSuccess();

          // Settle billing: capture the exact customer charge
          const actualChargeMicros = this.billingService.calculateFinalCharge(response.cost, multiplier);
          await this.billingService.captureSettlement(
            requestId,
            actualChargeMicros,
            provider.id,
            response
          );

          // Store in Cache and Notify Coalescing Waiters if cache-eligible
          if (isEligible) {
            const cachedItem: CachedResponse = {
              statusCode: response.statusCode,
              headers: response.headers,
              body: response.body,
              providerId: provider.id,
              originalCost: response.cost,
              cachedAt: new Date().toISOString(),
              ttlSeconds,
            };
            await this.cacheService.set(cacheKey, cachedItem, ttlSeconds);
            if (coalesceResult.isLeader) {
              await this.coalescingService.publishSuccess(cacheKey, cachedItem);
              await this.coalescingService.releaseLock(cacheKey);
            }
          }

          return {
            response,
            provider: {
              id: provider.id,
              name: provider.name,
              costPerUnit: provider.costPerUnit,
            },
            customerChargeMicros: actualChargeMicros,
            attempts,
            cacheStatus: isBypass ? 'BYPASS' : 'MISS',
            isCoalesced: false,
          };
        } catch (err) {
          const error = err as Error;

          if (error instanceof UpstreamTimeoutError) {
            hasEncounteredTimeout = true;
            const snapshot = metrics?.getSnapshot();
            metrics?.recordFailure(504, 0, false);
            circuitBreaker?.onFailure(
              false,
              snapshot?.rollingErrorRate,
              snapshot?.rollingRequests
            );

            lastError = error;
          } else if (error instanceof UpstreamProviderError) {
            const isClientError =
              error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429;

            if (isClientError) {
              metrics?.recordFailure(error.statusCode, 0, true);
              await this.billingService.releaseReservation(
                requestId,
                `Client error: ${error.message}`
              );
              if (isEligible && coalesceResult.isLeader) {
                await this.coalescingService.publishFailure(cacheKey);
                await this.coalescingService.releaseLock(cacheKey);
              }
              throw error;
            }

            const snapshot = metrics?.getSnapshot();
            metrics?.recordFailure(error.statusCode, 0, false);
            circuitBreaker?.onFailure(
              false,
              snapshot?.rollingErrorRate,
              snapshot?.rollingRequests
            );

            lastError = error;

            if (!error.retryable) {
              await this.billingService.releaseReservation(
                requestId,
                `Non-retryable provider error: ${error.message}`
              );
              if (isEligible && coalesceResult.isLeader) {
                await this.coalescingService.publishFailure(cacheKey);
                await this.coalescingService.releaseLock(cacheKey);
              }
              throw error;
            }
          } else {
            await this.billingService.releaseReservation(
              requestId,
              `Internal error: ${error.message}`
            );
            if (isEligible && coalesceResult.isLeader) {
              await this.coalescingService.publishFailure(cacheKey);
              await this.coalescingService.releaseLock(cacheKey);
            }
            throw error;
          }
        } finally {
          metrics?.releaseConcurrency();
        }
      }

      // If loop exited without return, all candidates exhausted
      if (isEligible && coalesceResult.isLeader) {
        await this.coalescingService.publishFailure(cacheKey);
        await this.coalescingService.releaseLock(cacheKey);
      }

      if (hasEncounteredTimeout) {
        await this.billingService.markAmbiguousOutcome(
          requestId,
          'Upstream timeout occurred. State is unresolved.'
        );
        throw new AmbiguousOutcomeError(
          requestId,
          'Upstream execution timed out. State is uncertain; reservation retained.'
        );
      }

      await this.billingService.releaseReservation(
        requestId,
        lastError?.message ?? 'All providers failed or unavailable'
      );

      if (lastError) {
        throw lastError;
      }

      throw new ProviderUnavailableError(
        'All registered providers are currently unavailable or saturated'
      );
    } catch (finalErr) {
      if (isEligible && coalesceResult.isLeader) {
        await this.coalescingService.publishFailure(cacheKey).catch(() => {});
        await this.coalescingService.releaseLock(cacheKey).catch(() => {});
      }
      throw finalErr;
    }
  }
}
