import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, TestContext } from '../helpers/test-app.js';

describe('Authentication (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await context.app.close();
  });

  it('should return 401 when API key is missing entirely', async () => {
    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      payload: {
        endpoint: '/v1/models',
        method: 'GET',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toContain('Missing API key');
  });

  it('should return 401 when an invalid API key is provided via x-api-key', async () => {
    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': 'ak_live_invalid_secret_key_123',
      },
      payload: {
        endpoint: '/v1/models',
        method: 'GET',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toContain('Invalid or inactive API key');
  });

  it('should return 401 when a revoked/inactive API key is provided', async () => {
    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.inactiveApiKey,
      },
      payload: {
        endpoint: '/v1/models',
        method: 'GET',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toContain('Invalid or inactive API key');
  });

  it('should authenticate successfully with valid x-api-key header', async () => {
    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        'x-api-key': context.validApiKey,
      },
      payload: {
        endpoint: '/v1/models',
        method: 'GET',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });

  it('should authenticate successfully with Authorization: Bearer <key> header', async () => {
    const res = await context.app.inject({
      method: 'POST',
      url: '/v1/gateway/execute',
      headers: {
        authorization: `Bearer ${context.validApiKey}`,
      },
      payload: {
        endpoint: '/v1/models',
        method: 'GET',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });
});
