import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderMetricsTracker } from '../../src/modules/routing/provider-metrics.js';
import { TestClock } from '../../src/common/clock.js';

describe('ProviderMetricsTracker (Unit)', () => {
  let clock: TestClock;
  let tracker: ProviderMetricsTracker;

  beforeEach(() => {
    clock = new TestClock(1000000);
    tracker = new ProviderMetricsTracker('provider_test', 3, 60000, clock);
  });

  it('should enforce concurrency limits', () => {
    expect(tracker.acquireConcurrency()).toBe(true);
    expect(tracker.acquireConcurrency()).toBe(true);
    expect(tracker.acquireConcurrency()).toBe(true);

    // 4th request exceeds maxConcurrency of 3
    expect(tracker.acquireConcurrency()).toBe(false);
    expect(tracker.getActiveConcurrency()).toBe(3);

    tracker.releaseConcurrency();
    expect(tracker.getActiveConcurrency()).toBe(2);
    expect(tracker.acquireConcurrency()).toBe(true);
  });

  it('should calculate EWMA latency accurately', () => {
    tracker.recordSuccess(100);
    expect(tracker.getSnapshot().ewmaLatencyMs).toBe(100);

    // alpha = 0.2: 0.2 * 50 + 0.8 * 100 = 10 + 80 = 90
    tracker.recordSuccess(50);
    expect(tracker.getSnapshot().ewmaLatencyMs).toBe(90);
  });

  it('should calculate rolling error rate and prune expired samples', () => {
    tracker.recordSuccess(50);
    tracker.recordFailure(500, 50, false);

    let snapshot = tracker.getSnapshot();
    expect(snapshot.rollingRequests).toBe(2);
    expect(snapshot.rollingFailures).toBe(1);
    expect(snapshot.rollingErrorRate).toBe(0.5);

    // Advance clock past the 60-second window
    clock.advance(60001);

    // Record one new successful request
    tracker.recordSuccess(40);

    snapshot = tracker.getSnapshot();
    // Old samples expired
    expect(snapshot.rollingRequests).toBe(1);
    expect(snapshot.rollingFailures).toBe(0);
    expect(snapshot.rollingErrorRate).toBe(0);
    expect(snapshot.totalRequests).toBe(3); // Totals are cumulative
  });

  it('should NOT count client errors (4xx) as provider failures', () => {
    tracker.recordSuccess(20);
    tracker.recordFailure(400, 10, true); // Client error
    tracker.recordFailure(404, 10, true); // Client error

    const snapshot = tracker.getSnapshot();
    expect(snapshot.totalRequests).toBe(1); // Only 1 upstream request
    expect(snapshot.totalFailures).toBe(0); // 0 provider failures
    expect(snapshot.totalClientErrors).toBe(2);
    expect(snapshot.rollingErrorRate).toBe(0);
  });

  it('should correctly handle concurrent async acquisition and release', async () => {
    const promises = Array.from({ length: 10 }).map(async () => {
      const acquired = tracker.acquireConcurrency();
      if (acquired) {
        tracker.recordSuccess(10);
        tracker.releaseConcurrency();
      }
      return acquired;
    });

    const results = await Promise.all(promises);
    const successfulAcquisitions = results.filter(Boolean).length;

    expect(successfulAcquisitions).toBeGreaterThan(0);
    expect(tracker.getActiveConcurrency()).toBe(0);
    expect(tracker.getSnapshot().totalSuccesses).toBe(successfulAcquisitions);
  });
});
