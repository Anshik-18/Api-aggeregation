import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryCoalescingService } from '../../src/modules/caching/coalescing.service.js';
import { TestClock } from '../../src/common/clock.js';
import { CachedResponse } from '../../src/modules/caching/cache.types.js';

describe('InMemoryCoalescingService (Unit)', () => {
  let clock: TestClock;
  let coalescing: InMemoryCoalescingService;

  beforeEach(() => {
    clock = new TestClock(1000000);
    coalescing = new InMemoryCoalescingService(clock);
  });

  it('should elect the first request as leader', async () => {
    const res = await coalescing.executeCoalesced('key_1', 1000, async () => null);
    expect(res.isLeader).toBe(true);
  });

  it('should notify waiters when leader completes successfully', async () => {
    const sampleResponse: CachedResponse = {
      statusCode: 200,
      headers: {},
      body: { data: 'coalesced_val' },
      providerId: 'provider_alpha',
      originalCost: 0.001,
      cachedAt: new Date(clock.now()).toISOString(),
      ttlSeconds: 60,
    };

    // 1. Leader acquires lock
    const leaderPromise = coalescing.executeCoalesced('key_shared', 1000, async () => null);
    const leaderRes = await leaderPromise;
    expect(leaderRes.isLeader).toBe(true);

    // 2. Waiter starts waiting
    const waiterPromise = coalescing.executeCoalesced('key_shared', 1000, async () => null);

    // 3. Leader publishes success
    await coalescing.publishSuccess('key_shared', sampleResponse);
    await coalescing.releaseLock('key_shared');

    // 4. Waiter receives the coalesced response
    const waiterRes = await waiterPromise;
    expect(waiterRes.isLeader).toBe(false);
    expect(waiterRes.cachedResponse).toEqual(sampleResponse);
  });

  it('should handle leader failure gracefully and release waiter without hanging', async () => {
    // 1. Leader acquires lock
    const leaderRes = await coalescing.executeCoalesced('key_failed', 1000, async () => null);
    expect(leaderRes.isLeader).toBe(true);

    // 2. Waiter starts waiting
    const waiterPromise = coalescing.executeCoalesced('key_failed', 1000, async () => null);

    // 3. Leader publishes failure
    await coalescing.publishFailure('key_failed');
    await coalescing.releaseLock('key_failed');

    // 4. Waiter receives notification, checks cache (empty), returns undefined to trigger fallthrough
    const waiterRes = await waiterPromise;
    expect(waiterRes.isLeader).toBe(false);
    expect(waiterRes.cachedResponse).toBeUndefined();
  });

  it('should recover when waiter times out and check cache', async () => {
    // 1. Leader acquires lock with short timeout
    const leaderRes = await coalescing.executeCoalesced('key_timeout', 100, async () => null);
    expect(leaderRes.isLeader).toBe(true);

    // 2. Waiter waits
    let cacheChecked = false;
    const waiterPromise = coalescing.executeCoalesced('key_timeout', 50, async () => {
      cacheChecked = true;
      return null;
    });

    // 3. Waiter times out
    const waiterRes = await waiterPromise;
    expect(waiterRes.isLeader).toBe(false);
    expect(waiterRes.cachedResponse).toBeUndefined();
    expect(cacheChecked).toBe(true);
  });
});
