import { Database } from './index.js';
import { ApiKeyService } from '../modules/auth/api-key.service.js';
import { rootLogger } from '../common/logger.js';

export async function seedDatabase() {
  const pool = Database.getPool();

  rootLogger.info('Seeding database...');

  // 1. Seed Organization
  const orgId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  await pool.query(
    `INSERT INTO organizations (id, name, billing_mode)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [orgId, 'Acme Corporation', 'PREPAID']
  );

  // 2. Seed API Key
  const rawApiKey = 'ak_live_acme_super_secret_key_456';
  const keyHash = ApiKeyService.hashKey(rawApiKey);
  const keyPrefix = rawApiKey.substring(0, 12);
  const keyId = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';

  await pool.query(
    `INSERT INTO api_keys (id, org_id, name, key_prefix, key_hash, rate_limit_per_sec, rate_limit_window_ms, pricing_multiplier_percent, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET 
       key_hash = EXCLUDED.key_hash, 
       rate_limit_per_sec = EXCLUDED.rate_limit_per_sec,
       rate_limit_window_ms = EXCLUDED.rate_limit_window_ms,
       pricing_multiplier_percent = EXCLUDED.pricing_multiplier_percent,
       is_active = true`,
    [keyId, orgId, 'Acme Standard Key (1.5x Multiplier)', keyPrefix, keyHash, 50, 1000, 150, true]
  );

  // 2b. Seed VIP Enterprise Key (1.1x Multiplier - Volume Tier)
  const vipApiKey = 'ak_live_vip_enterprise_key_888';
  const vipKeyHash = ApiKeyService.hashKey(vipApiKey);
  await pool.query(
    `INSERT INTO api_keys (id, org_id, name, key_prefix, key_hash, rate_limit_per_sec, rate_limit_window_ms, pricing_multiplier_percent, is_active)
     VALUES ('c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', $1, 'VIP Enterprise Key (1.1x Multiplier)', 'ak_live_vip_', $2, 100, 1000, 110, true)
     ON CONFLICT (id) DO UPDATE SET 
       key_hash = EXCLUDED.key_hash, 
       pricing_multiplier_percent = 110,
       is_active = true`,
    [orgId, vipKeyHash]
  );

  // 2c. Seed Premium Retail Key (2.0x Multiplier - Retail Tier)
  const premiumApiKey = 'ak_live_premium_retail_key_777';
  const premiumKeyHash = ApiKeyService.hashKey(premiumApiKey);
  await pool.query(
    `INSERT INTO api_keys (id, org_id, name, key_prefix, key_hash, rate_limit_per_sec, rate_limit_window_ms, pricing_multiplier_percent, is_active)
     VALUES ('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a55', $1, 'Premium Retail Key (2.0x Multiplier)', 'ak_live_prem', $2, 20, 1000, 200, true)
     ON CONFLICT (id) DO UPDATE SET 
       key_hash = EXCLUDED.key_hash, 
       pricing_multiplier_percent = 200,
       is_active = true`,
    [orgId, premiumKeyHash]
  );

  // 3. Seed Account with $25.00 (25,000,000 micros)
  const accountId = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
  const initialBalanceMicros = 25_000_000n;
  await pool.query(
    `INSERT INTO accounts (id, org_id, balance_micros, reserved_micros, currency, version)
     VALUES ($1, $2, $3, 0, 'USD', 1)
     ON CONFLICT (org_id) DO UPDATE SET balance_micros = EXCLUDED.balance_micros, reserved_micros = 0`,
    [accountId, orgId, initialBalanceMicros.toString()]
  );

  // 4. Seed Initial Deposit in Immutable Ledger
  await pool.query(
    `INSERT INTO ledger_entries (account_id, org_id, request_id, type, amount_micros, balance_after_micros, reserved_after_micros, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [
      accountId,
      orgId,
      'req_seed_initial_deposit',
      'DEPOSIT',
      initialBalanceMicros.toString(),
      initialBalanceMicros.toString(),
      '0',
      'Initial Account Funding ($25.00)',
    ]
  );

  // 5. Seed Zero-Balance Customer for Insufficient Funds Demo
  const brokeOrgId = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
  const brokeKey = 'ak_live_broke_customer_no_funds_999';
  const brokeKeyHash = ApiKeyService.hashKey(brokeKey);
  await pool.query(
    `INSERT INTO organizations (id, name, billing_mode)
     VALUES ($1, $2, 'PREPAID')
     ON CONFLICT (id) DO NOTHING`,
    [brokeOrgId, 'Broke Corp']
  );
  await pool.query(
    `INSERT INTO accounts (id, org_id, balance_micros, reserved_micros, currency, version)
     VALUES ('e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55', $1, 0, 0, 'USD', 1)
     ON CONFLICT (org_id) DO NOTHING`,
    [brokeOrgId]
  );
  await pool.query(
    `INSERT INTO api_keys (id, org_id, name, key_prefix, key_hash, rate_limit_per_sec, rate_limit_window_ms, pricing_multiplier_percent, is_active)
     VALUES ('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66', $1, 'Broke Key (Zero Funds)', 'ak_live_brok', $2, 50, 1000, 150, true)
     ON CONFLICT (id) DO NOTHING`,
    [brokeOrgId, brokeKeyHash]
  );

  // 6. Seed Rate-Limited Key for 429 Demo (limit: 2 req per 4 seconds)
  const rateLimitedKey = 'ak_live_rate_limited_key_123';
  const rateLimitedHash = ApiKeyService.hashKey(rateLimitedKey);
  await pool.query(
    `INSERT INTO api_keys (id, org_id, name, key_prefix, key_hash, rate_limit_per_sec, rate_limit_window_ms, pricing_multiplier_percent, is_active)
     VALUES ('d1eebc99-9c0b-4ef8-bb6d-6bb9bd380a77', $1, 'Rate-Limited Key (2 req per 4s)', 'ak_live_rate', $2, 2, 4000, 150, true)
     ON CONFLICT (id) DO UPDATE SET 
       key_hash = EXCLUDED.key_hash, 
       rate_limit_per_sec = 2, 
       rate_limit_window_ms = 4000, 
       is_active = true`,
    [orgId, rateLimitedHash]
  );

  rootLogger.info('Database seeded successfully!');
  rootLogger.info(`Standard Key (1.5x Multiplier): ${rawApiKey}`);
  rootLogger.info(`VIP Enterprise Key (1.1x Multiplier): ${vipApiKey}`);
  rootLogger.info(`Premium Retail Key (2.0x Multiplier): ${premiumApiKey}`);
  rootLogger.info(`Rate-Limited Key (2 req per 4s): ${rateLimitedKey}`);
  rootLogger.info(`Unfunded Key ($0.00): ${brokeKey}`);
  rootLogger.info(`Organization ID: ${orgId}`);
}

// Execute directly if run via CLI
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seedDatabase()
    .then(async () => {
      await Database.close();
      process.exit(0);
    })
    .catch(async (err) => {
      rootLogger.fatal({ err }, 'Failed to seed database');
      await Database.close();
      process.exit(1);
    });
}
