-- ============================================================
-- 069_whatsapp_config_connected_number
--
-- The business's own connected WhatsApp number was never persisted for
-- the UAZAPI path — `phone_number_id`/`access_token` (038) are Meta-only.
-- Needed by the /l/{code} ad-attribution redirect (068_ad_campaigns.sql)
-- to build a `wa.me/<number>` link from the database alone: calling
-- UAZAPI live on every ad click would add latency a prospect can
-- abandon during, which defeats the point of that route.
--
-- Backfilled by GET /api/whatsapp/uazapi/status (already polled
-- regularly while an instance is live) mirroring uazapi's own
-- `/instance/status` response, same as it already mirrors `status` and
-- `connected_at`. Meta rows are left NULL here on purpose — that path
-- would need a different source (phone number registration), out of
-- scope for this migration.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connected_number TEXT;

COMMENT ON COLUMN whatsapp_config.connected_number IS
  'The business''s own connected WhatsApp number (digits, no +), used to build wa.me links. '
  'For uazapi, mirrored from /instance/status on every status poll. NULL for Meta rows (not sourced here).';
