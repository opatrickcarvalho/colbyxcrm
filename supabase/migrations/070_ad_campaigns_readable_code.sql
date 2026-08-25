-- ============================================================
-- 070_ad_campaigns_readable_code
--
-- ad_campaigns.code was auto-generated random alphanumeric (e.g.
-- "RGQ8X6"), which reads as spam in a prefilled WhatsApp message.
-- Operators want a human-chosen code that reads naturally — the
-- business's own Instagram handle or name (e.g. "SalvadosCardoso"),
-- rendered as "@SalvadosCardoso" in the message.
--
-- `code` keeps its original casing for display (the operator typed
-- "SalvadosCardoso", not "SALVADOSCARDOSO"). Matching — the /l/{code}
-- redirect, and the webhook's first-touch matcher — must still be
-- case-insensitive (a lead's phone keyboard may autocap the message),
-- so `code_key` is a generated, always-lowercase column that owns the
-- uniqueness constraint and every equality lookup. This is preferred
-- over ILIKE at the call sites: ILIKE's wildcard characters (%, _)
-- would need escaping wherever a caller-supplied string reaches it,
-- and an equality filter on a normalised column sidesteps that
-- entirely.
--
-- Idempotent — safe to run multiple times.
--
-- NOTE: this file was reconstructed from the applied remote migration
-- (supabase_migrations.schema_migrations, version 20260824232957) —
-- it existed in the connected Supabase project but was missing from
-- this repo. Restored verbatim so migrations/ matches the DB.
-- ============================================================

ALTER TABLE ad_campaigns
  ADD COLUMN IF NOT EXISTS code_key TEXT GENERATED ALWAYS AS (lower(code)) STORED;

DROP INDEX IF EXISTS idx_ad_campaigns_code;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_campaigns_code_key ON ad_campaigns(code_key);

ALTER TABLE ad_campaigns
  ALTER COLUMN message_template SET DEFAULT 'Olá! Vim pelo anúncio @{code}';

COMMENT ON COLUMN ad_campaigns.code IS
  'Human-chosen tracking code as typed by the operator (e.g. "SalvadosCardoso") — original casing kept for display in the rendered message.';
COMMENT ON COLUMN ad_campaigns.code_key IS
  'lower(code), generated. The actual uniqueness constraint and every lookup (redirect, webhook match) filter on this, not on code.';
