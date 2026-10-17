import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryBillingRepository } from '../../src/modules/billing/billing.repository.js';
import { BillingService } from '../../src/modules/billing/billing.service.js';
import { Money } from '../../src/common/money.js';
import { TestClock } from '../../src/common/clock.js';
import {
  InsufficientFundsError,
  IdempotencyConflictError,
  IdempotencyPayloadMismatchError,
  DuplicateSettlementError,
} from '../../src/common/errors.js';

describe('Billing & Idempotency Engine (Unit)', () => {
  let clock: TestClock;
  let repo: InMemoryBillingRepository;
  let service: BillingService;
  const orgId = 'org_unit_test';

  beforeEach(async () => {
    clock = new TestClock(1000000);
    repo = new InMemoryBillingRepository(clock);
    service = new BillingService(repo, clock, 30000);
    await repo.createAccount(orgId, 5000n); // $0.005000 initial balance (5000 micros)
  });

  describe('Money fixed-precision conversions', () => {
    it('should convert dollars to micros accurately without floating point error', () => {
      expect(Money.toMicros(0.001)).toBe(1000n);
      expect(Money.toMicros('0.001000')).toBe(1000n);
      expect(Money.toMicros(1.5)).toBe(1500000n);
      expect(Money.toMicros('10.250000')).toBe(10250000n);
    });

    it('should convert micros to formatted dollar strings', () => {
      expect(Money.toDollars(1000n)).toBe('0.001000');
      expect(Money.toDollars(1500000n)).toBe('1.500000');
      expect(Money.toDisplayDollars(1250000n)).toBe('1.25');
    });
  });

  describe('Deterministic request hashing', () => {
    it('should produce identical hashes regardless of JSON key ordering', () => {
      const hash1 = BillingService.calculateRequestHash('/v1/chat', 'POST', { a: 1, b: 2 });
      const hash2 = BillingService.calculateRequestHash('/v1/chat', 'POST', { b: 2, a: 1 });
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different payloads', () => {
      const hash1 = BillingService.calculateRequestHash('/v1/chat', 'POST', { prompt: 'foo' });
      const hash2 = BillingService.calculateRequestHash('/v1/chat', 'POST', { prompt: 'bar' });
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Atomic balance reservation and solvency', () => {
    it('should reserve funds and record a HOLD ledger entry', async () => {
      const res = await service.reserveFunds(orgId, 'req_1', 'idem_1', 'hash_1', 2000n);
      expect(res.isReplay).toBe(false);

      const acc = await service.getAccount(orgId);
      expect(acc?.balanceMicros).toBe(5000n);
      expect(acc?.reservedMicros).toBe(2000n);

      const entries = await service.getLedgerHistory(orgId);
      const holdEntry = entries.find((e) => e.type === 'HOLD');
      expect(holdEntry).toBeDefined();
      expect(holdEntry?.amountMicros).toBe(2000n);
    });

    it('should reject reservation with 402 InsufficientFunds when balance is inadequate', async () => {
      // Balance is 5000n. Attempt to reserve 6000n.
      await expect(
        service.reserveFunds(orgId, 'req_fail', 'idem_fail', 'hash_fail', 6000n)
      ).rejects.toThrow(InsufficientFundsError);

      const acc = await service.getAccount(orgId);
      expect(acc?.reservedMicros).toBe(0n);
    });

    it('should prevent concurrent overspending when available balance is exhausted', async () => {
      // 5000n balance. Two concurrent requests each requiring 3000n.
      const p1 = service.reserveFunds(orgId, 'req_c1', 'idem_c1', 'hash_c1', 3000n);
      const p2 = service.reserveFunds(orgId, 'req_c2', 'idem_c2', 'hash_c2', 3000n);

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const acc = await service.getAccount(orgId);
      expect(acc?.balanceMicros).toBe(5000n);
      expect(acc?.reservedMicros).toBe(3000n);
      expect(acc!.balanceMicros - acc!.reservedMicros).toBeGreaterThanOrEqual(0n);
    });
  });

  describe('Settlement capture and release', () => {
    it('should capture settlement, deduct balance, and release reservation', async () => {
      await service.reserveFunds(orgId, 'req_2', 'idem_2', 'hash_2', 2000n);

      await service.captureSettlement('req_2', 1500n, 'provider_alpha', {
        providerId: 'provider_alpha',
        statusCode: 200,
        headers: {},
        body: { result: 'ok' },
        latencyMs: 50,
        cost: 0.001,
      });

      const acc = await service.getAccount(orgId);
      // Balance deducted by 1500n (5000n - 1500n = 3500n)
      expect(acc?.balanceMicros).toBe(3500n);
      // Reservation fully cleared
      expect(acc?.reservedMicros).toBe(0n);

      const entries = await service.getLedgerHistory(orgId);
      const captureEntry = entries.find((e) => e.type === 'CAPTURE');
      expect(captureEntry?.amountMicros).toBe(1500n);
      expect(captureEntry?.balanceAfterMicros).toBe(3500n);
    });

    it('should release reservation on confirmed failure without deducting balance', async () => {
      await service.reserveFunds(orgId, 'req_3', 'idem_3', 'hash_3', 2000n);

      await service.releaseReservation('req_3', 'Upstream 503 error');

      const acc = await service.getAccount(orgId);
      expect(acc?.balanceMicros).toBe(5000n); // Balance intact
      expect(acc?.reservedMicros).toBe(0n);   // Hold cleared

      const entries = await service.getLedgerHistory(orgId);
      const releaseEntry = entries.find((e) => e.type === 'RELEASE');
      expect(releaseEntry?.amountMicros).toBe(2000n);
    });

    it('should prevent duplicate settlement on already captured or released requests', async () => {
      await service.reserveFunds(orgId, 'req_dup', 'idem_dup', 'hash_dup', 2000n);

      await service.captureSettlement('req_dup', 1500n, 'provider_alpha', {
        providerId: 'provider_alpha',
        statusCode: 200,
        headers: {},
        body: { result: 'ok' },
        latencyMs: 50,
        cost: 0.001,
      });

      // Attempting second capture should throw DuplicateSettlementError
      await expect(
        service.captureSettlement('req_dup', 1500n, 'provider_alpha', {
          providerId: 'provider_alpha',
          statusCode: 200,
          headers: {},
          body: { result: 'ok' },
          latencyMs: 50,
          cost: 0.001,
        })
      ).rejects.toThrow(DuplicateSettlementError);

      // Attempting release on captured should also throw
      await expect(service.releaseReservation('req_dup')).rejects.toThrow(DuplicateSettlementError);
    });
  });

  describe('Durable idempotency behavior', () => {
    it('should return isReplay: true with stored response when repeating same key and payload', async () => {
      await service.reserveFunds(orgId, 'req_orig', 'idem_key_1', 'hash_same', 2000n);

      await service.captureSettlement('req_orig', 1500n, 'provider_alpha', {
        providerId: 'provider_alpha',
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: { greeting: 'hello world' },
        latencyMs: 25,
        cost: 0.001,
      });

      // Repeat request with same idempotency key and same request hash
      const replayResult = await service.reserveFunds(
        orgId,
        'req_replay',
        'idem_key_1',
        'hash_same',
        2000n
      );

      expect(replayResult.isReplay).toBe(true);
      if (replayResult.isReplay) {
        expect(replayResult.record.status).toBe('COMPLETED');
        expect(replayResult.record.capturedAmountMicros).toBe(1500n);
        expect(replayResult.record.responseBody).toEqual({ greeting: 'hello world' });
      }

      // Customer account was not charged a second time
      const acc = await service.getAccount(orgId);
      expect(acc?.balanceMicros).toBe(3500n);
    });

    it('should throw IdempotencyPayloadMismatchError when reusing key with different payload', async () => {
      await service.reserveFunds(orgId, 'req_m1', 'idem_key_shared', 'hash_alpha', 2000n);

      await expect(
        service.reserveFunds(orgId, 'req_m2', 'idem_key_shared', 'hash_beta_different', 2000n)
      ).rejects.toThrow(IdempotencyPayloadMismatchError);
    });

    it('should throw IdempotencyConflictError when concurrent request arrives while first is PROCESSING', async () => {
      await service.reserveFunds(orgId, 'req_p1', 'idem_inflight', 'hash_inflight', 2000n);

      await expect(
        service.reserveFunds(orgId, 'req_p2', 'idem_inflight', 'hash_inflight', 2000n)
      ).rejects.toThrow(IdempotencyConflictError);
    });
  });

  describe('Crash recovery & lease reconciliation', () => {
    it('should transition expired PROCESSING leases to AMBIGUOUS and retain reservation', async () => {
      // Lease duration is 30,000ms
      await service.reserveFunds(orgId, 'req_crash', 'idem_crash', 'hash_crash', 2000n);

      // Advance clock past the lease expiration
      clock.advance(30001);

      const report = await service.reconcileExpiredLeases();
      expect(report.reconciledCount).toBe(1);
      expect(report.records[0].requestId).toBe('req_crash');

      const idemp = await repo.getIdempotencyRecordByRequestId('req_crash');
      expect(idemp?.status).toBe('AMBIGUOUS');

      // The hold is strictly RETAINED to prevent double spend
      const acc = await service.getAccount(orgId);
      expect(acc?.reservedMicros).toBe(2000n);
    });

    it('should allow explicit resolution of AMBIGUOUS transactions', async () => {
      await service.reserveFunds(orgId, 'req_amb', 'idem_amb', 'hash_amb', 2000n);
      await service.markAmbiguousOutcome('req_amb', 'Upstream timed out');

      // Reconciler verifies upstream log and confirms the request did execute
      await service.resolveAmbiguousRecord('req_amb', 'CAPTURE', 1800n);

      const acc = await service.getAccount(orgId);
      expect(acc?.balanceMicros).toBe(3200n); // 5000 - 1800
      expect(acc?.reservedMicros).toBe(0n);

      const idemp = await repo.getIdempotencyRecordByRequestId('req_amb');
      expect(idemp?.status).toBe('COMPLETED');
    });
  });
});
