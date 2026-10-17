-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Organizations
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    billing_mode VARCHAR(20) NOT NULL DEFAULT 'PREPAID' CHECK (billing_mode IN ('PREPAID', 'POSTPAID')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    key_hash VARCHAR(64) NOT NULL UNIQUE,     -- SHA-256 hash of the raw API key
    key_prefix VARCHAR(16) NOT NULL,          -- e.g., "ak_live_a1b2..."
    name VARCHAR(100) NOT NULL DEFAULT 'Default API Key',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    rate_limit_per_sec INTEGER NOT NULL DEFAULT 50,
    rate_limit_window_ms INTEGER NOT NULL DEFAULT 1000,
    pricing_multiplier_percent INTEGER NOT NULL DEFAULT 150,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(org_id);

-- Upstream Providers Registry
CREATE TABLE IF NOT EXISTS providers (
    id VARCHAR(50) PRIMARY KEY,              -- e.g. "provider_alpha", "provider_beta"
    name VARCHAR(100) NOT NULL,
    base_url VARCHAR(255) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    cost_per_unit NUMERIC(12, 6) NOT NULL DEFAULT 0.000000,
    max_concurrency INTEGER NOT NULL DEFAULT 100,
    rate_limit_per_sec INTEGER NOT NULL DEFAULT 100,
    timeout_ms INTEGER NOT NULL DEFAULT 5000,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Initial Mock Provider Seeds
INSERT INTO providers (id, name, base_url, is_enabled, cost_per_unit, max_concurrency, rate_limit_per_sec, timeout_ms)
VALUES 
    ('provider_alpha', 'Provider Alpha (Budget)', 'http://mock-upstream:4001', TRUE, 0.001000, 50, 100, 3000),
    ('provider_beta', 'Provider Beta (High Speed)', 'http://mock-upstream:4002', TRUE, 0.003000, 150, 300, 1500)
ON CONFLICT (id) DO NOTHING;

-- Phase 3: Prepaid Accounts
-- Monetary amounts stored as BIGINT microdollars (1 USD = 1,000,000 micros)
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    balance_micros BIGINT NOT NULL DEFAULT 0,
    reserved_micros BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_positive_available CHECK (balance_micros - reserved_micros >= 0),
    CONSTRAINT chk_positive_reserved CHECK (reserved_micros >= 0)
);

CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts(org_id);

-- Phase 3: Immutable Financial Ledger
CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    request_id VARCHAR(64) NULL,
    idempotency_key VARCHAR(128) NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('DEPOSIT', 'HOLD', 'CAPTURE', 'RELEASE', 'REFUND')),
    amount_micros BIGINT NOT NULL,
    balance_after_micros BIGINT NOT NULL,
    reserved_after_micros BIGINT NOT NULL,
    description TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ledger_request_type UNIQUE (request_id, type)
);

CREATE INDEX IF NOT EXISTS idx_ledger_org ON ledger_entries(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_request ON ledger_entries(request_id);

-- Phase 3: Durable Idempotency Records
CREATE TABLE IF NOT EXISTS idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    key VARCHAR(128) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED', 'AMBIGUOUS')),
    request_id VARCHAR(64) NOT NULL UNIQUE,
    reserved_amount_micros BIGINT NOT NULL DEFAULT 0,
    captured_amount_micros BIGINT NOT NULL DEFAULT 0,
    provider_id VARCHAR(50) NULL,
    response_status INTEGER NULL,
    response_headers JSONB NULL,
    response_body JSONB NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_idempotency_org_key UNIQUE (org_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_org_key ON idempotency_records(org_id, key);
CREATE INDEX IF NOT EXISTS idx_idempotency_lease ON idempotency_records(status, lease_expires_at) WHERE status = 'PROCESSING';
