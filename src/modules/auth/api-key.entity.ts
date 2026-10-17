export interface ApiKeyRecord {
  id: string;
  orgId: string;
  orgName: string;
  billingMode: 'PREPAID' | 'POSTPAID';
  keyHash: string;
  keyPrefix: string;
  name: string;
  isActive: boolean;
  rateLimitPerSec: number;
  rateLimitWindowMs?: number;
  pricingMultiplierPercent?: number;
  createdAt: Date;
  lastUsedAt?: Date | null;
}
