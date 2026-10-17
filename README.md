# API Aggregation & Resilience Platform

High-performance, deterministic API aggregation gateway acting as an intermediary between customers and multiple upstream API providers. Built with TypeScript, Fastify, PostgreSQL, and Redis.

---

## Architecture Overview

```
                      +---------------------------------------+
                      |         Fastify API Gateway           |
                      +---------------------------------------+
                                          |
        +---------------------------------+---------------------------------+
        |                                 |                                 |
        v                                 v                                 v
+-------------------+           +-------------------+             +--------------------+
|  Authentication   |           |    Distributed    |             |    Pre-Flight      |
|  & API Key Guard  |           |   Rate Limiter    |             | Financial Hold     |
+-------------------+           | (Redis Lua / Mem) |             | (Postgres Reserve) |
                                +-------------------+             +--------------------+
                                          |                                 |
        +---------------------------------+---------------------------------+
        |
        v
+-------------------+
|  Response Cache   | ----[ HIT ]----> Settle with Discount & Return (0 Upstream Latency)
| & Coalescing Lock |
+-------------------+
        |
     [ MISS ]
        |
        v
+-------------------+
|    Cost-Aware     | ----> Provider Alpha ($0.001000/call)
|  Dynamic Router   | ----> Provider Beta  ($0.003000/call)
| (Circuit Breakers)| ----> Failover & Fallback Retries
+-------------------+
        |
        v
+-------------------+
| Atomic Settlement | ----> Capture Charge in Postgres Ledger & Decrement Balance
| & Cache Broadcast | ----> Notify Coalesced Waiters via Redis Pub/Sub
+-------------------+
```

### Core Invariants & Engineering Guarantees
1. **Financial Solvency (`chk_positive_available`)**: All balances and holds use 64-bit BigInt microdollars ($1.00 = 1,000,000 micros). Database check constraints make overdrafts and race conditions impossible.
2. **Deterministic Routing**: Strictly prefers cheapest eligible provider, filtering out saturated or circuit-broken upstreams with deterministic tie-breaking.
3. **Durable Idempotency**: Cryptographically hashes canonical request payloads and tracks state in PostgreSQL. Replays never hit upstream or double-charge; modified payloads on reused keys fail with `422`.
4. **Single-Flight Coalescing**: Duplicate concurrent cache misses elect a single leader via Redis distributed locking (`SET NX PX`), and broadcast results to waiters via Redis Pub/Sub. Every coalesced request maintains its own billing hold and settlement.
5. **Circuit Breakers**: State machine (`CLOSED`, `OPEN`, `HALF_OPEN`) isolates failing providers using rolling-window error rates and exponential backoff cooldowns. Client 4xx errors never trip provider breakers.
6. **Graceful Degradation**: If Redis is offline, caching safely treats requests as misses and the rate limiter falls back to an in-memory sliding window without dropping customer traffic.

---

## Prerequisites

* **Node.js**: `v20.x` or `v22.x` (ESM native)
* **Docker & Docker Compose**: For PostgreSQL 16 and Redis 7
* **curl** or **PowerShell**: For testing the HTTP endpoints

---

## Quick Start & Setup Guide

### 1. Clone & Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy the template configuration:
```bash
cp .env.example .env
```
Default ports in `.env`:
* Gateway Server: `http://localhost:3000`
* PostgreSQL: `localhost:5434` (avoids conflicts with host PostgreSQL on 5432)
* Redis: `localhost:6379`

### 3. Start PostgreSQL and Redis Containers
```bash
docker compose -f docker-compose.yml up -d
```
Verify containers are healthy:
```bash
docker ps --filter "name=api_provider"
```

### 4. Seed Demo Data
Populates the database with initial organizations, accounts, ledger entries, upstream providers, and demo API keys:
```bash
npm run seed
```
**Seeded Demo Keys**:
* **Standard Key (1.5x Multiplier - $25.00)**: `ak_live_acme_super_secret_key_456` ($0.001500 / $0.004500)
* **VIP Enterprise Key (1.1x Multiplier - $25.00)**: `ak_live_vip_enterprise_key_888` ($0.001100 / $0.003300)
* **Premium Retail Key (2.0x Multiplier - $25.00)**: `ak_live_premium_retail_key_777` ($0.002000 / $0.006000)
* **Rate-Limited Key (2 req / 4s)**: `ak_live_rate_limited_key_123` (Easy manual Postman testing)
* **Unfunded Key ($0.00 Balance)**: `ak_live_broke_customer_no_funds_999` (Tests 402 Insufficient Funds)

### 5. Run the Automated Test Suite
Executes all 100 unit and integration tests across 14 test suites:
```bash
npm test
```

### 6. Build & Start the Application
```bash
# Build TypeScript
npm run build

# Start Gateway Server
npm start
```
The server will output:
```
Gateway server listening at http://127.0.0.1:3000
```

### 7. Start the Frontend Dashboard (Next.js)
In a second terminal window:
```bash
# Build and start Next.js Dashboard
npm run frontend:build
npm run frontend:start
```
Open your browser at:
```
http://localhost:3001
```
The dashboard automatically connects to the backend at `http://localhost:3000` and provides:
1. **Overview View**: Real-time account balance, settled customer charges, provider costs, provider health & circuit breaker states.
2. **API Playground**: Interactive request builder with template presets (Chat Completion, Market Data, Idempotency test), routing & caching directives, and live execution telemetry.
3. **Usage & Billing**: Available vs reserved balance breakdown, lease reconciliation trigger, and full immutable financial audit ledger with event filtering.

---

## Repeatable Demo Sequence

Below is a self-contained sequence of API requests demonstrating all key platform capabilities.
> **Tip for Windows PowerShell**: Use `curl.exe` instead of `curl` (to avoid PowerShell's built-in `Invoke-WebRequest` alias) and pass JSON bodies with `--data-raw '{"key": "value"}'` or use `Invoke-RestMethod`. On macOS/Linux/Git Bash, standard `curl` syntax works as shown.

### Step 1: Health & Readiness Check (Public)
Checks PostgreSQL pool latency and Redis connectivity:
```bash
curl -s http://localhost:3000/health
```
```json
{
  "status": "healthy",
  "timestamp": "2026-10-17T13:00:00.000Z",
  "components": {
    "database": { "isHealthy": true, "latencyMs": 5 },
    "redis": { "isHealthy": true, "latencyMs": 2 }
  }
}
```

---

### Step 2: Authentication & Prepaid Balance Verification
Query prepaid balance using the funded demo key:
```bash
curl -s http://localhost:3000/v1/billing/account \
  -H "x-api-key: ak_live_acme_super_secret_key_456"
```
```json
{
  "success": true,
  "data": {
    "orgId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "currency": "USD",
    "balance": "25.000000",
    "reservedBalance": "0.000000",
    "availableBalance": "25.000000",
    "balanceMicros": "25000000"
  }
}
```

---

### Step 3: Cheapest Eligible Provider Selection
Execute a request. The gateway automatically routes to the lowest-cost provider (`provider_alpha` at $0.001000):
```bash
curl -i -s -X POST http://localhost:3000/v1/gateway/execute \
  -H "x-api-key: ak_live_acme_super_secret_key_456" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "/v1/chat/completions", "method": "POST", "body": {"prompt": "What is deterministic routing?"}}'
```
* **Headers**: `x-customer-charge: 0.001500`, `x-cache: MISS`, `x-coalesced: false`
* **Response Body**:
```json
{
  "success": true,
  "data": {
    "provider": "provider_alpha",
    "status": "completed",
    "usage": { "units": 1, "unitCost": 0.001 }
  },
  "meta": {
    "providerId": "provider_alpha",
    "latencyMs": 85,
    "cached": false
  }
}
```

---

### Step 4: Targeted Provider Preference Override
Request explicit routing to `provider_beta` ($0.003000) using `x-provider-preference`:
```bash
curl -i -s -X POST http://localhost:3000/v1/gateway/execute \
  -H "x-api-key: ak_live_acme_super_secret_key_456" \
  -H "x-provider-preference: provider_beta" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "/v1/chat/completions", "method": "POST", "body": {"prompt": "Targeted test"}}'
```
* **Headers**: `x-customer-charge: 0.004500`
* **Result**: Routed directly to `provider_beta`.

---

### Step 5: Durable Idempotency & Payload Mismatch Protection
Submit a request with an `Idempotency-Key`:
```bash
curl -s -X POST http://localhost:3000/v1/gateway/execute \
  -H "x-api-key: ak_live_acme_super_secret_key_456" \
  -H "idempotency-key: demo_key_1001" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "/v1/chat/completions", "method": "POST", "body": {"prompt": "Idempotent payment"}}'
```
* **Result**: First call executes upstream (`cached: false`).

**Replay**: Resubmit the exact same key and payload:
```bash
curl -s -X POST http://localhost:3000/v1/gateway/execute \
  -H "x-api-key: ak_live_acme_super_secret_key_456" \
  -H "idempotency-key: demo_key_1001" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "/v1/chat/completions", "method": "POST", "body": {"prompt": "Idempotent payment"}}'
```
* **Result**: Returned instantly from PostgreSQL with `cached: true` and 0 upstream latency. Customer is not double-charged.

**Payload Mismatch**: Resubmit the same key with modified body:
```bash
curl -i -s -X POST http://localhost:3000/v1/gateway/execute \
  -H "x-api-key: ak_live_acme_super_secret_key_456" \
  -H "idempotency-key: demo_key_1001" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "/v1/chat/completions", "method": "POST", "body": {"prompt": "Tampered payload"}}'
```
* **Result**: `HTTP 422 Unprocessable Entity` (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`).

---

### Step 6: Response Caching & Cache-Hit Discount
**First Call (Cache MISS)**:
```bash
curl -i -s -X POST http://localhost:3000/v1/gateway/execute \
  -H "x-api-key: ak_live_acme_super_secret_key_456" \
  -H "x-cache-eligible: true" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "/v1/data/market", "method": "POST", "body": {"ticker": "MSFT"}}'
```
* **Headers**: `x-cache: MISS`, `x-customer-charge: 0.001500`

**Second Call (Cache HIT)**:
```bash
curl -i -s -X POST http://localhost:3000/v1/gateway/execute \
  -H "x-api-key: ak_live_acme_super_secret_key_456" \
  -H "x-cache-eligible: true" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "/v1/data/market", "method": "POST", "body": {"ticker": "MSFT"}}'
```
* **Headers**: `x-cache: HIT`, `x-customer-charge: 0.000750` *(50% cache discount applied; 0 upstream cost)*
* **Latency**: ~1ms

---

### Step 7: Distributed Rate Limiting (429 Too Many Requests)
Send rapid requests using the rate-limited key (limit: 2 req/s):
```bash
curl -i -s -X POST http://localhost:3000/v1/gateway/execute -H "x-api-key: ak_live_rate_limited_key_123" -H "Content-Type: application/json" -d '{"endpoint":"/v1/chat/completions","method":"POST"}'
curl -i -s -X POST http://localhost:3000/v1/gateway/execute -H "x-api-key: ak_live_rate_limited_key_123" -H "Content-Type: application/json" -d '{"endpoint":"/v1/chat/completions","method":"POST"}'
curl -i -s -X POST http://localhost:3000/v1/gateway/execute -H "x-api-key: ak_live_rate_limited_key_123" -H "Content-Type: application/json" -d '{"endpoint":"/v1/chat/completions","method":"POST"}'
```
* **Result on 3rd request**:
  * `HTTP/1.1 429 Too Many Requests`
  * `retry-after: 1`
  * `x-ratelimit-limit: 2`
  * `x-ratelimit-remaining: 0`
  * `{"code":"RATE_LIMIT_EXCEEDED","message":"Rate limit of 2 req/s exceeded..."}`

---

### Step 8: Pre-Execution Rejection on Insufficient Funds (402)
Attempt a request using an account with zero balance (`ak_live_broke_customer_no_funds_999`):
```bash
curl -i -s -X POST http://localhost:3000/v1/gateway/execute \
  -H "x-api-key: ak_live_broke_customer_no_funds_999" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "/v1/chat/completions", "method": "POST"}'
```
* **Result**:
  * `HTTP/1.1 402 Payment Required`
  * `{"code":"INSUFFICIENT_FUNDS","message":"Insufficient available funds for reservation"}`
  * Zero upstream calls made, zero balance overdrafts.

---

### Step 9: Immutable Financial Audit Trail
View the complete append-only event ledger:
```bash
curl -s http://localhost:3000/v1/billing/ledger \
  -H "x-api-key: ak_live_acme_super_secret_key_456"
```
```json
{
  "success": true,
  "data": [
    {
      "type": "DEPOSIT",
      "amount": "25.000000",
      "balanceAfter": "25.000000",
      "description": "Initial Account Funding ($25.00)"
    },
    {
      "type": "HOLD",
      "amount": "0.004500",
      "balanceAfter": "25.000000",
      "reservedAfter": "0.004500",
      "description": "Pre-flight balance reservation"
    },
    {
      "type": "CAPTURE",
      "amount": "0.001500",
      "balanceAfter": "24.998500",
      "reservedAfter": "0.000000",
      "description": "Settled execution via provider_alpha"
    },
    {
      "type": "CAPTURE",
      "amount": "0.000750",
      "balanceAfter": "24.997750",
      "reservedAfter": "0.000000",
      "description": "Settled execution via cache:provider_alpha"
    }
  ]
}
```

---

### Step 10: Trigger Lease Reconciliation
Trigger background reconciliation for expired processing leases:
```bash
curl -s -X POST http://localhost:3000/v1/billing/reconcile \
  -H "x-api-key: ak_live_acme_super_secret_key_456"
```
```json
{
  "success": true,
  "data": {
    "reconciledCount": 0,
    "records": []
  }
}
```

---

## Testing & Verification Summary

| Suite | Focus | Status |
| :--- | :--- | :--- |
| `tests/unit/auth.service.test.ts` | SHA-256 key hashing & credential generation | Passed |
| `tests/unit/billing.test.ts` | Fixed-precision math, reservations, double-entry ledger | Passed |
| `tests/unit/circuit-breaker.test.ts` | Closed/Open/Half-Open state machine & probe transitions | Passed |
| `tests/unit/router.test.ts` | Cost-aware routing, capacity limits, deterministic ties | Passed |
| `tests/unit/provider-metrics.test.ts` | Concurrency tracking, rolling error rate, EWMA latency | Passed |
| `tests/unit/cache.service.test.ts` | Canonical hashing, tenant keys, TTLs, bypass directives | Passed |
| `tests/unit/coalescing.test.ts` | Single-flight leader election, waiter recovery, Pub/Sub | Passed |
| `tests/unit/rate-limiter.test.ts` | Sliding-window limits, tenant isolation, local fallback | Passed |
| `tests/integration/auth.test.ts` | Fastify authentication hook & header parsing | Passed |
| `tests/integration/gateway.test.ts` | End-to-end failover, latency metrics, provider health | Passed |
| `tests/integration/billing-gateway.test.ts` | Financial concurrency, ambiguous timeouts, idempotent replays | Passed |
| `tests/integration/caching-gateway.test.ts` | Cache hits/misses/bypass, concurrent coalescing, 429 limiter | Passed |
| `tests/integration/redis-live.test.ts` | Live Redis container verification (Lua scripts, Pub/Sub, TTL) | Passed |
