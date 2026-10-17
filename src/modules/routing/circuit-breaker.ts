import { Clock, SystemClock } from '../../common/clock.js';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  failureThreshold?: number;       // Number of consecutive failures to open circuit
  cooldownPeriodMs?: number;       // Cooldown duration before attempting HALF_OPEN probe
  errorRateThreshold?: number;     // Rolling error rate threshold (e.g., 0.5 for 50%)
  minRequestsForErrorRate?: number;// Minimum samples before checking error rate
  halfOpenSuccessThreshold?: number; // Successful probes needed to close circuit
}

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
  cooldownPeriodMs: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private halfOpenSuccesses = 0;
  private probeInFlight = false;

  private readonly failureThreshold: number;
  private readonly cooldownPeriodMs: number;
  private readonly errorRateThreshold: number;
  private readonly minRequestsForErrorRate: number;
  private readonly halfOpenSuccessThreshold: number;

  constructor(
    public readonly providerId: string,
    config: CircuitBreakerConfig = {},
    private readonly clock: Clock = new SystemClock()
  ) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.cooldownPeriodMs = config.cooldownPeriodMs ?? 10000;
    this.errorRateThreshold = config.errorRateThreshold ?? 0.5;
    this.minRequestsForErrorRate = config.minRequestsForErrorRate ?? 5;
    this.halfOpenSuccessThreshold = config.halfOpenSuccessThreshold ?? 1;
  }

  /**
   * Determines if a request should be allowed through to the provider.
   * If in OPEN state and cooldown has elapsed, transitions to HALF_OPEN and allows 1 probe.
   */
  public canExecute(): boolean {
    const currentState = this.getState();

    switch (currentState) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.HALF_OPEN:
        if (!this.probeInFlight) {
          this.probeInFlight = true;
          return true;
        }
        return false;

      case CircuitState.OPEN:
        return false;
    }
  }

  public onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenSuccesses++;
      this.probeInFlight = false;

      if (this.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
        this.transitionTo(CircuitState.CLOSED);
        this.consecutiveFailures = 0;
        this.halfOpenSuccesses = 0;
      }
    } else if (this.state === CircuitState.CLOSED) {
      this.consecutiveFailures = 0;
    }
  }

  public onFailure(
    isClientError = false,
    rollingErrorRate?: number,
    rollingRequests?: number
  ): void {
    if (isClientError) {
      // Client errors (4xx) MUST NOT count against the circuit breaker
      return;
    }

    if (this.state === CircuitState.HALF_OPEN) {
      // A probe failure immediately re-opens the circuit with a fresh cooldown
      this.probeInFlight = false;
      this.halfOpenSuccesses = 0;
      this.transitionTo(CircuitState.OPEN);
      return;
    }

    if (this.state === CircuitState.CLOSED) {
      this.consecutiveFailures++;

      const isConsecutiveTrip = this.consecutiveFailures >= this.failureThreshold;
      const isErrorRateTrip =
        rollingRequests !== undefined &&
        rollingRequests >= this.minRequestsForErrorRate &&
        rollingErrorRate !== undefined &&
        rollingErrorRate >= this.errorRateThreshold;

      if (isConsecutiveTrip || isErrorRateTrip) {
        this.transitionTo(CircuitState.OPEN);
      }
    }
  }

  public getState(): CircuitState {
    if (this.state === CircuitState.OPEN && this.openedAt !== null) {
      const elapsed = this.clock.now() - this.openedAt;
      if (elapsed >= this.cooldownPeriodMs) {
        this.transitionTo(CircuitState.HALF_OPEN);
      }
    }
    return this.state;
  }

  private transitionTo(newState: CircuitState): void {
    this.state = newState;
    if (newState === CircuitState.OPEN) {
      this.openedAt = this.clock.now();
      this.probeInFlight = false;
    } else if (newState === CircuitState.CLOSED) {
      this.openedAt = null;
      this.probeInFlight = false;
    }
  }

  public getSnapshot(): CircuitBreakerSnapshot {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      cooldownPeriodMs: this.cooldownPeriodMs,
    };
  }

  public reset(): void {
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.halfOpenSuccesses = 0;
    this.probeInFlight = false;
  }
}
