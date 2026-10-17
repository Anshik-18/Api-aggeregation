import pg from 'pg';
import {
  AccountRecord,
  LedgerEntryRecord,
  IdempotencyRecord,
  ReservationResult,
} from './billing.types.js';
import {
  InsufficientFundsError,
  IdempotencyConflictError,
  IdempotencyPayloadMismatchError,
  DuplicateSettlementError,
} from '../../common/errors.js';
import { Database } from '../../database/index.js';
import { Clock, SystemClock } from '../../common/clock.js';

export interface IBillingRepository {
  getAccount(orgId: string): Promise<AccountRecord | null>;
  createAccount(orgId: string, initialBalanceMicros?: bigint): Promise<AccountRecord>;
  deposit(orgId: string, amountMicros: bigint, description?: string): Promise<LedgerEntryRecord>;
  reserve(
    orgId: string,
    requestId: string,
    idempotencyKey: string | null,
    requestHash: string,
    holdMicros: bigint,
    leaseExpiresAt: Date
  ): Promise<ReservationResult>;
  capture(
    requestId: string,
    chargeMicros: bigint,
    providerId: string,
    responseStatus: number,
    responseHeaders: Record<string, string>,
    responseBody: unknown
  ): Promise<LedgerEntryRecord>;
  release(requestId: string, reason?: string): Promise<LedgerEntryRecord>;
  markAmbiguous(requestId: string, reason?: string): Promise<void>;
  findExpiredProcessingLeases(now: Date): Promise<IdempotencyRecord[]>;
  resolveAmbiguous(
    requestId: string,
    action: 'CAPTURE' | 'RELEASE',
    chargeMicros?: bigint,
    providerId?: string,
    responseStatus?: number,
    responseBody?: unknown
  ): Promise<void>;
  getLedgerEntries(orgId: string): Promise<LedgerEntryRecord[]>;
  getIdempotencyRecord(orgId: string, key: string): Promise<IdempotencyRecord | null>;
  getIdempotencyRecordByRequestId(requestId: string): Promise<IdempotencyRecord | null>;
}

export class InMemoryBillingRepository implements IBillingRepository {
  private accounts = new Map<string, AccountRecord>(); // orgId -> AccountRecord
  private ledger = new Map<string, LedgerEntryRecord>(); // id -> LedgerEntryRecord
  private idempotencyByKey = new Map<string, IdempotencyRecord>(); // `${orgId}:${key}` -> IdempotencyRecord
  private idempotencyByRequestId = new Map<string, IdempotencyRecord>(); // requestId -> IdempotencyRecord

  constructor(private readonly clock: Clock = new SystemClock()) {}

  public async getAccount(orgId: string): Promise<AccountRecord | null> {
    const acc = this.accounts.get(orgId);
    return acc ? { ...acc } : null;
  }

  public async createAccount(orgId: string, initialBalanceMicros = 0n): Promise<AccountRecord> {
    const now = new Date(this.clock.now());
    const acc: AccountRecord = {
      id: `acc_${Math.random().toString(36).substring(2, 9)}`,
      orgId,
      currency: 'USD',
      balanceMicros: 0n,
      reservedMicros: 0n,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.accounts.set(orgId, acc);

    if (initialBalanceMicros > 0n) {
      await this.deposit(orgId, initialBalanceMicros, 'Initial Account Seed Deposit');
    }

    return { ...this.accounts.get(orgId)! };
  }

  public async deposit(orgId: string, amountMicros: bigint, description?: string): Promise<LedgerEntryRecord> {
    const acc = this.accounts.get(orgId);
    if (!acc) {
      throw new Error(`Account not found for organization ${orgId}`);
    }

    acc.balanceMicros += amountMicros;
    acc.version++;
    acc.updatedAt = new Date(this.clock.now());

    const entry: LedgerEntryRecord = {
      id: `ledg_${this.clock.now()}_${Math.random().toString(36).substring(2, 7)}`,
      accountId: acc.id,
      orgId,
      type: 'DEPOSIT',
      amountMicros,
      balanceAfterMicros: acc.balanceMicros,
      reservedAfterMicros: acc.reservedMicros,
      description: description ?? 'Account Deposit',
      createdAt: new Date(this.clock.now()),
    };
    this.ledger.set(entry.id, entry);
    return { ...entry };
  }

  public async reserve(
    orgId: string,
    requestId: string,
    idempotencyKey: string | null,
    requestHash: string,
    holdMicros: bigint,
    leaseExpiresAt: Date
  ): Promise<ReservationResult> {
    const acc = this.accounts.get(orgId);
    if (!acc) {
      throw new Error(`Account not found for organization ${orgId}`);
    }

    // 1. Idempotency Check if key provided
    if (idempotencyKey) {
      const compositeKey = `${orgId}:${idempotencyKey}`;
      const existing = this.idempotencyByKey.get(compositeKey);

      if (existing) {
        // Payload mismatch check
        if (existing.requestHash !== requestHash) {
          throw new IdempotencyPayloadMismatchError();
        }

        // Completed replay
        if (existing.status === 'COMPLETED') {
          return { isReplay: true, record: { ...existing } };
        }

        // Currently in flight
        if (existing.status === 'PROCESSING') {
          if (existing.leaseExpiresAt.getTime() > this.clock.now()) {
            throw new IdempotencyConflictError(
              'A request with this idempotency key is currently in progress'
            );
          }
          // Expired lease - fall through to allow recovery
        }

        if (existing.status === 'AMBIGUOUS') {
          throw new IdempotencyConflictError(
            'Previous request with this idempotency key resulted in an ambiguous outcome awaiting reconciliation'
          );
        }
      }
    }

    // 2. Available Funds Check (Atomic reservation)
    const available = acc.balanceMicros - acc.reservedMicros;
    if (available < holdMicros) {
      throw new InsufficientFundsError(
        `Insufficient funds. Available: ${available.toString()} micros, required hold: ${holdMicros.toString()} micros`
      );
    }

    // Mutate state atomically
    acc.reservedMicros += holdMicros;
    acc.version++;
    acc.updatedAt = new Date(this.clock.now());

    // Invariant check
    if (acc.balanceMicros - acc.reservedMicros < 0n) {
      acc.reservedMicros -= holdMicros;
      throw new InsufficientFundsError('Transaction violated solvency constraint');
    }

    // Write Ledger Entry
    const ledgerEntry: LedgerEntryRecord = {
      id: `ledg_${this.clock.now()}_${Math.random().toString(36).substring(2, 7)}`,
      accountId: acc.id,
      orgId,
      requestId,
      idempotencyKey: idempotencyKey ?? undefined,
      type: 'HOLD',
      amountMicros: holdMicros,
      balanceAfterMicros: acc.balanceMicros,
      reservedAfterMicros: acc.reservedMicros,
      description: 'Pre-flight balance reservation',
      createdAt: new Date(this.clock.now()),
    };
    this.ledger.set(ledgerEntry.id, ledgerEntry);

    // Write or Update Idempotency Record
    const now = new Date(this.clock.now());
    const key = idempotencyKey ?? `internal_${requestId}`;
    const idempRecord: IdempotencyRecord = {
      id: `idemp_${this.clock.now()}_${Math.random().toString(36).substring(2, 7)}`,
      orgId,
      key,
      requestHash,
      status: 'PROCESSING',
      requestId,
      reservedAmountMicros: holdMicros,
      capturedAmountMicros: 0n,
      leaseExpiresAt,
      createdAt: now,
      updatedAt: now,
    };

    this.idempotencyByKey.set(`${orgId}:${key}`, idempRecord);
    this.idempotencyByRequestId.set(requestId, idempRecord);

    return {
      isReplay: false,
      requestId,
      idempotencyKey: idempotencyKey ?? undefined,
      holdAmountMicros: holdMicros,
    };
  }

  public async capture(
    requestId: string,
    chargeMicros: bigint,
    providerId: string,
    responseStatus: number,
    responseHeaders: Record<string, string>,
    responseBody: unknown
  ): Promise<LedgerEntryRecord> {
    const idemp = this.idempotencyByRequestId.get(requestId);
    if (!idemp) {
      throw new Error(`No reservation found for request ${requestId}`);
    }

    if (idemp.status === 'COMPLETED' || idemp.status === 'FAILED') {
      throw new DuplicateSettlementError(
        `Cannot capture request ${requestId}: already in status ${idemp.status}`
      );
    }

    const acc = this.accounts.get(idemp.orgId);
    if (!acc) {
      throw new Error(`Account not found for org ${idemp.orgId}`);
    }

    // Deduct balance and release reservation atomically
    acc.balanceMicros -= chargeMicros;
    acc.reservedMicros -= idemp.reservedAmountMicros;
    acc.version++;
    acc.updatedAt = new Date(this.clock.now());

    // Invariant check
    if (acc.balanceMicros < 0n || acc.reservedMicros < 0n) {
      throw new Error('Balance invariant violation during capture');
    }

    idemp.status = 'COMPLETED';
    idemp.capturedAmountMicros = chargeMicros;
    idemp.providerId = providerId;
    idemp.responseStatus = responseStatus;
    idemp.responseHeaders = responseHeaders;
    idemp.responseBody = responseBody;
    idemp.updatedAt = new Date(this.clock.now());

    const ledgerEntry: LedgerEntryRecord = {
      id: `ledg_${this.clock.now()}_${Math.random().toString(36).substring(2, 7)}`,
      accountId: acc.id,
      orgId: idemp.orgId,
      requestId,
      idempotencyKey: idemp.key,
      type: 'CAPTURE',
      amountMicros: chargeMicros,
      balanceAfterMicros: acc.balanceMicros,
      reservedAfterMicros: acc.reservedMicros,
      description: `Settled execution via ${providerId}`,
      createdAt: new Date(this.clock.now()),
    };
    this.ledger.set(ledgerEntry.id, ledgerEntry);

    return { ...ledgerEntry };
  }

  public async release(requestId: string, reason?: string): Promise<LedgerEntryRecord> {
    const idemp = this.idempotencyByRequestId.get(requestId);
    if (!idemp) {
      throw new Error(`No reservation found for request ${requestId}`);
    }

    if (idemp.status === 'COMPLETED' || idemp.status === 'FAILED') {
      throw new DuplicateSettlementError(
        `Cannot release request ${requestId}: already in status ${idemp.status}`
      );
    }

    const acc = this.accounts.get(idemp.orgId);
    if (!acc) {
      throw new Error(`Account not found for org ${idemp.orgId}`);
    }

    // Release reservation without balance deduction
    acc.reservedMicros -= idemp.reservedAmountMicros;
    acc.version++;
    acc.updatedAt = new Date(this.clock.now());

    idemp.status = 'FAILED';
    idemp.updatedAt = new Date(this.clock.now());

    const ledgerEntry: LedgerEntryRecord = {
      id: `ledg_${this.clock.now()}_${Math.random().toString(36).substring(2, 7)}`,
      accountId: acc.id,
      orgId: idemp.orgId,
      requestId,
      idempotencyKey: idemp.key,
      type: 'RELEASE',
      amountMicros: idemp.reservedAmountMicros,
      balanceAfterMicros: acc.balanceMicros,
      reservedAfterMicros: acc.reservedMicros,
      description: reason ?? 'Released failed reservation',
      createdAt: new Date(this.clock.now()),
    };
    this.ledger.set(ledgerEntry.id, ledgerEntry);

    return { ...ledgerEntry };
  }

  public async markAmbiguous(requestId: string, _reason?: string): Promise<void> {
    const idemp = this.idempotencyByRequestId.get(requestId);
    if (!idemp) {
      throw new Error(`No reservation found for request ${requestId}`);
    }

    if (idemp.status === 'COMPLETED' || idemp.status === 'FAILED') {
      return; // Already finalized
    }

    idemp.status = 'AMBIGUOUS';
    idemp.updatedAt = new Date();
  }

  public async findExpiredProcessingLeases(now: Date): Promise<IdempotencyRecord[]> {
    const expired: IdempotencyRecord[] = [];
    for (const record of this.idempotencyByRequestId.values()) {
      if (record.status === 'PROCESSING' && record.leaseExpiresAt.getTime() <= now.getTime()) {
        expired.push({ ...record });
      }
    }
    return expired;
  }

  public async resolveAmbiguous(
    requestId: string,
    action: 'CAPTURE' | 'RELEASE',
    chargeMicros?: bigint,
    providerId?: string,
    responseStatus?: number,
    responseBody?: unknown
  ): Promise<void> {
    const idemp = this.idempotencyByRequestId.get(requestId);
    if (!idemp || idemp.status !== 'AMBIGUOUS') {
      throw new Error(`Record ${requestId} is not in AMBIGUOUS state`);
    }

    if (action === 'CAPTURE') {
      const finalCharge = chargeMicros ?? idemp.reservedAmountMicros;
      await this.capture(
        requestId,
        finalCharge,
        providerId ?? idemp.providerId ?? 'manual_reconciliation',
        responseStatus ?? 200,
        {},
        responseBody ?? { reconciled: true }
      );
    } else {
      await this.release(requestId, 'Reconciliation confirmed non-execution');
    }
  }

  public async getLedgerEntries(orgId: string): Promise<LedgerEntryRecord[]> {
    const entries: LedgerEntryRecord[] = [];
    for (const entry of this.ledger.values()) {
      if (entry.orgId === orgId) {
        entries.push({ ...entry });
      }
    }
    return entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  public async getIdempotencyRecord(orgId: string, key: string): Promise<IdempotencyRecord | null> {
    const record = this.idempotencyByKey.get(`${orgId}:${key}`);
    return record ? { ...record } : null;
  }

  public async getIdempotencyRecordByRequestId(requestId: string): Promise<IdempotencyRecord | null> {
    const record = this.idempotencyByRequestId.get(requestId);
    return record ? { ...record } : null;
  }

  public clear(): void {
    this.accounts.clear();
    this.ledger.clear();
    this.idempotencyByKey.clear();
    this.idempotencyByRequestId.clear();
  }
}

export class PostgresBillingRepository implements IBillingRepository {
  private pool: pg.Pool;

  constructor(pool: pg.Pool = Database.getPool()) {
    this.pool = pool;
  }

  public async getAccount(orgId: string): Promise<AccountRecord | null> {
    const query = `
      SELECT 
        id, 
        org_id AS "orgId", 
        currency, 
        balance_micros AS "balanceMicros", 
        reserved_micros AS "reservedMicros", 
        version, 
        created_at AS "createdAt", 
        updated_at AS "updatedAt"
      FROM accounts
      WHERE org_id = $1
      LIMIT 1;
    `;
    const res = await this.pool.query(query, [orgId]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      ...row,
      balanceMicros: BigInt(row.balanceMicros),
      reservedMicros: BigInt(row.reservedMicros),
    };
  }

  public async createAccount(orgId: string, initialBalanceMicros = 0n): Promise<AccountRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const query = `
        INSERT INTO accounts (org_id, balance_micros, reserved_micros)
        VALUES ($1, $2, 0)
        RETURNING 
          id, 
          org_id AS "orgId", 
          currency, 
          balance_micros AS "balanceMicros", 
          reserved_micros AS "reservedMicros", 
          version, 
          created_at AS "createdAt", 
          updated_at AS "updatedAt";
      `;
      const res = await client.query(query, [orgId, initialBalanceMicros.toString()]);
      const acc = res.rows[0];

      if (initialBalanceMicros > 0n) {
        const ledgerQuery = `
          INSERT INTO ledger_entries (account_id, org_id, type, amount_micros, balance_after_micros, reserved_after_micros, description)
          VALUES ($1, $2, 'DEPOSIT', $3, $4, 0, 'Initial Account Seed Deposit');
        `;
        await client.query(ledgerQuery, [
          acc.id,
          orgId,
          initialBalanceMicros.toString(),
          initialBalanceMicros.toString(),
        ]);
      }

      await client.query('COMMIT');
      return {
        ...acc,
        balanceMicros: BigInt(acc.balanceMicros),
        reservedMicros: BigInt(acc.reservedMicros),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async deposit(orgId: string, amountMicros: bigint, description?: string): Promise<LedgerEntryRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const updateQuery = `
        UPDATE accounts
        SET balance_micros = balance_micros + $1, updated_at = NOW(), version = version + 1
        WHERE org_id = $2
        RETURNING id, balance_micros AS "balanceMicros", reserved_micros AS "reservedMicros";
      `;
      const updateRes = await client.query(updateQuery, [amountMicros.toString(), orgId]);
      if (updateRes.rows.length === 0) {
        throw new Error(`Account not found for org ${orgId}`);
      }
      const acc = updateRes.rows[0];

      const ledgerQuery = `
        INSERT INTO ledger_entries (account_id, org_id, type, amount_micros, balance_after_micros, reserved_after_micros, description)
        VALUES ($1, $2, 'DEPOSIT', $3, $4, $5, $6)
        RETURNING 
          id, 
          account_id AS "accountId", 
          org_id AS "orgId", 
          type, 
          amount_micros AS "amountMicros", 
          balance_after_micros AS "balanceAfterMicros", 
          reserved_after_micros AS "reservedAfterMicros", 
          description, 
          created_at AS "createdAt";
      `;
      const ledgerRes = await client.query(ledgerQuery, [
        acc.id,
        orgId,
        amountMicros.toString(),
        acc.balanceMicros,
        acc.reservedMicros,
        description ?? 'Deposit',
      ]);

      await client.query('COMMIT');
      const row = ledgerRes.rows[0];
      return {
        ...row,
        amountMicros: BigInt(row.amountMicros),
        balanceAfterMicros: BigInt(row.balanceAfterMicros),
        reservedAfterMicros: BigInt(row.reservedAfterMicros),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async reserve(
    orgId: string,
    requestId: string,
    idempotencyKey: string | null,
    requestHash: string,
    holdMicros: bigint,
    leaseExpiresAt: Date
  ): Promise<ReservationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Check idempotency if key provided
      if (idempotencyKey) {
        const idempCheck = await client.query(
          'SELECT * FROM idempotency_records WHERE org_id = $1 AND key = $2 FOR UPDATE',
          [orgId, idempotencyKey]
        );

        if (idempCheck.rows.length > 0) {
          const existing = idempCheck.rows[0];
          if (existing.request_hash !== requestHash) {
            await client.query('ROLLBACK');
            throw new IdempotencyPayloadMismatchError();
          }

          if (existing.status === 'COMPLETED') {
            await client.query('COMMIT');
            return {
              isReplay: true,
              record: this.mapIdempotencyRow(existing),
            };
          }

          if (existing.status === 'PROCESSING') {
            if (new Date(existing.lease_expires_at).getTime() > Date.now()) {
              await client.query('ROLLBACK');
              throw new IdempotencyConflictError();
            }
          }

          if (existing.status === 'AMBIGUOUS') {
            await client.query('ROLLBACK');
            throw new IdempotencyConflictError(
              'Previous request resulted in an ambiguous outcome awaiting reconciliation'
            );
          }
        }
      }

      // 2. Atomic Account Reservation with Solvency Check
      const updateQuery = `
        UPDATE accounts
        SET reserved_micros = reserved_micros + $1, updated_at = NOW(), version = version + 1
        WHERE org_id = $2 AND (balance_micros - reserved_micros) >= $1
        RETURNING id, balance_micros AS "balanceMicros", reserved_micros AS "reservedMicros";
      `;
      const updateRes = await client.query(updateQuery, [holdMicros.toString(), orgId]);
      if (updateRes.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new InsufficientFundsError('Insufficient available funds for reservation');
      }

      const acc = updateRes.rows[0];

      // 3. Write Ledger Entry
      await client.query(
        `INSERT INTO ledger_entries (account_id, org_id, request_id, idempotency_key, type, amount_micros, balance_after_micros, reserved_after_micros, description)
         VALUES ($1, $2, $3, $4, 'HOLD', $5, $6, $7, 'Pre-flight balance reservation')`,
        [
          acc.id,
          orgId,
          requestId,
          idempotencyKey,
          holdMicros.toString(),
          acc.balanceMicros,
          acc.reservedMicros,
        ]
      );

      // 4. Upsert Idempotency Record
      const key = idempotencyKey ?? `internal_${requestId}`;
      await client.query(
        `INSERT INTO idempotency_records (org_id, key, request_hash, status, request_id, reserved_amount_micros, lease_expires_at)
         VALUES ($1, $2, $3, 'PROCESSING', $4, $5, $6)
         ON CONFLICT (org_id, key) DO UPDATE 
         SET status = 'PROCESSING', request_id = $4, reserved_amount_micros = $5, lease_expires_at = $6, updated_at = NOW()`,
        [orgId, key, requestHash, requestId, holdMicros.toString(), leaseExpiresAt]
      );

      await client.query('COMMIT');

      return {
        isReplay: false,
        requestId,
        idempotencyKey: idempotencyKey ?? undefined,
        holdAmountMicros: holdMicros,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async capture(
    requestId: string,
    chargeMicros: bigint,
    providerId: string,
    responseStatus: number,
    responseHeaders: Record<string, string>,
    responseBody: unknown
  ): Promise<LedgerEntryRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const idempRes = await client.query(
        'SELECT * FROM idempotency_records WHERE request_id = $1 FOR UPDATE',
        [requestId]
      );
      if (idempRes.rows.length === 0) {
        throw new Error(`No reservation found for request ${requestId}`);
      }

      const idemp = idempRes.rows[0];
      if (idemp.status === 'COMPLETED' || idemp.status === 'FAILED') {
        throw new DuplicateSettlementError();
      }

      const reservedMicros = BigInt(idemp.reserved_amount_micros);

      // Atomic Balance Deduction and Hold Release
      const updateAcc = `
        UPDATE accounts
        SET balance_micros = balance_micros - $1, reserved_micros = reserved_micros - $2, updated_at = NOW(), version = version + 1
        WHERE org_id = $3
        RETURNING id, balance_micros AS "balanceMicros", reserved_micros AS "reservedMicros";
      `;
      const accRes = await client.query(updateAcc, [
        chargeMicros.toString(),
        reservedMicros.toString(),
        idemp.org_id,
      ]);
      const acc = accRes.rows[0];

      // Update Idempotency
      await client.query(
        `UPDATE idempotency_records
         SET status = 'COMPLETED', captured_amount_micros = $1, provider_id = $2, response_status = $3, response_headers = $4, response_body = $5, updated_at = NOW()
         WHERE request_id = $6`,
        [
          chargeMicros.toString(),
          providerId,
          responseStatus,
          JSON.stringify(responseHeaders),
          JSON.stringify(responseBody),
          requestId,
        ]
      );

      // Append Ledger Capture
      const ledgerRes = await client.query(
        `INSERT INTO ledger_entries (account_id, org_id, request_id, idempotency_key, type, amount_micros, balance_after_micros, reserved_after_micros, description)
         VALUES ($1, $2, $3, $4, 'CAPTURE', $5, $6, $7, $8)
         RETURNING 
           id, 
           account_id AS "accountId", 
           org_id AS "orgId", 
           type, 
           amount_micros AS "amountMicros", 
           balance_after_micros AS "balanceAfterMicros", 
           reserved_after_micros AS "reservedAfterMicros", 
           description, 
           created_at AS "createdAt";`,
        [
          acc.id,
          idemp.org_id,
          requestId,
          idemp.key,
          chargeMicros.toString(),
          acc.balanceMicros,
          acc.reservedMicros,
          `Settled execution via ${providerId}`,
        ]
      );

      await client.query('COMMIT');
      const row = ledgerRes.rows[0];
      return {
        ...row,
        amountMicros: BigInt(row.amountMicros),
        balanceAfterMicros: BigInt(row.balanceAfterMicros),
        reservedAfterMicros: BigInt(row.reservedAfterMicros),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async release(requestId: string, reason?: string): Promise<LedgerEntryRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const idempRes = await client.query(
        'SELECT * FROM idempotency_records WHERE request_id = $1 FOR UPDATE',
        [requestId]
      );
      if (idempRes.rows.length === 0) {
        throw new Error(`No reservation found for request ${requestId}`);
      }

      const idemp = idempRes.rows[0];
      if (idemp.status === 'COMPLETED' || idemp.status === 'FAILED') {
        throw new DuplicateSettlementError();
      }

      const reservedMicros = BigInt(idemp.reserved_amount_micros);

      // Release Hold
      const updateAcc = `
        UPDATE accounts
        SET reserved_micros = reserved_micros - $1, updated_at = NOW(), version = version + 1
        WHERE org_id = $2
        RETURNING id, balance_micros AS "balanceMicros", reserved_micros AS "reservedMicros";
      `;
      const accRes = await client.query(updateAcc, [reservedMicros.toString(), idemp.org_id]);
      const acc = accRes.rows[0];

      await client.query(
        `UPDATE idempotency_records SET status = 'FAILED', updated_at = NOW() WHERE request_id = $1`,
        [requestId]
      );

      const ledgerRes = await client.query(
        `INSERT INTO ledger_entries (account_id, org_id, request_id, idempotency_key, type, amount_micros, balance_after_micros, reserved_after_micros, description)
         VALUES ($1, $2, $3, $4, 'RELEASE', $5, $6, $7, $8)
         RETURNING 
           id, 
           account_id AS "accountId", 
           org_id AS "orgId", 
           type, 
           amount_micros AS "amountMicros", 
           balance_after_micros AS "balanceAfterMicros", 
           reserved_after_micros AS "reservedAfterMicros", 
           description, 
           created_at AS "createdAt";`,
        [
          acc.id,
          idemp.org_id,
          requestId,
          idemp.key,
          reservedMicros.toString(),
          acc.balanceMicros,
          acc.reservedMicros,
          reason ?? 'Released failed reservation',
        ]
      );

      await client.query('COMMIT');
      const row = ledgerRes.rows[0];
      return {
        ...row,
        amountMicros: BigInt(row.amountMicros),
        balanceAfterMicros: BigInt(row.balanceAfterMicros),
        reservedAfterMicros: BigInt(row.reservedAfterMicros),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async markAmbiguous(requestId: string, _reason?: string): Promise<void> {
    await this.pool.query(
      `UPDATE idempotency_records SET status = 'AMBIGUOUS', updated_at = NOW() WHERE request_id = $1 AND status = 'PROCESSING'`,
      [requestId]
    );
  }

  public async findExpiredProcessingLeases(now: Date): Promise<IdempotencyRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM idempotency_records WHERE status = 'PROCESSING' AND lease_expires_at <= $1`,
      [now]
    );
    return res.rows.map((row) => this.mapIdempotencyRow(row));
  }

  public async resolveAmbiguous(
    requestId: string,
    action: 'CAPTURE' | 'RELEASE',
    chargeMicros?: bigint,
    providerId?: string,
    responseStatus?: number,
    responseBody?: unknown
  ): Promise<void> {
    if (action === 'CAPTURE') {
      const idemp = await this.getIdempotencyRecordByRequestId(requestId);
      if (!idemp) throw new Error(`Record ${requestId} not found`);
      await this.capture(
        requestId,
        chargeMicros ?? idemp.reservedAmountMicros,
        providerId ?? 'manual_reconciliation',
        responseStatus ?? 200,
        {},
        responseBody ?? { reconciled: true }
      );
    } else {
      await this.release(requestId, 'Reconciliation confirmed non-execution');
    }
  }

  public async getLedgerEntries(orgId: string): Promise<LedgerEntryRecord[]> {
    const res = await this.pool.query(
      `SELECT 
         id, 
         account_id AS "accountId", 
         org_id AS "orgId", 
         request_id AS "requestId", 
         idempotency_key AS "idempotencyKey", 
         type, 
         amount_micros AS "amountMicros", 
         balance_after_micros AS "balanceAfterMicros", 
         reserved_after_micros AS "reservedAfterMicros", 
         description, 
         created_at AS "createdAt"
       FROM ledger_entries
       WHERE org_id = $1
       ORDER BY created_at ASC`,
      [orgId]
    );
    return res.rows.map((row) => ({
      ...row,
      amountMicros: BigInt(row.amountMicros),
      balanceAfterMicros: BigInt(row.balanceAfterMicros),
      reservedAfterMicros: BigInt(row.reservedAfterMicros),
    }));
  }

  public async getIdempotencyRecord(orgId: string, key: string): Promise<IdempotencyRecord | null> {
    const res = await this.pool.query(
      'SELECT * FROM idempotency_records WHERE org_id = $1 AND key = $2 LIMIT 1',
      [orgId, key]
    );
    if (res.rows.length === 0) return null;
    return this.mapIdempotencyRow(res.rows[0]);
  }

  public async getIdempotencyRecordByRequestId(requestId: string): Promise<IdempotencyRecord | null> {
    const res = await this.pool.query(
      'SELECT * FROM idempotency_records WHERE request_id = $1 LIMIT 1',
      [requestId]
    );
    if (res.rows.length === 0) return null;
    return this.mapIdempotencyRow(res.rows[0]);
  }

  private mapIdempotencyRow(row: any): IdempotencyRecord {
    return {
      id: row.id,
      orgId: row.org_id,
      key: row.key,
      requestHash: row.request_hash,
      status: row.status,
      requestId: row.request_id,
      reservedAmountMicros: BigInt(row.reserved_amount_micros),
      capturedAmountMicros: BigInt(row.captured_amount_micros),
      providerId: row.provider_id ?? undefined,
      responseStatus: row.response_status ?? undefined,
      responseHeaders: row.response_headers ?? undefined,
      responseBody: row.response_body ?? undefined,
      leaseExpiresAt: new Date(row.lease_expires_at),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
