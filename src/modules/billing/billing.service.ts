import crypto from 'node:crypto';
import { IBillingRepository } from './billing.repository.js';
import {
  AccountRecord,
  LedgerEntryRecord,
  ReservationResult,
  IdempotencyRecord,
} from './billing.types.js';
import { Money } from '../../common/money.js';
import { Clock, SystemClock } from '../../common/clock.js';
import { rootLogger } from '../../common/logger.js';
import { NormalizedResponse } from '../providers/provider.interface.js';
import { config } from '../../config/index.js';

export interface ReconciliationReport {
  reconciledCount: number;
  records: Array<{
    requestId: string;
    orgId: string;
    heldAmountMicros: string;
    leaseExpiredAt: string;
  }>;
}

export class BillingService {
  constructor(
    private readonly billingRepo: IBillingRepository,
    private readonly clock: Clock = new SystemClock(),
    private readonly defaultHoldDurationMs = 30000 // 30s processing lease
  ) {}

  /**
   * Deterministic request payload hash for idempotency checking.
   * Sorts object keys recursively to ensure canonical JSON serialization.
   */
  public static calculateRequestHash(endpoint: string, method: string, body?: unknown): string {
    const canonicalBody = body !== undefined ? this.canonicalJsonStringify(body) : '';
    const payload = `${method.toUpperCase()}:${endpoint}:${canonicalBody}`;
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  private static canonicalJsonStringify(obj: unknown): string {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => this.canonicalJsonStringify(item)).join(',')}]`;
    }
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const keyVals = keys.map(
      (k) => `${JSON.stringify(k)}:${this.canonicalJsonStringify((obj as Record<string, unknown>)[k])}`
    );
    return `{${keyVals.join(',')}}`;
  }

  /**
   * Calculates the maximum estimated charge for reservation.
   * Customer charge policy: Baseline provider cost + dynamic markup margin, with minimum hold of 2,000 micros.
   */
  public estimateHoldAmount(baseCostDollars: number, pricingMultiplierPercent = 150): bigint {
    const baseMicros = Money.toMicros(baseCostDollars);
    const estimatedWithMargin = (baseMicros * BigInt(pricingMultiplierPercent)) / 100n;
    const minHold = 2000n; // $0.002000 min hold
    return estimatedWithMargin > minHold ? estimatedWithMargin : minHold;
  }

  /**
   * Calculates final customer charge upon confirmed success.
   * Dynamic pricing: multiplies provider base cost by customer's pricing multiplier (e.g. 150 = 1.5x, 110 = 1.1x, 200 = 2.0x).
   */
  public calculateFinalCharge(actualCostDollars: number, pricingMultiplierPercent = 150): bigint {
    const baseMicros = Money.toMicros(actualCostDollars);
    return (baseMicros * BigInt(pricingMultiplierPercent)) / 100n;
  }

  public calculateCacheHitCharge(
    baseCostDollars: number,
    discountPercent = config.CACHE_DISCOUNT_PERCENT,
    pricingMultiplierPercent = 150
  ): bigint {
    const standardCharge = this.calculateFinalCharge(baseCostDollars, pricingMultiplierPercent);
    if (discountPercent <= 0) return standardCharge;
    const discountMicros = (standardCharge * BigInt(discountPercent)) / 100n;
    return standardCharge - discountMicros;
  }

  public async getAccount(orgId: string): Promise<AccountRecord | null> {
    return this.billingRepo.getAccount(orgId);
  }

  public async createAccount(orgId: string, initialBalanceMicros = 0n): Promise<AccountRecord> {
    return this.billingRepo.createAccount(orgId, initialBalanceMicros);
  }

  public async deposit(orgId: string, amountMicros: bigint, description?: string): Promise<LedgerEntryRecord> {
    return this.billingRepo.deposit(orgId, amountMicros, description);
  }

  public async reserveFunds(
    orgId: string,
    requestId: string,
    idempotencyKey: string | null,
    requestHash: string,
    holdMicros: bigint
  ): Promise<ReservationResult> {
    const leaseExpiresAt = new Date(this.clock.now() + this.defaultHoldDurationMs);
    return this.billingRepo.reserve(
      orgId,
      requestId,
      idempotencyKey,
      requestHash,
      holdMicros,
      leaseExpiresAt
    );
  }

  public async captureSettlement(
    requestId: string,
    chargeMicros: bigint,
    providerId: string,
    response: NormalizedResponse
  ): Promise<LedgerEntryRecord> {
    return this.billingRepo.capture(
      requestId,
      chargeMicros,
      providerId,
      response.statusCode,
      response.headers,
      response.body
    );
  }

  public async releaseReservation(requestId: string, reason?: string): Promise<LedgerEntryRecord> {
    return this.billingRepo.release(requestId, reason);
  }

  public async markAmbiguousOutcome(requestId: string, reason?: string): Promise<void> {
    rootLogger.warn(
      { requestId, reason },
      'Marking transaction state as AMBIGUOUS. Funds remain reserved pending reconciliation.'
    );
    return this.billingRepo.markAmbiguous(requestId, reason);
  }

  /**
   * Scans for expired processing leases and transitions them to AMBIGUOUS.
   * Invariant: Never assume an expired lease proves an upstream operation did not execute.
   */
  public async reconcileExpiredLeases(): Promise<ReconciliationReport> {
    const now = new Date(this.clock.now());
    const expired = await this.billingRepo.findExpiredProcessingLeases(now);
    const reportRecords: ReconciliationReport['records'] = [];

    for (const record of expired) {
      await this.billingRepo.markAmbiguous(
        record.requestId,
        `Processing lease expired at ${record.leaseExpiresAt.toISOString()}`
      );
      reportRecords.push({
        requestId: record.requestId,
        orgId: record.orgId,
        heldAmountMicros: record.reservedAmountMicros.toString(),
        leaseExpiredAt: record.leaseExpiresAt.toISOString(),
      });
    }

    return {
      reconciledCount: reportRecords.length,
      records: reportRecords,
    };
  }

  public async resolveAmbiguousRecord(
    requestId: string,
    action: 'CAPTURE' | 'RELEASE',
    chargeMicros?: bigint
  ): Promise<void> {
    return this.billingRepo.resolveAmbiguous(requestId, action, chargeMicros);
  }

  public async getLedgerHistory(orgId: string): Promise<LedgerEntryRecord[]> {
    return this.billingRepo.getLedgerEntries(orgId);
  }

  public async getIdempotencyRecord(orgId: string, key: string): Promise<IdempotencyRecord | null> {
    return this.billingRepo.getIdempotencyRecord(orgId, key);
  }
}
