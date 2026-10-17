export type LedgerEntryType = 'DEPOSIT' | 'HOLD' | 'CAPTURE' | 'RELEASE' | 'REFUND';

export type IdempotencyStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'AMBIGUOUS';

export interface AccountRecord {
  id: string;
  orgId: string;
  currency: string;
  balanceMicros: bigint;
  reservedMicros: bigint;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LedgerEntryRecord {
  id: string;
  accountId: string;
  orgId: string;
  requestId?: string;
  idempotencyKey?: string;
  type: LedgerEntryType;
  amountMicros: bigint;
  balanceAfterMicros: bigint;
  reservedAfterMicros: bigint;
  description?: string;
  createdAt: Date;
}

export interface IdempotencyRecord {
  id: string;
  orgId: string;
  key: string;
  requestHash: string;
  status: IdempotencyStatus;
  requestId: string;
  reservedAmountMicros: bigint;
  capturedAmountMicros: bigint;
  providerId?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  leaseExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ReservationResult =
  | {
      isReplay: true;
      record: IdempotencyRecord;
    }
  | {
      isReplay: false;
      requestId: string;
      idempotencyKey?: string;
      holdAmountMicros: bigint;
    };
