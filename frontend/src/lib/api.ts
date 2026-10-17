import {
  HealthResponse,
  AccountData,
  ProviderStatus,
  LedgerEntry,
  ExecuteRequestOptions,
  ExecuteResult,
} from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

class ApiError extends Error {
  statusCode: number;
  code?: string;
  details?: unknown;

  constructor(message: string, statusCode: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
  if (!res.ok) {
    throw new ApiError(`Health check failed with status ${res.status}`, res.status);
  }
  return res.json();
}

export async function fetchAccount(apiKey: string): Promise<AccountData> {
  const res = await fetch(`${API_BASE}/v1/billing/account`, {
    headers: {
      'x-api-key': apiKey,
    },
    cache: 'no-store',
  });

  const body = await res.json();
  if (!res.ok) {
    throw new ApiError(
      body?.error?.message || 'Failed to fetch account balance',
      res.status,
      body?.error?.code,
      body?.error?.details
    );
  }

  return body.data;
}

export async function fetchProviders(apiKey: string): Promise<ProviderStatus[]> {
  const res = await fetch(`${API_BASE}/v1/gateway/providers`, {
    headers: {
      'x-api-key': apiKey,
    },
    cache: 'no-store',
  });

  const body = await res.json();
  if (!res.ok) {
    throw new ApiError(
      body?.error?.message || 'Failed to fetch providers',
      res.status,
      body?.error?.code
    );
  }

  return body.data;
}

export async function fetchLedger(apiKey: string): Promise<LedgerEntry[]> {
  const res = await fetch(`${API_BASE}/v1/billing/ledger`, {
    headers: {
      'x-api-key': apiKey,
    },
    cache: 'no-store',
  });

  const body = await res.json();
  if (!res.ok) {
    throw new ApiError(
      body?.error?.message || 'Failed to fetch ledger history',
      res.status,
      body?.error?.code
    );
  }

  return body.data;
}

export async function reconcileLeases(apiKey: string): Promise<{ reconciledCount: number; records: unknown[] }> {
  const res = await fetch(`${API_BASE}/v1/billing/reconcile`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
    cache: 'no-store',
  });

  const body = await res.json();
  if (!res.ok) {
    throw new ApiError(
      body?.error?.message || 'Reconciliation failed',
      res.status,
      body?.error?.code
    );
  }

  return body.data;
}

export async function executeGatewayRequest(
  apiKey: string,
  options: ExecuteRequestOptions
): Promise<ExecuteResult> {
  const start = performance.now();

  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (options.preferredProviderId && options.preferredProviderId !== 'auto') {
    headers['x-provider-preference'] = options.preferredProviderId;
  }

  if (options.idempotencyKey && options.idempotencyKey.trim().length > 0) {
    headers['idempotency-key'] = options.idempotencyKey.trim();
  }

  const payload: Record<string, unknown> = {
    endpoint: options.endpoint,
    method: options.method,
    body: options.body,
  };

  if (options.cacheEligible) {
    payload.cacheEligible = true;
  }
  if (options.cacheBypass) {
    payload.cacheBypass = true;
  }
  if (options.cacheTtlSeconds) {
    payload.cacheTtlSeconds = options.cacheTtlSeconds;
  }

  const res = await fetch(`${API_BASE}/v1/gateway/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    cache: 'no-store',
  });

  const durationMs = Math.round(performance.now() - start);

  // Extract response headers
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((val, key) => {
    responseHeaders[key] = val;
  });

  const customerCharge = res.headers.get('x-customer-charge') || undefined;
  const cacheHeader = res.headers.get('x-cache') || undefined;
  const coalescedHeader = res.headers.get('x-coalesced') || undefined;

  let body: any;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }

  return {
    statusCode: res.status,
    ok: res.ok,
    body,
    headers: responseHeaders,
    meta: {
      requestId: body?.meta?.requestId,
      providerId: body?.meta?.providerId,
      latencyMs: body?.meta?.latencyMs,
      cached: body?.meta?.cached ?? (cacheHeader === 'HIT'),
      coalesced: body?.meta?.coalesced ?? (coalescedHeader === 'true'),
      timestamp: body?.meta?.timestamp,
      customerCharge,
      cacheHeader,
    },
    durationMs,
  };
}
