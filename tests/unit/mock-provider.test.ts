import { describe, it, expect, beforeEach } from 'vitest';
import { MockProviderAlpha } from '../../src/modules/providers/mock/mock-provider-alpha.js';
import { MockProviderBeta } from '../../src/modules/providers/mock/mock-provider-beta.js';
import {
  UpstreamProviderError,
  UpstreamTimeoutError,
} from '../../src/common/errors.js';

describe('Mock Providers (Unit)', () => {
  let alpha: MockProviderAlpha;
  let beta: MockProviderBeta;

  beforeEach(() => {
    alpha = new MockProviderAlpha(0.001, 5); // 5ms simulated latency for unit tests
    beta = new MockProviderBeta(0.003, 5);
  });

  it('should have distinct pricing and identifiers', () => {
    expect(alpha.id).toBe('provider_alpha');
    expect(alpha.costPerUnit).toBe(0.001);

    expect(beta.id).toBe('provider_beta');
    expect(beta.costPerUnit).toBe(0.003);
    expect(alpha.costPerUnit).toBeLessThan(beta.costPerUnit);
  });

  it('should successfully execute a normalized request and return formatted payload', async () => {
    const res = await alpha.execute({
      endpoint: '/v1/chat/completions',
      method: 'POST',
      body: { prompt: 'Hello world' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.providerId).toBe('provider_alpha');
    expect(res.cost).toBe(0.001);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('status', 'completed');
    expect(res.body).toHaveProperty('result');
  });

  it('should simulate upstream status code failures', async () => {
    alpha.setFailureConfig({ simulateStatusCode: 503 });

    await expect(
      alpha.execute({
        endpoint: '/v1/test',
        method: 'POST',
      })
    ).rejects.toThrow(UpstreamProviderError);

    // Verify retryable flag on 503
    try {
      await alpha.execute({ endpoint: '/v1/test', method: 'POST' });
    } catch (err) {
      expect((err as UpstreamProviderError).statusCode).toBe(503);
      expect((err as UpstreamProviderError).retryable).toBe(true);
    }
  });

  it('should simulate upstream timeout errors when requested', async () => {
    alpha.setFailureConfig({ simulateTimeout: true });

    await expect(
      alpha.execute({
        endpoint: '/v1/test',
        method: 'POST',
        timeoutMs: 50,
      })
    ).rejects.toThrow(UpstreamTimeoutError);
  });

  it('should fail semantic response validation when upstream returns disguised error with HTTP 200', async () => {
    alpha.setFailureConfig({ simulateMalformedResponse: true });

    const res = await alpha.execute({
      endpoint: '/v1/test',
      method: 'POST',
    });

    expect(res.statusCode).toBe(200);
    const validation = alpha.validateResponse(res.body, res.statusCode);
    expect(validation.isValid).toBe(false);
    expect(validation.errorReason).toContain('Malformed payload');
  });

  it('should validate valid responses successfully', () => {
    const validBody = {
      id: 'res_123',
      result: { message: 'ok' },
    };
    const validation = alpha.validateResponse(validBody, 200);
    expect(validation.isValid).toBe(true);
  });
});
