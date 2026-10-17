import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { GatewayService } from './gateway.service.js';
import { RoutingService } from '../routing/routing.service.js';
import { BillingService } from '../billing/billing.service.js';
import { ValidationError, NotFoundError } from '../../common/errors.js';
import { ApiResponse } from '../../common/types.js';
import { Money } from '../../common/money.js';
import { Database } from '../../database/index.js';
import { RedisClient } from '../../database/redis.js';

const executeBodySchema = z.object({
  endpoint: z.string().min(1, 'Endpoint path is required'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).default('POST'),
  headers: z.record(z.string()).optional(),
  params: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  timeoutMs: z.number().int().positive().max(30000).optional(),
  cacheEligible: z.boolean().optional(),
  cacheBypass: z.boolean().optional(),
  cacheTtlSeconds: z.number().int().positive().optional(),
});

export interface GatewayControllerOptions {
  gatewayService: GatewayService;
  routingService: RoutingService;
  billingService: BillingService;
}

export async function gatewayRoutes(
  fastify: FastifyInstance,
  options: GatewayControllerOptions
) {
  const { gatewayService, routingService, billingService } = options;

  // 1. Gateway Request Execution
  fastify.post(
    '/v1/gateway/execute',
    { preHandler: [fastify.authenticateApiKey, fastify.checkRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsedBody = executeBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        throw new ValidationError('Invalid request body', parsedBody.error.format());
      }

      const preferredProviderId = request.headers['x-provider-preference'] as string | undefined;
      const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
      const orgId = request.client!.orgId;

      // Dynamic Pricing: read from API key or optional header override (e.g. x-pricing-multiplier: 180)
      const headerMultiplier = request.headers['x-pricing-multiplier']
        ? parseInt(request.headers['x-pricing-multiplier'] as string, 10)
        : undefined;
      const pricingMultiplierPercent = headerMultiplier || request.client?.pricingMultiplierPercent || 150;

      const result = await gatewayService.execute(
        {
          endpoint: parsedBody.data.endpoint,
          method: parsedBody.data.method,
          headers: parsedBody.data.headers,
          params: parsedBody.data.params,
          body: parsedBody.data.body,
          timeoutMs: parsedBody.data.timeoutMs,
        },
        {
          orgId,
          requestId: request.id,
          idempotencyKey,
          preferredProviderId,
          pricingMultiplierPercent,
          cacheEligible: parsedBody.data.cacheEligible,
          cacheBypass: parsedBody.data.cacheBypass,
          cacheTtlSeconds: parsedBody.data.cacheTtlSeconds,
          headers: request.headers as Record<string, unknown>,
        }
      );

      const responseEnvelope: ApiResponse = {
        success: true,
        data: result.response.body,
        meta: {
          requestId: request.id,
          providerId: result.provider.id,
          latencyMs: result.response.latencyMs,
          cached: result.cacheStatus === 'HIT',
          cacheStatus: result.cacheStatus,
          coalesced: result.isCoalesced,
          customerCharge: Money.toDollars(result.customerChargeMicros),
          customerChargeMicros: result.customerChargeMicros.toString(),
          pricingMultiplierPercent,
          discountApplied: result.cacheStatus === 'HIT',
          timestamp: new Date().toISOString(),
        },
      };

      return reply
        .status(result.response.statusCode)
        .header('x-cache', result.cacheStatus)
        .header('x-coalesced', String(result.isCoalesced))
        .header('x-customer-charge', Money.toDollars(result.customerChargeMicros))
        .send(responseEnvelope);
    }
  );

  // 2. Providers List & Health/Metrics
  fastify.get(
    '/v1/gateway/providers',
    { preHandler: [fastify.authenticateApiKey, fastify.checkRateLimit] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const providerStatuses = routingService.getAllProviderStatuses();

      return reply.send({
        success: true,
        data: providerStatuses,
      });
    }
  );

  // 3. Customer Account Balance
  fastify.get(
    '/v1/billing/account',
    { preHandler: [fastify.authenticateApiKey, fastify.checkRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const orgId = request.client!.orgId;
      const account = await billingService.getAccount(orgId);

      if (!account) {
        throw new NotFoundError('Billing account not found for organization');
      }

      const availableMicros = account.balanceMicros - account.reservedMicros;

      return reply.send({
        success: true,
        data: {
          orgId: account.orgId,
          currency: account.currency,
          balance: Money.toDollars(account.balanceMicros),
          reservedBalance: Money.toDollars(account.reservedMicros),
          availableBalance: Money.toDollars(availableMicros),
          balanceMicros: account.balanceMicros.toString(),
          reservedMicros: account.reservedMicros.toString(),
          availableMicros: availableMicros.toString(),
        },
      });
    }
  );

  // 4. Customer Immutable Ledger History
  fastify.get(
    '/v1/billing/ledger',
    { preHandler: [fastify.authenticateApiKey, fastify.checkRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const orgId = request.client!.orgId;
      const entries = await billingService.getLedgerHistory(orgId);

      return reply.send({
        success: true,
        data: entries.map((e) => ({
          id: e.id,
          requestId: e.requestId,
          idempotencyKey: e.idempotencyKey,
          type: e.type,
          amount: Money.toDollars(e.amountMicros),
          amountMicros: e.amountMicros.toString(),
          balanceAfter: Money.toDollars(e.balanceAfterMicros),
          reservedAfter: Money.toDollars(e.reservedAfterMicros),
          description: e.description,
          createdAt: e.createdAt.toISOString(),
        })),
      });
    }
  );

  // 5. Trigger Lease Reconciliation (Admin / Cron)
  fastify.post(
    '/v1/billing/reconcile',
    { preHandler: [fastify.authenticateApiKey] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const report = await billingService.reconcileExpiredLeases();
      return reply.send({
        success: true,
        data: report,
      });
    }
  );

  // 6. Health & Readiness Check (Public)
  fastify.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const [dbHealth, redisHealth] = await Promise.all([
      Database.checkHealth(),
      RedisClient.checkHealth(),
    ]);

    const isHealthy = dbHealth.isHealthy && redisHealth.isHealthy;
    const statusCode = isHealthy ? 200 : 503;

    return reply.status(statusCode).send({
      status: isHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      components: {
        database: dbHealth,
        redis: redisHealth,
      },
    });
  });
}
