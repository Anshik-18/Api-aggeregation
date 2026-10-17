import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker, CircuitState } from '../../src/modules/routing/circuit-breaker.js';
import { TestClock } from '../../src/common/clock.js';

describe('CircuitBreaker (Unit)', () => {
  let clock: TestClock;
  let cb: CircuitBreaker;

  beforeEach(() => {
    clock = new TestClock(1000000);
    cb = new CircuitBreaker(
      'provider_test',
      {
        failureThreshold: 3,
        cooldownPeriodMs: 5000,
        errorRateThreshold: 0.5,
        minRequestsForErrorRate: 4,
        halfOpenSuccessThreshold: 1,
      },
      clock
    );
  });

  it('should start in CLOSED state and allow execution', () => {
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.canExecute()).toBe(true);
  });

  it('should open the circuit after reaching the consecutive failure threshold', () => {
    cb.onFailure(false);
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.canExecute()).toBe(true);

    cb.onFailure(false);
    expect(cb.getState()).toBe(CircuitState.CLOSED);

    // 3rd failure trips the circuit
    cb.onFailure(false);
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.canExecute()).toBe(false);
  });

  it('should NOT open the circuit for client errors (4xx)', () => {
    cb.onFailure(true);
    cb.onFailure(true);
    cb.onFailure(true);
    cb.onFailure(true);

    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.canExecute()).toBe(true);
  });

  it('should transition to HALF_OPEN after cooldown and allow exactly one probe', () => {
    // Trip the circuit
    cb.onFailure(false);
    cb.onFailure(false);
    cb.onFailure(false);
    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Before cooldown expires
    clock.advance(4999);
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.canExecute()).toBe(false);

    // Cooldown elapsed!
    clock.advance(2); // total 5001ms
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

    // First request is allowed as probe
    expect(cb.canExecute()).toBe(true);

    // Subsequent concurrent requests before probe resolves are rejected
    expect(cb.canExecute()).toBe(false);
  });

  it('should close the circuit when the HALF_OPEN probe succeeds', () => {
    // Trip circuit
    cb.onFailure(false);
    cb.onFailure(false);
    cb.onFailure(false);
    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Advance past cooldown
    clock.advance(5000);
    expect(cb.canExecute()).toBe(true); // Probe dispatched

    // Probe succeeds
    cb.onSuccess();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.canExecute()).toBe(true);
  });

  it('should re-open the circuit with a fresh cooldown when the HALF_OPEN probe fails', () => {
    // Trip circuit
    cb.onFailure(false);
    cb.onFailure(false);
    cb.onFailure(false);

    clock.advance(5000);
    expect(cb.canExecute()).toBe(true); // Probe dispatched

    // Probe fails!
    cb.onFailure(false);
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.canExecute()).toBe(false);

    // Fresh 5000ms cooldown required
    clock.advance(3000);
    expect(cb.canExecute()).toBe(false);

    clock.advance(2001);
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
    expect(cb.canExecute()).toBe(true);
  });

  it('should trip based on rolling error rate threshold when sample size is sufficient', () => {
    // 2 successes, 2 failures = 50% error rate with 4 samples
    cb.onSuccess();
    cb.onSuccess();
    cb.onFailure(false, 0.33, 3);
    expect(cb.getState()).toBe(CircuitState.CLOSED);

    // 4th sample with 50% error rate
    cb.onFailure(false, 0.5, 4);
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });
});
