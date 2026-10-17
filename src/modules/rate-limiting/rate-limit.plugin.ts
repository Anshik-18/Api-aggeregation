import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { IRateLimiterService } from './rate-limiter.types.js';
import { RateLimitExceededError } from '../../common/errors.js';
import { config } from '../../config/index.js';

export interface RateLimitPluginOptions {
  rateLimiterService: IRateLimiterService;
}

const rateLimitPluginCallback: FastifyPluginAsync<RateLimitPluginOptions> = async (
  fastify: FastifyInstance,
  opts: RateLimitPluginOptions
) => {
  const { rateLimiterService } = opts;

  fastify.decorate(
    'checkRateLimit',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.client) {
        return; // Unauthenticated requests bypass rate limiter
      }

      const orgId = request.client.orgId;
      const keyId = request.client.keyId;
      const identifier = `${orgId}:${keyId}`;
      const limit = request.client.rateLimitPerSec || config.RATE_LIMIT_DEFAULT_MAX;
      const windowMs =
        request.client.rateLimitWindowMs && request.client.rateLimitWindowMs > 0
          ? request.client.rateLimitWindowMs
          : request.client.rateLimitPerSec <= 2
          ? 4000
          : config.RATE_LIMIT_DEFAULT_WINDOW_MS;

      const result = await rateLimiterService.checkLimit(identifier, limit, windowMs);

      reply.header('x-ratelimit-limit', result.limit);
      reply.header('x-ratelimit-remaining', result.remaining);
      reply.header('x-ratelimit-reset', result.resetSeconds);

      if (!result.allowed) {
        reply.header('retry-after', result.retryAfterSeconds);
        const windowSec = Math.max(1, Math.round(windowMs / 1000));
        const rateText = windowMs === 1000 ? `${limit} req/s` : `${limit} requests per ${windowSec}s`;
        throw new RateLimitExceededError(
          `Rate limit of ${rateText} exceeded for organization ${orgId}. Retry in ${result.retryAfterSeconds}s.`,
          result.retryAfterSeconds,
          {
            orgId,
            keyId,
            limit,
            windowMs,
            remaining: 0,
            retryAfterSeconds: result.retryAfterSeconds,
          }
        );
      }
    }
  );
};

export const rateLimitPlugin = fp(rateLimitPluginCallback, {
  name: 'rate-limit-plugin',
  fastify: '5.x',
});

declare module 'fastify' {
  interface FastifyInstance {
    checkRateLimit: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}
