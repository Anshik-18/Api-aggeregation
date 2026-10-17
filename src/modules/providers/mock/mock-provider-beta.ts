import { BaseMockProvider } from './base-mock-provider.js';
import { config } from '../../../config/index.js';

export class MockProviderBeta extends BaseMockProvider {
  constructor(customPrice?: number, customLatency?: number) {
    super({
      id: 'provider_beta',
      name: 'Provider Beta (Fast Tier)',
      costPerUnit: customPrice ?? config.MOCK_PROVIDER_BETA_PRICE,
      baselineLatencyMs: customLatency ?? config.MOCK_PROVIDER_BETA_LATENCY_MS,
      timeoutMs: 1500,
      maxConcurrency: 150,
    });
  }
}
