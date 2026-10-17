export interface NormalizedRequest {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface NormalizedResponse {
  providerId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  latencyMs: number;
  cost: number;
}

export interface ValidationResult {
  isValid: boolean;
  errorReason?: string;
}

export interface ProviderHealthStatus {
  isHealthy: boolean;
  consecutiveFailures: number;
  lastCheckedAt: Date;
  latencyMs: number;
}

export interface UpstreamProvider {
  readonly id: string;
  readonly name: string;
  readonly costPerUnit: number;
  readonly baselineLatencyMs: number;
  readonly timeoutMs: number;
  readonly maxConcurrency: number;

  execute(request: NormalizedRequest): Promise<NormalizedResponse>;
  validateResponse(body: unknown, statusCode: number): ValidationResult;
  isRetryableError(error: Error): boolean;
  getHealth(): Promise<ProviderHealthStatus>;
}
