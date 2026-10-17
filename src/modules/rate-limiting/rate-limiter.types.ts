export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number;
}

export interface IRateLimiterService {
  checkLimit(
    identifier: string,
    limit: number,
    windowMs: number
  ): Promise<RateLimitResult>;
}
