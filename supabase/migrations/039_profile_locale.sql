-- ============================================================
-- 039_profile_locale.sql — per-user language preference
--
-- Lets each user pick English or Portuguese (Brazil) in Settings →
-- Appearance, persisted here so the choice follows them across
-- devices/browsers rather than living only in a cookie. `pt-BR` is
-- the default since the product targets the Brazilian market first
-- (see src/i18n/request.ts's fallback locale).
--
-- No RLS/trigger changes needed: the existing "Users can update own
-- profile" policy (migration 001/017) already lets a user update any
-- column on their own row, and migration 034's privilege trigger only
-- guards `account_role`/`account_id` — `locale` passes through both
-- untouched, same as `full_name`.
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'pt-BR'
  CHECK (locale IN ('en', 'pt-BR'));
