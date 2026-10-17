export interface HealthResponse {
  status: 'healthy' | 'degraded';
  timestamp: string;
  components: {
    database: { isHealthy: boolean; latencyMs?: number; error?: string };
    redis: { isHealthy: boolean; latencyMs?: number; error?: string };
  };
}

export interface AccountData {
  orgId: string;
  currency: string;
  balance: string;
  reservedBalance: string;
  availableBalance: string;
  balanceMicros: string;
  reservedMicros: string;
  availableMicros: string;
}

export interface CircuitBreakerSnapshot {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  consecutiveFailures: number;
  openedAt: number | null;
  cooldownPeriodMs: number;
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
  rollingErrorRate: number;
  ewmaLatencyMs: number;
}

export interface ProviderStatus {
  id: string;
  name: string;
  costPerUnit: number;
  baselineLatencyMs: number;
  maxConcurrency: number;
  circuitBreaker: CircuitBreakerSnapshot | null;
  metrics: ProviderMetricsSnapshot | null;
}

export type LedgerEntryType = 'DEPOSIT' | 'HOLD' | 'CAPTURE' | 'RELEASE' | 'REFUND';

export interface LedgerEntry {
  id: string;
  requestId: string | null;
  idempotencyKey: string | null;
  type: LedgerEntryType;
  amount: string;
  amountMicros: string;
  balanceAfter: string;
  reservedAfter: string;
  description: string;
  createdAt: string;
}

export interface ExecuteRequestOptions {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  cacheEligible?: boolean;
  cacheBypass?: boolean;
  cacheTtlSeconds?: number;
  preferredProviderId?: string;
  idempotencyKey?: string;
}

export interface ExecuteResult {
  statusCode: number;
  ok: boolean;
  body: any;
  headers: Record<string, string>;
  meta: {
    requestId?: string;
    providerId?: string;
    latencyMs?: number;
    cached?: boolean;
    coalesced?: boolean;
    timestamp?: string;
    customerCharge?: string;
    cacheHeader?: string;
  };
  durationMs: number;
}

export interface ApiKeyPreset {
  label: string;
  key: string;
  description: string;
  badge: string;
}

export const DEMO_API_KEYS: ApiKeyPreset[] = [
  {
    label: 'Acme Corp (Standard 1.5x)',
    key: 'ak_live_acme_super_secret_key_456',
    description: '$25.00 Balance - 1.5x markup ($0.001500)',
    badge: 'Standard (1.5x)',
  },
  {
    label: 'VIP Enterprise (1.1x Tier)',
    key: 'ak_live_vip_enterprise_key_888',
    description: '$25.00 Balance - 1.1x volume tier ($0.001100)',
    badge: 'VIP (1.1x)',
  },
  {
    label: 'Premium Retail (2.0x Tier)',
    key: 'ak_live_premium_retail_key_777',
    description: '$25.00 Balance - 2.0x retail tier ($0.002000)',
    badge: 'Retail (2.0x)',
  },
  {
    label: 'Rate-Limited Key (2 req/4s)',
    key: 'ak_live_rate_limited_key_123',
    description: '2 req per 4s limit - Tests 429 Too Many Requests',
    badge: 'Rate Limit (2/4s)',
  },
  {
    label: 'Broke Customer (Unfunded)',
    key: 'ak_live_broke_customer_no_funds_999',
    description: '$0.00 Balance - Tests 402 Payment Required',
    badge: 'Zero Funds ($0)',
  },
];
