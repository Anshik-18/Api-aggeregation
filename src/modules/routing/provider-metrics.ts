import { Clock, SystemClock } from '../../common/clock.js';

export interface MetricSample {
  timestamp: number;
  success: boolean;
  latencyMs: number;
  isClientError: boolean;
}

export interface ProviderMetricsSnapshot {
  providerId: string;
  activeConcurrency: number;
  maxConcurrency: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalClientErrors: number;
  rollingRequests: number;
  rollingFailures: number;
  rollingErrorRate: number; // 0.0 to 1.0
  ewmaLatencyMs: number;
}

export class ProviderMetricsTracker {
  private activeConcurrency = 0;
  private totalRequests = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private totalClientErrors = 0;
  private ewmaLatencyMs = 0;
  private samples: MetricSample[] = [];

  constructor(
    public readonly providerId: string,
    public readonly maxConcurrency: number,
    private readonly windowMs: number = 60000,
    private readonly clock: Clock = new SystemClock(),
    private readonly ewmaAlpha: number = 0.2
  ) {}

  /**
   * Attempts to acquire a concurrency slot. Returns false if provider capacity is saturated.
   */
  public acquireConcurrency(): boolean {
    if (this.activeConcurrency >= this.maxConcurrency) {
      return false;
    }
    this.activeConcurrency++;
    return true;
  }

  /**
   * Releases an acquired concurrency slot.
   */
  public releaseConcurrency(): void {
    if (this.activeConcurrency > 0) {
      this.activeConcurrency--;
    }
  }

  public getActiveConcurrency(): number {
    return this.activeConcurrency;
  }

  public recordSuccess(latencyMs: number): void {
    this.totalRequests++;
    this.totalSuccesses++;
    this.updateEwma(latencyMs);

    this.samples.push({
      timestamp: this.clock.now(),
      success: true,
      latencyMs,
      isClientError: false,
    });

    this.pruneExpiredSamples();
  }

  public recordFailure(_statusCode: number, latencyMs: number, isClientError: boolean): void {
    if (isClientError) {
      // Client errors (4xx) are tracked separately and do NOT count as provider health degradation
      this.totalClientErrors++;
      return;
    }

    this.totalRequests++;
    this.totalFailures++;
    this.updateEwma(latencyMs);

    this.samples.push({
      timestamp: this.clock.now(),
      success: false,
      latencyMs,
      isClientError: false,
    });

    this.pruneExpiredSamples();
  }

  private updateEwma(latencyMs: number): void {
    if (this.ewmaLatencyMs === 0) {
      this.ewmaLatencyMs = latencyMs;
    } else {
      this.ewmaLatencyMs = this.ewmaAlpha * latencyMs + (1 - this.ewmaAlpha) * this.ewmaLatencyMs;
    }
  }

  private pruneExpiredSamples(): void {
    const cutoff = this.clock.now() - this.windowMs;
    // Fast prune: samples are ordered chronologically
    while (this.samples.length > 0 && this.samples[0].timestamp < cutoff) {
      this.samples.shift();
    }
  }

  public getSnapshot(): ProviderMetricsSnapshot {
    this.pruneExpiredSamples();

    let rollingFailures = 0;
    for (const sample of this.samples) {
      if (!sample.success) {
        rollingFailures++;
      }
    }

    const rollingRequests = this.samples.length;
    const rollingErrorRate = rollingRequests > 0 ? rollingFailures / rollingRequests : 0;

    return {
      providerId: this.providerId,
      activeConcurrency: this.activeConcurrency,
      maxConcurrency: this.maxConcurrency,
      totalRequests: this.totalRequests,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      totalClientErrors: this.totalClientErrors,
      rollingRequests,
      rollingFailures,
      rollingErrorRate,
      ewmaLatencyMs: Math.round(this.ewmaLatencyMs * 100) / 100,
    };
  }

  public reset(): void {
    this.activeConcurrency = 0;
    this.totalRequests = 0;
    this.totalSuccesses = 0;
    this.totalFailures = 0;
    this.totalClientErrors = 0;
    this.ewmaLatencyMs = 0;
    this.samples = [];
  }
}
