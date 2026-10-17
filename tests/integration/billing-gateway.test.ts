import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, TestContext } from '../helpers/test-app.js';
import { Money } from '../../src/common/money.js';

describe('Gateway Billing & Financial Concurrency (Integration)', () => {
  let context: TestContext;

  beforeEach(async () => {
    // Fresh app with $5.00 (5,000,000 micros) initial balance
    context = await createTestApp({
      initialBalanceMicros: 5_000_000n,
    });
  });

  it('should reject requests with 402 Insufficient Funds if customer balance is zero', async () => {
    // Create an app with 0 balance
    const zeroBalanceApp = await createTestApp({
      initialBalanceMicros: 0n,
    });

    const res = await zeroBalanceApp.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': zeroBalanceApp.validApiKey,
      },
      payload: {
        endpoint: '/v1/chat/completions',
        method: 'POST',
        body: { prompt: 'hello' },
      },
    });

    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INSUFFICIENT_FUNDS');

    // Upstream provider was never called
    const alphaRequests = zeroBalanceApp.routingService.getMetricsTracker('provider_alpha')!.getSnapshot().totalRequests;
    expect(alphaRequests).toBe(0);
  });

  it('should capture settlement and deduct balance upon confirmed success', async () => {
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
    expect(res.headers['x-customer-charge']).toBeDefined();

    // Verify account balance via GET /v1/billing/account
    const accRes = await context.app.inject({
      method: 'GET',
      url: '/v1/billing/account',
      headers: { 'x-api-key': context.validApiKey },
    });

    expect(accRes.statusCode).toBe(200);
    const accData = JSON.parse(accRes.body).data;
    // Initial 5,000,000 - Alpha charge (0.001 * 1.5 = 0.001500 = 1500 micros) = 4,998,500 micros
    expect(accData.balanceMicros).toBe('4998500');
    expect(accData.reservedMicros).toBe('0');

    // Verify ledger history via GET /v1/billing/ledger
    const ledgerRes = await context.app.inject({
      method: 'GET',
      url: '/v1/billing/ledger',
      headers: { 'x-api-key': context.validApiKey },
    });

    const ledgerEntries = JSON.parse(ledgerRes.body).data;
    expect(ledgerEntries.length).toBeGreaterThanOrEqual(3); // Seed deposit + HOLD + CAPTURE
    const captureEntry = ledgerEntries.find((e: any) => e.type === 'CAPTURE');
    expect(captureEntry).toBeDefined();
    expect(captureEntry.amountMicros).toBe('1500');
  });

  it('should release reservation on confirmed upstream failure and charge customer $0', async () => {
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

    expect(res.statusCode).toBe(503);

    // Verify account balance is unchanged
    const accRes = await context.app.inject({
      method: 'GET',
      url: '/v1/billing/account',
      headers: { 'x-api-key': context.validApiKey },
    });

    const accData = JSON.parse(accRes.body).data;
    expect(accData.balanceMicros).toBe('5000000'); // Zero dollars charged
    expect(accData.reservedMicros).toBe('0');       // Hold released cleanly

    // Verify ledger records RELEASE
    const ledgerRes = await context.app.inject({
      method: 'GET',
      url: '/v1/billing/ledger',
      headers: { 'x-api-key': context.validApiKey },
    });

    const ledgerEntries = JSON.parse(ledgerRes.body).data;
    const releaseEntry = ledgerEntries.find((e: any) => e.type === 'RELEASE');
    expect(releaseEntry).toBeDefined();
  });

  it('should support Idempotency-Key header and prevent double charging on duplicate request', async () => {
    const idempotencyKey = 'client_idem_req_abc_123';
    const payload = {
      endpoint: '/v1/chat/completions',
      method: 'POST',
      body: { prompt: 'generate summary' },
    };

    // 1st attempt
    const res1 = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });

    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.meta.cached).toBe(false);

    // Balance after 1st attempt: 5,000,000 - 1500 = 4,998,500
    const acc1 = await context.billingRepo.getAccount(context.orgId);
    expect(acc1?.balanceMicros).toBe(4998500n);

    // 2nd attempt with identical key and payload
    const res2 = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });

    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.meta.cached).toBe(true); // Replay from database
    expect(body2.data.id).toBe(body1.data.id); // Exactly same response returned

    // Customer balance was NOT charged a second time!
    const acc2 = await context.billingRepo.getAccount(context.orgId);
    expect(acc2?.balanceMicros).toBe(4998500n);
  });

  it('should reject reused idempotency key with different payload with 422 Unprocessable Entity', async () => {
    const idempotencyKey = 'client_idem_mismatch_test';

    // 1st request
    await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        endpoint: '/v1/test',
        method: 'POST',
        body: { query: 'first payload' },
      },
    });

    // 2nd request with SAME key but DIFFERENT payload
    const res2 = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        endpoint: '/v1/test',
        method: 'POST',
        body: { query: 'different payload' },
      },
    });

    expect(res2.statusCode).toBe(422);
    const body = JSON.parse(res2.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
  });

  it('should retain reservation on ambiguous upstream timeout and prevent double spending', async () => {
    context.providerAlpha.setFailureConfig({ simulateTimeout: true });
    context.providerBeta.setFailureConfig({ simulateTimeout: true });

    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
        'idempotency-key': 'idem_ambiguous_1',
      },
      payload: {
        endpoint: '/v1/test',
        method: 'POST',
        timeoutMs: 30,
      },
    });

    // Gateway returns 504 with ambiguous timeout
    expect(res.statusCode).toBe(504);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('AMBIGUOUS_TIMEOUT');

    // Hold is RETAINED!
    const acc = await context.billingRepo.getAccount(context.orgId);
    expect(acc?.reservedMicros).toBeGreaterThan(0n);

    // Repeating the same key while state is AMBIGUOUS returns 409 Conflict
    const resRepeat = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
        'idempotency-key': 'idem_ambiguous_1',
      },
      payload: {
        endpoint: '/v1/test',
        method: 'POST',
      },
    });

    expect(resRepeat.statusCode).toBe(409);
    expect(JSON.parse(resRepeat.body).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('should prevent overspending across high-concurrency requests and maintain solvency invariant', async () => {
    // Seed account with enough funds for exactly 3 reservations (e.g. 13,500 micros, where hold is 4500 micros)
    const limitedApp = await createTestApp({
      initialBalanceMicros: 13_500n,
    });

    // Fire 10 concurrent requests
    const promises = Array.from({ length: 10 }).map((_, i) =>
      limitedApp.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: {
          'x-api-key': limitedApp.validApiKey,
          'idempotency-key': `concurrent_req_${i}`,
        },
        payload: {
          endpoint: '/v1/test',
          method: 'POST',
          body: { index: i },
        },
      })
    );

    const responses = await Promise.all(promises);
    const successCount = responses.filter((r) => r.statusCode === 200).length;
    const paymentRequiredCount = responses.filter((r) => r.statusCode === 402).length;

    // Exactly 3 should succeed, 7 should be rejected with 402 Insufficient Funds
    expect(successCount).toBe(3);
    expect(paymentRequiredCount).toBe(7);

    // Final balance must be non-negative and consistent
    const finalAccount = await limitedApp.billingRepo.getAccount(limitedApp.orgId);
    expect(finalAccount!.balanceMicros).toBeGreaterThanOrEqual(0n);
    expect(finalAccount!.reservedMicros).toBe(0n);
  });
});
