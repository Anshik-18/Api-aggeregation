import {
  UpstreamProvider,
  NormalizedRequest,
  NormalizedResponse,
  ValidationResult,
  ProviderHealthStatus,
} from '../provider.interface.js';
import {
  UpstreamProviderError,
  UpstreamTimeoutError,
} from '../../../common/errors.js';

export interface MockProviderConfig {
  id: string;
  name: string;
  costPerUnit: number;
  baselineLatencyMs: number;
  timeoutMs?: number;
  maxConcurrency?: number;
}

export interface FailureSimulationConfig {
  simulateStatusCode?: number;
  simulateTimeout?: boolean;
  simulateMalformedResponse?: boolean;
  simulateConnectionDrop?: boolean;
  failureRate?: number; // 0.0 to 1.0 probability of random failure
}

export class BaseMockProvider implements UpstreamProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly costPerUnit: number;
  public readonly baselineLatencyMs: number;
  public readonly timeoutMs: number;
  public readonly maxConcurrency: number;

  private failureConfig: FailureSimulationConfig = {};
  private consecutiveFailures = 0;
  private totalRequests = 0;

  constructor(config: MockProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.costPerUnit = config.costPerUnit;
    this.baselineLatencyMs = config.baselineLatencyMs;
    this.timeoutMs = config.timeoutMs ?? 3000;
    this.maxConcurrency = config.maxConcurrency ?? 100;
  }

  public setFailureConfig(config: FailureSimulationConfig): void {
    this.failureConfig = { ...config };
  }

  public resetFailureConfig(): void {
    this.failureConfig = {};
    this.consecutiveFailures = 0;
  }

  public async execute(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.totalRequests++;
    const start = Date.now();
    const effectiveTimeout = request.timeoutMs ?? this.timeoutMs;

    // 1. Check for simulated timeout
    if (this.failureConfig.simulateTimeout) {
      await this.sleep(effectiveTimeout + 20);
      this.consecutiveFailures++;
      throw new UpstreamTimeoutError(this.id, effectiveTimeout);
    }

    // 2. Check for simulated connection drop / socket error
    if (this.failureConfig.simulateConnectionDrop) {
      this.consecutiveFailures++;
      throw new UpstreamProviderError(
        this.id,
        'ECONNRESET: Connection dropped by peer',
        502,
        true // Retryable
      );
    }

    // 3. Check for probabilistic failure rate
    if (
      this.failureConfig.failureRate !== undefined &&
      Math.random() < this.failureConfig.failureRate
    ) {
      this.consecutiveFailures++;
      throw new UpstreamProviderError(
        this.id,
        'Simulated transient 503 Service Unavailable',
        503,
        true
      );
    }

    // 4. Check for simulated explicit HTTP status code
    if (this.failureConfig.simulateStatusCode && this.failureConfig.simulateStatusCode >= 400) {
      this.consecutiveFailures++;
      const isRetryable = [429, 502, 503, 504].includes(this.failureConfig.simulateStatusCode);
      throw new UpstreamProviderError(
        this.id,
        `Upstream returned HTTP ${this.failureConfig.simulateStatusCode}`,
        this.failureConfig.simulateStatusCode,
        isRetryable,
        { upstreamStatus: this.failureConfig.simulateStatusCode }
      );
    }

    // Simulate realistic processing latency (baseline +/- 10% jitter)
    const jitter = Math.floor(Math.random() * (this.baselineLatencyMs * 0.2)) - (this.baselineLatencyMs * 0.1);
    const latency = Math.max(5, this.baselineLatencyMs + jitter);
    await this.sleep(latency);

    // 5. Check for simulated malformed response (schema corruption)
    if (this.failureConfig.simulateMalformedResponse) {
      this.consecutiveFailures++;
      return {
        providerId: this.id,
        statusCode: 200, // Disguised as 200
        headers: { 'content-type': 'application/json' },
        body: { corrupt: true, error: 'upstream_internal_inconsistency' },
        latencyMs: Date.now() - start,
        cost: this.costPerUnit,
      };
    }

    // Success response
    this.consecutiveFailures = 0;
    const elapsed = Date.now() - start;

    return {
      providerId: this.id,
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'x-provider-id': this.id,
        'x-provider-cost': this.costPerUnit.toString(),
      },
      body: this.generateMockSuccessPayload(request),
      latencyMs: elapsed,
      cost: this.costPerUnit,
    };
  }

  public validateResponse(body: unknown, statusCode: number): ValidationResult {
    if (statusCode < 200 || statusCode >= 300) {
      return { isValid: false, errorReason: `HTTP status code is ${statusCode}` };
    }

    if (!body || typeof body !== 'object') {
      return { isValid: false, errorReason: 'Response payload is empty or not an object' };
    }

    // Check for corrupt or disguised error payloads
    const payload = body as Record<string, unknown>;
    if (payload.corrupt === true || payload.error !== undefined) {
      return { isValid: false, errorReason: `Malformed payload or semantic error: ${JSON.stringify(payload.error)}` };
    }

    if (!payload.result && !payload.id) {
      return { isValid: false, errorReason: 'Payload missing required result/id fields' };
    }

    return { isValid: true };
  }

  public isRetryableError(error: Error): boolean {
    if (error instanceof UpstreamProviderError) {
      return error.retryable;
    }
    return false;
  }

  public async getHealth(): Promise<ProviderHealthStatus> {
    return {
      isHealthy: this.consecutiveFailures < 3,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckedAt: new Date(),
      latencyMs: this.baselineLatencyMs,
    };
  }

  protected generateMockSuccessPayload(request: NormalizedRequest): unknown {
    return {
      id: `res_${this.id}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      provider: this.id,
      endpoint: request.endpoint,
      status: 'completed',
      result: {
        message: 'Request successfully fulfilled by upstream provider',
        echoInput: request.body ?? null,
      },
      usage: {
        units: 1,
        unitCost: this.costPerUnit,
      },
      timestamp: new Date().toISOString(),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
