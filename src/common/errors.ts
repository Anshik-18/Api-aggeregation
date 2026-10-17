export abstract class AppError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly errorCode: string;
  public readonly isOperational: boolean = true;
  public readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  public toJSON() {
    return {
      error: {
        code: this.errorCode,
        message: this.message,
        details: this.details,
      },
    };
  }
}

export class UnauthorizedError extends AppError {
  public readonly statusCode = 401;
  public readonly errorCode = 'UNAUTHORIZED';

  constructor(message = 'Invalid or missing API key') {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  public readonly statusCode = 403;
  public readonly errorCode = 'FORBIDDEN';

  constructor(message = 'Access forbidden') {
    super(message);
  }
}

export class NotFoundError extends AppError {
  public readonly statusCode = 404;
  public readonly errorCode = 'NOT_FOUND';

  constructor(message = 'Resource not found') {
    super(message);
  }
}

export class ValidationError extends AppError {
  public readonly statusCode = 400;
  public readonly errorCode = 'VALIDATION_ERROR';

  constructor(message = 'Validation failed', details?: unknown) {
    super(message, details);
  }
}

export class UpstreamProviderError extends AppError {
  public readonly statusCode: number;
  public readonly errorCode: string = 'UPSTREAM_PROVIDER_ERROR';
  public readonly providerId: string;
  public readonly retryable: boolean;

  constructor(
    providerId: string,
    message: string,
    statusCode = 502,
    retryable = false,
    details?: unknown
  ) {
    super(`Provider [${providerId}] failed: ${message}`, details);
    this.providerId = providerId;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class UpstreamTimeoutError extends UpstreamProviderError {
  public readonly errorCode = 'UPSTREAM_TIMEOUT';

  constructor(providerId: string, timeoutMs: number) {
    super(providerId, `Request exceeded timeout of ${timeoutMs}ms`, 504, true);
  }
}

export class ProviderUnavailableError extends AppError {
  public readonly statusCode = 503;
  public readonly errorCode = 'PROVIDER_UNAVAILABLE';

  constructor(message = 'No healthy providers available to serve the request') {
    super(message);
  }
}

export class InsufficientFundsError extends AppError {
  public readonly statusCode = 402;
  public readonly errorCode = 'INSUFFICIENT_FUNDS';

  constructor(message = 'Account balance is insufficient for requested operation', details?: unknown) {
    super(message, details);
  }
}

export class IdempotencyConflictError extends AppError {
  public readonly statusCode = 409;
  public readonly errorCode = 'IDEMPOTENCY_CONFLICT';

  constructor(message = 'A request with this idempotency key is currently in progress or awaiting resolution') {
    super(message);
  }
}

export class IdempotencyPayloadMismatchError extends AppError {
  public readonly statusCode = 422;
  public readonly errorCode = 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH';

  constructor(message = 'Idempotency key reused with different request payload') {
    super(message);
  }
}

export class DuplicateSettlementError extends AppError {
  public readonly statusCode = 409;
  public readonly errorCode = 'DUPLICATE_SETTLEMENT';

  constructor(message = 'Transaction has already been captured, released, or resolved') {
    super(message);
  }
}

export class AmbiguousOutcomeError extends AppError {
  public readonly statusCode = 504;
  public readonly errorCode = 'AMBIGUOUS_TIMEOUT';
  public readonly requestId: string;

  constructor(requestId: string, message = 'Upstream execution state is uncertain. Reservation retained pending reconciliation.') {
    super(message, { requestId, state: 'AMBIGUOUS' });
    this.requestId = requestId;
  }
}

export class RateLimitExceededError extends AppError {
  public readonly statusCode = 429;
  public readonly errorCode = 'RATE_LIMIT_EXCEEDED';
  public readonly retryAfterSeconds: number;

  constructor(message = 'Rate limit exceeded. Please wait before retrying.', retryAfterSeconds = 1, details?: unknown) {
    super(message, details);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

