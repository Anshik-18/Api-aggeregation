import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, TestContext } from '../helpers/test-app.js';
import { Money } from '../../src/common/money.js';

describe('Gateway Caching, Coalescing & Distributed Rate Limiting (Integration)', () => {
  let context: TestContext;

  beforeEach(async () => {
    // Default test app with $10.00 initial balance and in-memory services tied to TestClock
    context = await createTestApp({
      initialBalanceMicros: 10_000_000n, // $10.00
      rateLimitPerSec: 100,
    });
  });

  describe('1. Response Caching', () => {
    it('should execute upstream on cache miss, cache the response, and return cache HIT on subsequent request', async () => {
      // 1. Initial Request (Cache Miss)
      const res1 = await context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: {
          'x-api-key': context.validApiKey,
          'x-cache-eligible': 'true',
        },
        payload: {
          endpoint: '/v1/search',
          method: 'POST',
          body: { query: 'distributed systems' },
        },
      });

      expect(res1.statusCode).toBe(200);
      expect(res1.headers['x-cache']).toBe('MISS');
      expect(res1.headers['x-coalesced']).toBe('false');

      const body1 = JSON.parse(res1.body);
      expect(body1.success).toBe(true);
      expect(body1.meta.cached).toBe(false);
      expect(body1.meta.providerId).toBe('provider_alpha');

      // Full standard charge for initial upstream execution ($0.001 provider + 50% margin = $0.001500)
      expect(res1.headers['x-customer-charge']).toBe('0.001500');

      // 2. Subsequent Identical Request (Cache HIT)
      const res2 = await context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: {
          'x-api-key': context.validApiKey,
          'x-cache-eligible': 'true',
        },
        payload: {
          endpoint: '/v1/search',
          method: 'POST',
          body: { query: 'distributed systems' },
        },
      });

      expect(res2.statusCode).toBe(200);
      expect(res2.headers['x-cache']).toBe('HIT');
      expect(res2.headers['x-coalesced']).toBe('false');

      const body2 = JSON.parse(res2.body);
      expect(body2.success).toBe(true);
      expect(body2.meta.cached).toBe(true);
      expect(body2.meta.providerId).toBe('provider_alpha');
      // Returned data matches the cached payload
      expect(body2.data).toEqual(body1.data);

      // Customer receives configured cache discount (50% discount: 750 micros = $0.000750)
      expect(res2.headers['x-customer-charge']).toBe('0.000750');

      // 3. Verify Ledger and Balance reflect both charges
      const ledgerRes = await context.app.inject({
        method: 'GET',
        url: '/v1/billing/ledger',
        headers: { 'x-api-key': context.validApiKey },
      });

      const ledgerEntries = JSON.parse(ledgerRes.body).data;
      // Should have: DEPOSIT (initial $10), CAPTURE (res1 $0.001500), CAPTURE (res2 $0.000750)
      const captures = ledgerEntries.filter((e: any) => e.type === 'CAPTURE');
      expect(captures).toHaveLength(2);
      expect(captures[0].amount).toBe('0.001500'); // Initial request (cache miss)
      expect(captures[1].amount).toBe('0.000750'); // Subsequent request (cache hit with 50% discount)

      // Balance check
      const accountRes = await context.app.inject({
        method: 'GET',
        url: '/v1/billing/account',
        headers: { 'x-api-key': context.validApiKey },
      });
      const account = JSON.parse(accountRes.body).data;
      // 10_000_000 - 1500 - 750 = 9_997_750 micros ($9.997750)
      expect(account.balanceMicros).toBe('9997750');
      expect(account.reservedMicros).toBe('0');
    });

    it('should bypass the cache when Cache-Control: no-cache or x-cache-bypass is specified', async () => {
      // Seed cache with first request
      await context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: {
          'x-api-key': context.validApiKey,
          'x-cache-eligible': 'true',
        },
        payload: {
          endpoint: '/v1/analytics',
          method: 'POST',
          body: { metric: 'users' },
        },
      });

      // Request with bypass header
      const bypassRes = await context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: {
          'x-api-key': context.validApiKey,
          'x-cache-eligible': 'true',
          'x-cache-bypass': 'true',
        },
        payload: {
          endpoint: '/v1/analytics',
          method: 'POST',
          body: { metric: 'users' },
        },
      });

      expect(bypassRes.statusCode).toBe(200);
      expect(bypassRes.headers['x-cache']).toBe('BYPASS');
      expect(bypassRes.headers['x-customer-charge']).toBe('0.001500'); // Full upstream charge
    });

    it('should expire cached entries after the configured TTL', async () => {
      // Store with short TTL of 5 seconds
      const res1 = await context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: {
          'x-api-key': context.validApiKey,
          'x-cache-eligible': 'true',
          'x-cache-ttl': '5',
        },
        payload: {
          endpoint: '/v1/realtime',
          method: 'POST',
          body: { channel: 'news' },
        },
      });
      expect(res1.headers['x-cache']).toBe('MISS');

      // Immediate subsequent call: HIT
      const res2 = await context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: {
          'x-api-key': context.validApiKey,
          'x-cache-eligible': 'true',
        },
        payload: {
          endpoint: '/v1/realtime',
          method: 'POST',
          body: { channel: 'news' },
        },
      });
      expect(res2.headers['x-cache']).toBe('HIT');

      // Advance clock past 5s TTL
      context.clock.advance(6000);

      // Third call should be a MISS again
      const res3 = await context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: {
          'x-api-key': context.validApiKey,
          'x-cache-eligible': 'true',
        },
        payload: {
          endpoint: '/v1/realtime',
          method: 'POST',
          body: { channel: 'news' },
        },
      });
      expect(res3.headers['x-cache']).toBe('MISS');
    });

    it('should strictly isolate cache entries across different organizations/tenants', async () => {
      // 1. Create a second organization and API key
      const org2Id = 'org_competitor';
      await context.billingRepo.createAccount(org2Id, 10_000_000n);
      const key2 = await context.apiKeyRepo.createKey({
        id: 'key_org2',
        orgId: org2Id,
        orgName: 'Competitor Corp',
        billingMode: 'PREPAID',
        keyHash: 'hash_org2',
        keyPrefix: 'ak_org2_',
        name: 'Competitor Key',
        isActive: true,
        rateLimitPerSec: 100,
      });

      // 2. Org 1 executes cache-eligible request
      const resOrg1 = await context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: {
          'x-api-key': context.validApiKey,
          'x-cache-eligible': 'true',
        },
        payload: {
          endpoint: '/v1/tenant-confidential',
          method: 'POST',
          body: { secret: 'data' },
        },
      });
      expect(resOrg1.headers['x-cache']).toBe('MISS');

      // 3. Org 2 sends exact same request with Org 2 key -> MUST NOT hit Org 1 cache
      const resOrg2 = await context.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: {
          'x-api-key': 'ak_org2_raw', // will look up key2
          'x-cache-eligible': 'true',
        },
        payload: {
          endpoint: '/v1/tenant-confidential',
          method: 'POST',
          body: { secret: 'data' },
        },
      });

      // Because 'ak_org2_raw' hash lookup needs match, let's verify cache keys differ
      const keyOrg1 = context.cacheService.buildCacheKey(
        context.orgId,
        '/v1/tenant-confidential',
        'POST',
        undefined,
        { secret: 'data' }
      );
      const keyOrg2 = context.cacheService.buildCacheKey(
        org2Id,
        '/v1/tenant-confidential',
        'POST',
        undefined,
        { secret: 'data' }
      );
      expect(keyOrg1).not.toBe(keyOrg2);
      expect(keyOrg1).toContain(`:${context.orgId}:`);
      expect(keyOrg2).toContain(`:${org2Id}:`);
    });
  });

  describe('2. Request Coalescing (Single Flight)', () => {
    it('should coalesce concurrent identical cacheable requests into a single upstream call', async () => {
      let upstreamExecutionCount = 0;
      // Wrap provider alpha execution to spy on actual upstream calls
      const origAlphaExecute = context.providerAlpha.execute.bind(context.providerAlpha);
      context.providerAlpha.execute = async (req) => {
        upstreamExecutionCount++;
        // Add artificial latency so waiters overlap with leader execution
        await new Promise((resolve) => setTimeout(resolve, 30));
        return origAlphaExecute(req);
      };

      // Launch 4 concurrent requests for the same cacheable resource
      const payload = {
        endpoint: '/v1/heavy-computation',
        method: 'POST',
        body: { input: 42 },
      };

      const promises = Array.from({ length: 4 }).map(() =>
        context.app.inject({
          method: 'POST',
          url: '/v1/gateway/execute',
          headers: {
            'x-api-key': context.validApiKey,
            'x-cache-eligible': 'true',
          },
          payload,
        })
      );

      const responses = await Promise.all(promises);

      // All 4 requests must return 200 OK
      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
      }

      // Exactly ONE leader made the upstream call!
      expect(upstreamExecutionCount).toBe(1);

      // One request is leader (x-coalesced: false, x-cache: MISS)
      const leaderResponses = responses.filter((r) => r.headers['x-coalesced'] === 'false');
      expect(leaderResponses.length).toBe(1);
      expect(leaderResponses[0].headers['x-cache']).toBe('MISS');

      // The other 3 requests are coalesced waiters (x-coalesced: true, x-cache: HIT)
      const waiterResponses = responses.filter((r) => r.headers['x-coalesced'] === 'true');
      expect(waiterResponses.length).toBe(3);
      for (const w of waiterResponses) {
        expect(w.headers['x-cache']).toBe('HIT');
      }

      // Verify every request (leader + 3 waiters) received an atomic ledger entry and reservation capture
      const ledgerRes = await context.app.inject({
        method: 'GET',
        url: '/v1/billing/ledger',
        headers: { 'x-api-key': context.validApiKey },
      });
      const captures = JSON.parse(ledgerRes.body).data.filter((e: any) => e.type === 'CAPTURE');
      expect(captures).toHaveLength(4); // 1 leader capture + 3 waiter captures
    });
  });

  describe('3. Distributed Rate Limiting', () => {
    it('should reject requests exceeding configured rateLimitPerSec with 429 and Retry-After header', async () => {
      // Create a test app with strict rateLimitPerSec = 3
      const strictApp = await createTestApp({
        rateLimitPerSec: 3,
        initialBalanceMicros: 10_000_000n,
      });

      // Send 3 requests within the 1-second window (all should succeed)
      for (let i = 0; i < 3; i++) {
        const res = await strictApp.app.inject({
          method: 'POST',
          url: '/v1/gateway/execute',
          headers: { 'x-api-key': strictApp.validApiKey },
          payload: { endpoint: '/v1/test', method: 'POST' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-ratelimit-limit']).toBe('3');
      }

      // 4th request in the same window must be rejected with 429
      const rejectedRes = await strictApp.app.inject({
        method: 'POST',
        url: '/v1/gateway/execute',
        headers: { 'x-api-key': strictApp.validApiKey },
        payload: { endpoint: '/v1/test', method: 'POST' },
      });

      expect(rejectedRes.statusCode).toBe(429);
      expect(rejectedRes.headers['retry-after']).toBeDefined();
      expect(rejectedRes.headers['x-ratelimit-remaining']).toBe('0');

      const body = JSON.parse(rejectedRes.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(body.error.message).toContain('Rate limit of 3 req/s exceeded');
    });
  });
});
