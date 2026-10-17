export interface AuthenticatedClient {
  orgId: string;
  keyId: string;
  name: string;
  billingMode: 'PREPAID' | 'POSTPAID';
  rateLimitPerSec: number;
  rateLimitWindowMs?: number;
  pricingMultiplierPercent?: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    requestId: string;
    providerId?: string;
    latencyMs?: number;
    cached?: boolean;
    cacheStatus?: string;
    coalesced?: boolean;
    customerCharge?: string;
    customerChargeMicros?: string;
    pricingMultiplierPercent?: number;
    discountApplied?: boolean;
    timestamp: string;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    client?: AuthenticatedClient;
    id: string;
  }
}
