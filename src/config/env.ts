import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // PostgreSQL
  DATABASE_URL: z.string().url().default('postgresql://gateway_user:gateway_secret@localhost:5432/api_gateway'),
  
  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Mock Providers Configuration
  MOCK_PROVIDER_ALPHA_LATENCY_MS: z.coerce.number().int().nonnegative().default(80),
  MOCK_PROVIDER_ALPHA_PRICE: z.coerce.number().positive().default(0.001000),
  MOCK_PROVIDER_ALPHA_FAIL_RATE: z.coerce.number().min(0).max(1).default(0.0),

  MOCK_PROVIDER_BETA_LATENCY_MS: z.coerce.number().int().nonnegative().default(30),
  MOCK_PROVIDER_BETA_PRICE: z.coerce.number().positive().default(0.003000),
  MOCK_PROVIDER_BETA_FAIL_RATE: z.coerce.number().min(0).max(1).default(0.0),

  // Circuit Breaker Configuration
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(10000),
  CIRCUIT_BREAKER_ERROR_RATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  CIRCUIT_BREAKER_MIN_REQUESTS: z.coerce.number().int().positive().default(5),

  // Routing Configuration
  ROUTING_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  PROVIDER_METRICS_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Phase 4: Caching & Coalescing
  CACHE_DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  CACHE_COALESCING_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  CACHE_DISCOUNT_PERCENT: z.coerce.number().min(0).max(100).default(50),

  // Phase 4: Distributed Rate Limiting
  RATE_LIMIT_DEFAULT_WINDOW_MS: z.coerce.number().int().positive().default(1000),
  RATE_LIMIT_DEFAULT_MAX: z.coerce.number().int().positive().default(50),
  RATE_LIMIT_FALLBACK_POLICY: z
    .enum(['FAIL_OPEN_LOCAL_FALLBACK', 'FAIL_CLOSED'])
    .default('FAIL_OPEN_LOCAL_FALLBACK'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadConfig(overrideEnv?: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(overrideEnv || process.env);
  if (!parsed.success) {
    const errorDetails = JSON.stringify(parsed.error.format(), null, 2);
    throw new Error(`[Configuration Error] Invalid environment variables:\n${errorDetails}`);
  }
  return parsed.data;
}

export const config: EnvConfig = loadConfig();
