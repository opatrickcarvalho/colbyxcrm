-- ============================================================
-- 038_whatsapp_provider_uazapi
--
-- Teach `whatsapp_config` that there is more than one way to reach
-- WhatsApp. Until now the table was Meta-shaped by construction:
-- `phone_number_id` and `access_token` are NOT NULL, which is exactly
-- right for the Cloud API and impossible to satisfy for UAZAPI, an
-- unofficial bridge that authenticates a per-instance token after the
-- operator scans a QR code.
--
-- Design: one row per account with a discriminator, not a second
-- table. `whatsapp_config` is already UNIQUE(account_id) — one
-- connection per account — and that invariant is the product decision
-- ("the user picks which provider to use"). A second table would push
-- every one of the 20+ readers into a two-table lookup and leave the
-- "exactly one active provider" rule with no owner in the database.
--
-- Nothing about the Meta path changes. `provider` defaults to 'meta',
-- so every existing row keeps working with no backfill, and a reader
-- that never heard of this column still sees the same values it always
-- did.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS throughout, and each constraint
-- is dropped before being recreated (Postgres has no ADD CONSTRAINT IF
-- NOT EXISTS).
-- ============================================================

-- 1) The discriminator + the UAZAPI-side columns.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  -- Base URL of the uazapi server this instance lives on. Stored per
  -- row rather than read from UAZAPI_HOST at send time so that moving
  -- the env var later cannot silently repoint existing instances at a
  -- server that has never heard of them.
  ADD COLUMN IF NOT EXISTS uazapi_host TEXT,
  -- uazapi's own instance id. Indexed below: the inbound webhook uses
  -- it to map an event back to an account.
  ADD COLUMN IF NOT EXISTS uazapi_instance_id TEXT,
  -- Per-instance token, AES-256-GCM encrypted with ENCRYPTION_KEY
  -- exactly like access_token. NOT the account-wide admintoken, which
  -- never touches the database.
  ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT,
  -- High-entropy per-account secret embedded in the webhook URL.
  --
  -- This is load-bearing security, not convenience. Meta signs every
  -- webhook POST with HMAC-SHA256 (see lib/whatsapp/webhook-signature);
  -- uazapi signs nothing at all, so the unguessable URL *is* the
  -- authentication. It has to be per-account: a single global secret
  -- would let any customer replay it to inject messages into another
  -- customer's inbox.
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

DROP INDEX IF EXISTS idx_whatsapp_config_uazapi_instance;
CREATE UNIQUE INDEX idx_whatsapp_config_uazapi_instance
  ON whatsapp_config (uazapi_instance_id)
  WHERE uazapi_instance_id IS NOT NULL;

-- Partial unique index, not a plain one: `webhook_secret` is NULL on
-- every Meta row, and a collision between two accounts' secrets would
-- be a cross-tenant hole rather than a cosmetic duplicate.
DROP INDEX IF EXISTS idx_whatsapp_config_webhook_secret;
CREATE UNIQUE INDEX idx_whatsapp_config_webhook_secret
  ON whatsapp_config (webhook_secret)
  WHERE webhook_secret IS NOT NULL;

-- 2) Only the values the application knows how to build a client for.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'uazapi'));

-- 3) `status` gained two states.
--
-- The original CHECK allowed only 'connected' / 'disconnected'. The QR
-- flow *lives* in 'connecting' — the row is written when the instance
-- is created, and the operator then has two minutes to scan before the
-- code expires — so without this the connect handler could not persist
-- its own intermediate state. 'hibernated' is uazapi's paused-session
-- state (credentials preserved, socket dropped).
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN ('connected', 'disconnected', 'connecting', 'hibernated'));

-- 4) Make the Meta credentials conditionally required.
--
-- Dropping NOT NULL alone would weaken the Meta path — a half-written
-- Meta row could then be saved and would only fail later, at send time,
-- with a confusing error. The CHECK below keeps the guarantee exactly
-- as strong as it was for Meta while letting a UAZAPI row satisfy its
-- own, different requirement.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token   DROP NOT NULL;

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_credentials_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_credentials_check
  CHECK (
    (provider = 'meta'
      AND phone_number_id IS NOT NULL
      AND access_token IS NOT NULL)
    OR
    (provider = 'uazapi'
      AND uazapi_instance_token IS NOT NULL
      AND uazapi_host IS NOT NULL
      AND webhook_secret IS NOT NULL)
  );

-- 5) The Meta-only UNIQUE(phone_number_id) from migration 013 has to
--    become partial.
--
-- As a plain UNIQUE it counted NULLs as distinct in Postgres, so it
-- happens to tolerate many UAZAPI rows today — but that is an accident
-- of NULL semantics, not an intent. Spelling it out as a partial index
-- says what we actually mean ("no two accounts may claim the same Meta
-- number") and keeps behaving correctly if the column ever gains a
-- non-NULL placeholder.
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_phone_number_id_key;

DROP INDEX IF EXISTS idx_whatsapp_config_phone_number_id;
CREATE UNIQUE INDEX idx_whatsapp_config_phone_number_id
  ON whatsapp_config (phone_number_id)
  WHERE phone_number_id IS NOT NULL;

COMMENT ON COLUMN whatsapp_config.provider IS
  'Which backend this row talks to: meta (official Cloud API) or uazapi (unofficial, QR-code pairing).';
COMMENT ON COLUMN whatsapp_config.webhook_secret IS
  'Per-account secret in the uazapi webhook URL. uazapi does not sign its callbacks, so this is the only thing authenticating them.';
COMMENT ON COLUMN whatsapp_config.uazapi_instance_token IS
  'Per-instance uazapi token, AES-256-GCM encrypted with ENCRYPTION_KEY. The account-wide admintoken is never stored here.';
