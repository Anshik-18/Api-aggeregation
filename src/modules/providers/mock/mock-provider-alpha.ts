import { BaseMockProvider } from './base-mock-provider.js';
import { config } from '../../../config/index.js';

export class MockProviderAlpha extends BaseMockProvider {
  constructor(customPrice?: number, customLatency?: number) {
    super({
      id: 'provider_alpha',
      name: 'Provider Alpha (Budget Tier)',
      costPerUnit: customPrice ?? config.MOCK_PROVIDER_ALPHA_PRICE,
      baselineLatencyMs: customLatency ?? config.MOCK_PROVIDER_ALPHA_LATENCY_MS,
      timeoutMs: 3000,
      maxConcurrency: 50,
    });
  }
}
