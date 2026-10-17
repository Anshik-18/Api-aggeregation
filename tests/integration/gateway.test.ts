import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, TestContext } from '../helpers/test-app.js';
import { CircuitState } from '../../src/modules/routing/circuit-breaker.js';

describe('Gateway Routing, Circuit Breakers & Failover (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({
      circuitBreakerConfig: {
        failureThreshold: 3,
        cooldownPeriodMs: 5000,
        errorRateThreshold: 0.5,
        minRequestsForErrorRate: 4,
      },
    });
  });

  afterAll(async () => {
    await context.app.close();
  });

  beforeEach(() => {
    context.providerAlpha.resetFailureConfig();
    context.providerBeta.resetFailureConfig();
    context.routingService.getCircuitBreaker('provider_alpha')?.reset();
    context.routingService.getCircuitBreaker('provider_beta')?.reset();
    context.routingService.getMetricsTracker('provider_alpha')?.reset();
    context.routingService.getMetricsTracker('provider_beta')?.reset();
  });

  it('should select cheapest provider (Alpha) by default when both are healthy', async () => {
    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
      },
      payload: {
        endpoint: '/v1/chat/completions',
        method: 'POST',
        body: { prompt: 'ping' },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.success).toBe(true);
    expect(body.meta.providerId).toBe('provider_alpha');
    expect(body.data.provider).toBe('provider_alpha');
    expect(body.data.usage.unitCost).toBe(0.001);
  });

  it('should automatically failover to Provider Beta when Provider Alpha fails with a retryable 503 error', async () => {
    // Inject failure into the cheaper provider (Alpha)
    context.providerAlpha.setFailureConfig({ simulateStatusCode: 503 });

    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
      },
      payload: {
        endpoint: '/v1/chat/completions',
        method: 'POST',
        body: { prompt: 'ping with fallback' },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.success).toBe(true);
    // Request succeeded because of automatic failover to Beta!
    expect(body.meta.providerId).toBe('provider_beta');
    expect(body.data.provider).toBe('provider_beta');
    expect(body.data.usage.unitCost).toBe(0.003);

    // Alpha metrics should record 1 failure
    const alphaMetrics = context.routingService.getMetricsTracker('provider_alpha')!.getSnapshot();
    expect(alphaMetrics.totalFailures).toBe(1);

    // Beta metrics should record 1 success
    const betaMetrics = context.routingService.getMetricsTracker('provider_beta')!.getSnapshot();
    expect(betaMetrics.totalSuccesses).toBe(1);
  });

  it('should automatically failover to Provider Beta on Provider Alpha timeout', async () => {
    context.providerAlpha.setFailureConfig({ simulateTimeout: true });

    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
      },
      payload: {
        endpoint: '/v1/test',
        method: 'POST',
        timeoutMs: 30, // Small timeout for test
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.meta.providerId).toBe('provider_beta');
  });

  it('should trip circuit breaker after failure threshold and exclude Alpha from subsequent requests', async () => {
    const cbAlpha = context.routingService.getCircuitBreaker('provider_alpha')!;
    expect(cbAlpha.getState()).toBe(CircuitState.CLOSED);

    // Alpha fails consistently
    context.providerAlpha.setFailureConfig({ simulateStatusCode: 503 });

    // Send 3 requests (threshold is 3). Each will fail on Alpha and succeed via failover on Beta.
    for (let i = 0; i < 3; i++) {
      const res = await context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: { 'x-api-key': context.validApiKey },
        payload: { endpoint: '/v1/test', method: 'POST' },
      });
      expect(res.statusCode).toBe(200);
    }

    // Alpha circuit breaker should now be OPEN!
    expect(cbAlpha.getState()).toBe(CircuitState.OPEN);

    // 4th request: Alpha is OPEN, so router immediately dispatches directly to Beta without attempting Alpha!
    const alphaAttemptsBefore = context.routingService.getMetricsTracker('provider_alpha')!.getSnapshot().totalRequests;

    const res4 = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: { 'x-api-key': context.validApiKey },
      payload: { endpoint: '/v1/test', method: 'POST' },
    });

    expect(res4.statusCode).toBe(200);
    const body4 = JSON.parse(res4.body);
    expect(body4.meta.providerId).toBe('provider_beta');

    // Alpha was completely bypassed
    const alphaAttemptsAfter = context.routingService.getMetricsTracker('provider_alpha')!.getSnapshot().totalRequests;
    expect(alphaAttemptsAfter).toBe(alphaAttemptsBefore);
  });

  it('should restore an open circuit breaker via HALF_OPEN probe after cooldown', async () => {
    const cbAlpha = context.routingService.getCircuitBreaker('provider_alpha')!;

    // Trip Alpha circuit
    context.providerAlpha.setFailureConfig({ simulateStatusCode: 503 });
    for (let i = 0; i < 3; i++) {
      await context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: { 'x-api-key': context.validApiKey },
        payload: { endpoint: '/v1/test', method: 'POST' },
      });
    }
    expect(cbAlpha.getState()).toBe(CircuitState.OPEN);

    // Heal Provider Alpha
    context.providerAlpha.resetFailureConfig();

    // Advance clock past the 5000ms cooldown
    context.clock.advance(5001);
    expect(cbAlpha.getState()).toBe(CircuitState.HALF_OPEN);

    // Send a probe request through the gateway
    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: { 'x-api-key': context.validApiKey },
      payload: { endpoint: '/v1/test', method: 'POST' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Provider Alpha was tested and succeeded!
    expect(body.meta.providerId).toBe('provider_alpha');

    // Circuit breaker is restored to CLOSED
    expect(cbAlpha.getState()).toBe(CircuitState.CLOSED);
  });

  it('should return 503 Provider Unavailable when all providers fail', async () => {
    context.providerAlpha.setFailureConfig({ simulateStatusCode: 503 });
    context.providerBeta.setFailureConfig({ simulateStatusCode: 503 });

    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
      },
      payload: {
        endpoint: '/v1/test',
        method: 'POST',
      },
    });

    // Both providers failed
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('should NOT count client errors (400) as provider failures or trip circuit breaker', async () => {
    const cbAlpha = context.routingService.getCircuitBreaker('provider_alpha')!;

    // Make Provider Alpha return a 400 Bad Request
    context.providerAlpha.setFailureConfig({ simulateStatusCode: 400 });

    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
      },
      payload: {
        endpoint: '/v1/test',
        method: 'POST',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(cbAlpha.getState()).toBe(CircuitState.CLOSED);

    const snapshot = context.routingService.getMetricsTracker('provider_alpha')!.getSnapshot();
    expect(snapshot.totalFailures).toBe(0);
    expect(snapshot.totalClientErrors).toBe(1);
  });

  it('should bypass saturated provider when active concurrency reaches maxConcurrency', async () => {
    const alphaMetrics = context.routingService.getMetricsTracker('provider_alpha')!;

    // Artificially saturate Alpha's concurrency slots
    for (let i = 0; i < context.providerAlpha.maxConcurrency; i++) {
      alphaMetrics.acquireConcurrency();
    }
    expect(alphaMetrics.getActiveConcurrency()).toBe(context.providerAlpha.maxConcurrency);

    // Dispatch request: since Alpha is saturated, router must pick Beta
    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
      },
      payload: {
        endpoint: '/v1/test',
        method: 'POST',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.meta.providerId).toBe('provider_beta');

    // Clean up acquired slots
    for (let i = 0; i < context.providerAlpha.maxConcurrency; i++) {
      alphaMetrics.releaseConcurrency();
    }
  });

  it('should accurately track metrics under concurrent requests', async () => {
    const count = 15;
    const requests = Array.from({ length: count }).map(() =>
      context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: { 'x-api-key': context.validApiKey },
        payload: { endpoint: '/v1/test', method: 'POST' },
      })
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }

    const snapshot = context.routingService.getMetricsTracker('provider_alpha')!.getSnapshot();
    expect(snapshot.totalSuccesses).toBe(count);
    expect(snapshot.activeConcurrency).toBe(0); // All released cleanly
  });

  it('should report comprehensive provider health, metrics, and circuit status via GET /v1/gateway/providers', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/v1/gateway/providers',
      headers: {
        'x-api-key': context.validApiKey,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    const alpha = body.data.find((p: any) => p.id === 'provider_alpha');
    expect(alpha).toBeDefined();
    expect(alpha.circuitBreaker).toBeDefined();
    expect(alpha.circuitBreaker.state).toBe(CircuitState.CLOSED);
    expect(alpha.metrics).toBeDefined();
    expect(alpha.metrics.activeConcurrency).toBe(0);
  });
});
