import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { ApiKeyService } from './api-key.service.js';
import { UnauthorizedError } from '../../common/errors.js';

export interface AuthPluginOptions {
  apiKeyService: ApiKeyService;
}

const authPluginCallback: FastifyPluginAsync<AuthPluginOptions> = async (
  fastify: FastifyInstance,
  opts: AuthPluginOptions
) => {
  const { apiKeyService } = opts;

  fastify.decorateRequest('client', undefined);

  fastify.decorate(
    'authenticateApiKey',
    async (request: FastifyRequest, _reply: FastifyReply) => {
      let rawKey: string | undefined;

      const headerKey = request.headers['x-api-key'];
      if (typeof headerKey === 'string' && headerKey.trim() !== '') {
        rawKey = headerKey.trim();
      } else {
        const authHeader = request.headers.authorization;
        if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
          rawKey = authHeader.substring(7).trim();
        }
      }

      if (!rawKey) {
        throw new UnauthorizedError(
          'Missing API key. Provide via x-api-key header or Authorization: Bearer <key>'
        );
      }

      const client = await apiKeyService.authenticate(rawKey);
      if (!client) {
        throw new UnauthorizedError('Invalid or inactive API key');
      }

      request.client = client;
    }
  );
};

export const authPlugin = fp(authPluginCallback, {
  name: 'auth-plugin',
  fastify: '5.x',
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticateApiKey: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}
