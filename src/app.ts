import fastify, { FastifyInstance, FastifyServerOptions, FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { rootLogger } from './common/logger.js';
import { AppError, RateLimitExceededError } from './common/errors.js';
import { IApiKeyRepository, PostgresApiKeyRepository } from './modules/auth/api-key.repository.js';
import { ApiKeyService } from './modules/auth/api-key.service.js';
import { authPlugin } from './modules/auth/auth.plugin.js';
import { ProviderRegistry } from './modules/providers/provider.registry.js';
import { MockProviderAlpha } from './modules/providers/mock/mock-provider-alpha.js';
import { MockProviderBeta } from './modules/providers/mock/mock-provider-beta.js';
import { GatewayService } from './modules/gateway/gateway.service.js';
import { gatewayRoutes } from './modules/gateway/gateway.controller.js';
import { RoutingService } from './modules/routing/routing.service.js';
import { IBillingRepository, PostgresBillingRepository } from './modules/billing/billing.repository.js';
import { BillingService } from './modules/billing/billing.service.js';
import { ICacheService } from './modules/caching/cache.types.js';
import { RedisCacheService } from './modules/caching/cache.service.js';
import { ICoalescingService, RedisCoalescingService } from './modules/caching/coalescing.service.js';
import { IRateLimiterService } from './modules/rate-limiting/rate-limiter.types.js';
import { RedisRateLimiterService } from './modules/rate-limiting/rate-limiter.service.js';
import { rateLimitPlugin } from './modules/rate-limiting/rate-limit.plugin.js';
import { Clock } from './common/clock.js';

export interface AppDependencies {
  apiKeyRepository?: IApiKeyRepository;
  providerRegistry?: ProviderRegistry;
  routingService?: RoutingService;
  billingRepository?: IBillingRepository;
  billingService?: BillingService;
  cacheService?: ICacheService;
  coalescingService?: ICoalescingService;
  rateLimiterService?: IRateLimiterService;
  clock?: Clock;
}

export function buildApp(
  dependencies: AppDependencies = {},
  fastifyOptions: FastifyServerOptions = {}
): FastifyInstance {
  const app = fastify({
    loggerInstance: rootLogger,
    genReqId: () => `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    requestIdHeader: 'x-request-id',
    ...fastifyOptions,
  });

  // 1. Security & Middleware
  app.register(helmet, { contentSecurityPolicy: false });
  app.register(cors, {
    origin: true,
    exposedHeaders: [
      'x-customer-charge',
      'x-cache',
      'x-coalesced',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      'retry-after',
      'x-request-id',
    ],
  });

  // 2. Dependency Wiring
  const apiKeyRepo = dependencies.apiKeyRepository ?? new PostgresApiKeyRepository();
  const apiKeyService = new ApiKeyService(apiKeyRepo);

  let providerRegistry = dependencies.providerRegistry;
  if (!providerRegistry) {
    providerRegistry = new ProviderRegistry();
    providerRegistry.register(new MockProviderAlpha());
    providerRegistry.register(new MockProviderBeta());
  }

  const routingService =
    dependencies.routingService ??
    new RoutingService(providerRegistry, { clock: dependencies.clock });

  const billingRepo = dependencies.billingRepository ?? new PostgresBillingRepository();
  const billingService =
    dependencies.billingService ??
    new BillingService(billingRepo, dependencies.clock);

  const cacheService = dependencies.cacheService ?? new RedisCacheService();
  const coalescingService = dependencies.coalescingService ?? new RedisCoalescingService();
  const rateLimiterService =
    dependencies.rateLimiterService ??
    new RedisRateLimiterService(undefined, dependencies.clock);

  const gatewayService = new GatewayService(
    routingService,
    billingService,
    cacheService,
    coalescingService
  );

  // 3. Register Plugins
  app.register(authPlugin, { apiKeyService });
  app.register(rateLimitPlugin, { rateLimiterService });

  // 4. Register Routes
  app.register(gatewayRoutes, { gatewayService, routingService, billingService });

  // 5. Centralized Error Handler
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof AppError) {
      if (error instanceof RateLimitExceededError) {
        reply.header('retry-after', error.retryAfterSeconds);
      }

      request.log.warn(
        {
          err: error,
          code: error.errorCode,
          statusCode: error.statusCode,
          details: error.details,
        },
        error.message
      );

      return reply.status(error.statusCode).send({
        success: false,
        error: {
          code: error.errorCode,
          message: error.message,
          details: error.details,
        },
        meta: {
          requestId: request.id,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Fastify client and validation errors (4xx)
    const fastifyError = error as FastifyError;
    if (fastifyError.validation || (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500)) {
      return reply.status(fastifyError.statusCode ?? 400).send({
        success: false,
        error: {
          code: fastifyError.code ?? 'VALIDATION_ERROR',
          message: fastifyError.message,
          details: fastifyError.validation,
        },
        meta: {
          requestId: request.id,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Unexpected internal errors
    request.log.error({ err: error }, 'Unhandled server exception');

    return reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal error occurred',
      },
      meta: {
        requestId: request.id,
        timestamp: new Date().toISOString(),
      },
    });
  });

  // 6. Not Found Handler
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
      },
      meta: {
        requestId: request.id,
        timestamp: new Date().toISOString(),
      },
    });
  });

  return app;
}
