import { UpstreamProvider } from './provider.interface.js';
import { ProviderUnavailableError } from '../../common/errors.js';

export class ProviderRegistry {
  private providers: Map<string, UpstreamProvider> = new Map();

  public register(provider: UpstreamProvider): void {
    this.providers.set(provider.id, provider);
  }

  public get(providerId: string): UpstreamProvider | undefined {
    return this.providers.get(providerId);
  }

  public getAll(): UpstreamProvider[] {
    return Array.from(this.providers.values());
  }

  public getRequired(providerId: string): UpstreamProvider {
    const provider = this.get(providerId);
    if (!provider) {
      throw new ProviderUnavailableError(`Provider with ID '${providerId}' is not registered`);
    }
    return provider;
  }

  /**
   * Phase 1 default selection: Returns preferred provider if specified,
   * otherwise selects the first available healthy provider (cheaper one first).
   */
  public selectDefault(preferredId?: string): UpstreamProvider {
    if (preferredId) {
      return this.getRequired(preferredId);
    }

    const all = this.getAll();
    if (all.length === 0) {
      throw new ProviderUnavailableError('No providers registered in gateway');
    }

    // Sort by cost ascending for Phase 1 baseline
    return [...all].sort((a, b) => a.costPerUnit - b.costPerUnit)[0];
  }
}
