-- ============================================================
-- 053_billing_plans
--
-- Turns the product into a *paid* micro-SaaS: a plan catalogue the
-- operator manages from /admin, a per-account entitlement horizon, and
-- the bookkeeping (subscriptions, payments, raw webhook events) behind
-- an Asaas recurring subscription.
--
-- What's new here
--   1. `platform_settings` — global key/value config, including the
--      billing KILL SWITCH. Service-role only.
--   2. `plans` — the global catalogue. Readable by any authenticated
--      user (a locked-out tenant must still render the pricing grid);
--      writable only through /api/admin/plans (service role).
--   3. Entitlement columns on `accounts` — `plan_expires_at` is THE
--      horizon; everything else is a label or a convenience.
--   4. `account_subscriptions` — one row per subscription ever created
--      (Asaas-backed or a manual admin grant).
--   5. `subscription_payments` — invoice history, and the row-level
--      guard that makes PAYMENT_CONFIRMED-then-PAYMENT_RECEIVED extend
--      the horizon exactly once.
--   6. `asaas_events` — webhook idempotency key + replayable
--      dead-letter queue.
--   7. `account_is_entitled(uuid)` — the predicate. A FUNCTION, not a
--      generated column: it depends on now(), which is not IMMUTABLE.
--   8. A grandfathering backfill: every account that exists the moment
--      this runs becomes permanently `billing_exempt`.
--
-- What this does NOT touch
--   * `is_account_member()` — the actual RLS gate lands in 054, on
--     purpose. This migration is 100% additive and behaviourally
--     inert: you can apply it in production today and nothing changes.
--   * `handle_new_user()` (017) or `remove_account_member()` (018).
--     There are THREE places that INSERT INTO accounts; rather than
--     edit each one (and forget the fourth someone adds later), the
--     trial is seeded by a column DEFAULT, which every insert path
--     picks up for free.
--   * Any existing policy. The three new customer-readable tables use
--     `is_account_member_unrestricted()` from 040 — the status-blind
--     twin — because a locked-out tenant must be able to read what
--     they owe.
--
-- Fail-open by design
--   `account_is_entitled()` returns TRUE when the kill switch is off,
--   when the account is exempt, AND when `plan_expires_at IS NULL`.
--   That last one is deliberate. A bug that nulls the column costs a
--   few days of revenue; a fail-closed version costs every customer's
--   trust in one afternoon, silently, because RLS denials surface as
--   EMPTY RESULTS rather than errors.
--
-- Idempotent — safe to run multiple times. Note in particular that the
-- settings seed uses ON CONFLICT DO NOTHING, so re-running this file
-- can never silently re-arm the kill switch after you've turned it on.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Platform settings + the kill switch
--
-- Service-role only, same lockdown posture as admin_audit_log (040):
-- RLS enabled with zero policies. The SECURITY DEFINER readers below
-- are the only way `authenticated` sees any of it, and they expose one
-- scalar at a time rather than the whole table.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON platform_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO platform_settings (key, value) VALUES
  -- OFF on install. While false, account_is_entitled() short-circuits
  -- to true for everyone and this whole feature is inert. Flipping it
  -- locks or unlocks every tenant at once — treat it as the rollback.
  ('billing_enforcement_enabled', 'false'::jsonb),
  -- Days of free trial seeded onto a brand-new account.
  ('trial_days',                  '7'::jsonb),
  -- Days past plan_expires_at that still count as entitled. Applied
  -- ONLY in the predicate, never written into plan_expires_at itself —
  -- otherwise grace compounds and every renewal gifts extra days.
  ('grace_days',                  '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Scalar readers. STABLE + SECURITY DEFINER so they can be used inside
-- RLS predicates AND inside a column DEFAULT (defaults execute with the
-- inserting role's privileges, which is why the GRANT matters).

CREATE OR REPLACE FUNCTION public.billing_setting_int(p_key TEXT, p_fallback INT)
RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT (value #>> '{}')::int FROM platform_settings WHERE key = p_key),
    p_fallback
  );
$$;

CREATE OR REPLACE FUNCTION public.billing_enforcement_enabled()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT (value #>> '{}')::boolean FROM platform_settings
      WHERE key = 'billing_enforcement_enabled'),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.billing_trial_days()
RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.billing_setting_int('trial_days', 7);
$$;

ALTER FUNCTION public.billing_setting_int(TEXT, INT) OWNER TO postgres;
ALTER FUNCTION public.billing_enforcement_enabled() OWNER TO postgres;
ALTER FUNCTION public.billing_trial_days() OWNER TO postgres;

GRANT EXECUTE ON FUNCTION public.billing_setting_int(TEXT, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.billing_enforcement_enabled() TO authenticated, service_role;
-- authenticated NEEDS this one: it backs the accounts column DEFAULT,
-- and signup inserts run as the authenticated role. Revoke it and every
-- new signup fails at INSERT.
GRANT EXECUTE ON FUNCTION public.billing_trial_days() TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. `plans` — the global catalogue
--
-- Global, not per-account: this is the operator's price list, the same
-- rows every tenant sees. That's why there is no account_id here and
-- no idx_plans_account.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plans (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Stable handle used by the API and the pricing page. Renaming a
  -- plan must not break a link, so the slug is the identity.
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency    TEXT NOT NULL DEFAULT 'BRL',
  -- Asaas's own vocabulary, verbatim, so there is no mapping table to
  -- drift out of sync with their API.
  cycle       TEXT NOT NULL DEFAULT 'MONTHLY',
  trial_days  INTEGER NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  -- false = admin-assign only (e.g. "Enterprise", "Cortesia"). Hidden
  -- from the customer's pricing grid and rejected by /api/billing/subscribe.
  is_public   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  -- Forward-compat only. NOTHING reads this today and no quota is
  -- wired to it — shipping the column costs nothing and saves a
  -- migration when per-plan limits arrive.
  limits      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_cycle_check') THEN
    ALTER TABLE plans ADD CONSTRAINT plans_cycle_check CHECK (cycle IN (
      'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'BIMONTHLY',
      'QUARTERLY', 'SEMIANNUALLY', 'YEARLY'
    ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_plans_active_sort ON plans(is_active, sort_order);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plans_select ON plans;
-- Deliberately blind to BOTH membership and entitlement: a tenant who
-- is locked out has to see the pricing grid to get themselves out, and
-- a plan's price is not a secret. Archived plans stay readable so a
-- customer sitting on a retired plan still sees its name; the UI is
-- what filters on is_active / is_public.
CREATE POLICY plans_select ON plans
  FOR SELECT
  TO authenticated
  USING (true);
-- No INSERT/UPDATE/DELETE policies on purpose. Platform admins have no
-- RLS predicate anywhere in this codebase (see 040) — writes go through
-- /api/admin/plans/* on the service-role client.

DROP TRIGGER IF EXISTS set_updated_at ON plans;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 3. Entitlement snapshot on `accounts`
--
-- Why columns here rather than a join to account_subscriptions:
-- is_account_member() already does
--   EXISTS (SELECT 1 FROM accounts a WHERE a.id = target AND a.status='active')
-- so adding predicates to that SAME already-fetched row is free. Moving
-- entitlement into a child table would add a second correlated
-- subquery to every row-level check on ~30 tables — that's the inbox
-- pagination and message-history hot path, not a theoretical cost.
-- The 1:N history still exists (§4), it just isn't what RLS reads.
-- ------------------------------------------------------------

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
  -- THE entitlement horizon — "paid through". The one column that
  -- decides access. NULL means "never billed" and reads as entitled.
  --
  -- The DEFAULT is what seeds the free trial, and it is why this
  -- migration touches neither handle_new_user() (017:671) nor
  -- remove_account_member() (018:187) nor the 017:240 backfill: a
  -- column default applies to all three insert paths, and to whatever
  -- fourth path someone adds next year.
  ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ
    DEFAULT (NOW() + (public.billing_trial_days() || ' days')::interval),
  -- Kept SEPARATE from plan_expires_at even though they start equal.
  -- plan_expires_at moves forward on every payment; trial_ends_at
  -- never does, so the UI can say "trial" vs "paid" and the sweep can
  -- label correctly. It is NOT part of the entitlement predicate —
  -- one horizon, one gate.
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ
    DEFAULT (NOW() + (public.billing_trial_days() || ' days')::interval),
  -- Denormalised LABEL for the UI, admin list and reporting. NEVER
  -- consulted by account_is_entitled(). That separation is what makes
  -- a stalled sweep cron harmless: labels go stale, access does not.
  ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'trialing',
  -- Permanent bypass: self-hosters, grandfathered tenants, comped
  -- accounts, and the operator's own account.
  ADD COLUMN IF NOT EXISTS billing_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS asaas_customer_id TEXT,
  -- LGPD: CPF/CNPJ is sensitive PII and Asaas requires it. Encrypted
  -- with the same AES-256-GCM helper as WhatsApp tokens and BYO AI keys
  -- (src/lib/whatsapp/encryption.ts). last4 is kept in the clear purely
  -- so the UI can render "•••.•••.123-45" without a decrypt round trip.
  ADD COLUMN IF NOT EXISTS billing_cpf_cnpj_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS billing_cpf_cnpj_last4 TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_billing_status_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_billing_status_check
      CHECK (billing_status IN (
        'trialing', 'active', 'past_due', 'expired', 'cancelled', 'exempt'
      ));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_asaas_customer
  ON accounts(asaas_customer_id) WHERE asaas_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_plan_expires
  ON accounts(plan_expires_at) WHERE plan_expires_at IS NOT NULL;

-- ------------------------------------------------------------
-- 4. `account_subscriptions` — history
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account_subscriptions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id               UUID REFERENCES plans(id) ON DELETE SET NULL,
  -- NULL for a manual admin grant — no Asaas object exists for those.
  asaas_subscription_id TEXT,
  -- 'pending' until the first payment confirms; then mirrors Asaas
  -- plus our own 'cancelled'.
  status                TEXT NOT NULL DEFAULT 'pending',
  -- Snapshot of the plan AT PURCHASE TIME. Changing a plan's price
  -- must never rewrite what someone already agreed to pay, so these
  -- are copies, not a join.
  cycle                 TEXT NOT NULL,
  value_cents           INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'BRL',
  next_due_date         DATE,
  latest_invoice_url    TEXT,
  -- 'self_serve' | 'admin_grant'
  source                TEXT NOT NULL DEFAULT 'self_serve',
  -- Author / audit only — never used for tenancy isolation.
  created_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at          TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_subscriptions_status_check') THEN
    ALTER TABLE account_subscriptions ADD CONSTRAINT account_subscriptions_status_check
      CHECK (status IN ('pending', 'active', 'past_due', 'cancelled', 'expired'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_subscriptions_source_check') THEN
    ALTER TABLE account_subscriptions ADD CONSTRAINT account_subscriptions_source_check
      CHECK (source IN ('self_serve', 'admin_grant'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_account_subscriptions_account
  ON account_subscriptions(account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_subscriptions_asaas
  ON account_subscriptions(asaas_subscription_id) WHERE asaas_subscription_id IS NOT NULL;
-- At most one live subscription per account. Matches the
-- one-account-per-user design (idx_accounts_one_per_owner, 017) and
-- stops a double-click on "Assinar" from creating two Asaas charges.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_subscriptions_one_live
  ON account_subscriptions(account_id) WHERE status IN ('pending', 'active', 'past_due');

ALTER TABLE account_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_subscriptions_select ON account_subscriptions;
-- The UNRESTRICTED twin from 040, on purpose: a tenant who is locked
-- out (suspended OR unpaid) still has to read their own subscription to
-- find out what they owe and where to pay it.
CREATE POLICY account_subscriptions_select ON account_subscriptions
  FOR SELECT
  USING (is_account_member_unrestricted(account_id));
-- No write policies: every mutation runs through /api/billing/* or
-- /api/admin/* on the service-role client, because the authoritative
-- writer is the Asaas webhook, which has no session at all.

DROP TRIGGER IF EXISTS set_updated_at ON account_subscriptions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON account_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 5. `subscription_payments` — invoices, and the double-extension guard
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscription_payments (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subscription_id       UUID REFERENCES account_subscriptions(id) ON DELETE SET NULL,
  asaas_payment_id      TEXT NOT NULL,
  asaas_subscription_id TEXT,
  -- Asaas payment.status verbatim (PENDING, CONFIRMED, RECEIVED, ...).
  status                TEXT NOT NULL,
  -- PIX | BOLETO | CREDIT_CARD | UNDEFINED
  billing_type          TEXT,
  value_cents           INTEGER NOT NULL,
  due_date              DATE,
  paid_at               TIMESTAMPTZ,
  invoice_url           TEXT,
  -- The window THIS payment bought. Written EXACTLY ONCE, on the first
  -- transition into a paid state.
  --
  -- This is the inner idempotency key. Asaas fires PAYMENT_CONFIRMED
  -- (provider confirmed) and then PAYMENT_RECEIVED (funds landed) for
  -- the SAME payment.id, and delivery is at-least-once on top of that.
  -- `WHERE asaas_payment_id = $1 AND period_end IS NULL` is what makes
  -- the horizon move once and only once per payment.
  period_start          TIMESTAMPTZ,
  period_end            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_asaas
  ON subscription_payments(asaas_payment_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_account
  ON subscription_payments(account_id, created_at DESC);

ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscription_payments_select ON subscription_payments;
-- Unrestricted twin again: the payment history is exactly what a
-- locked-out customer needs to see.
CREATE POLICY subscription_payments_select ON subscription_payments
  FOR SELECT
  USING (is_account_member_unrestricted(account_id));

DROP TRIGGER IF EXISTS set_updated_at ON subscription_payments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON subscription_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 6. `asaas_events` — idempotency key + replayable dead-letter
--
-- Asaas guarantees AT LEAST ONCE delivery, so duplicates WILL arrive.
-- Worse: 15 consecutive non-2xx responses INTERRUPT the whole webhook
-- queue until it is manually reactivated, and undelivered events are
-- deleted after 14 days. So the route stores the raw payload here
-- FIRST, then processes, then always answers 2xx — a processing bug
-- becomes a 'failed' row the hourly sweep re-drives, never lost money.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS asaas_events (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Asaas's evt_… id. UNIQUE — this is the outer idempotency key.
  event_id              TEXT NOT NULL,
  event_type            TEXT NOT NULL,
  asaas_payment_id      TEXT,
  asaas_subscription_id TEXT,
  -- Nullable: an event we cannot map to a tenant is recorded as
  -- 'ignored' rather than dropped, so it can be investigated.
  account_id            UUID REFERENCES accounts(id) ON DELETE SET NULL,
  payload               JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'received',
  attempts              INTEGER NOT NULL DEFAULT 0,
  error                 TEXT,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at          TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asaas_events_status_check') THEN
    ALTER TABLE asaas_events ADD CONSTRAINT asaas_events_status_check
      CHECK (status IN ('received', 'processed', 'ignored', 'failed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_asaas_events_event_id ON asaas_events(event_id);
CREATE INDEX IF NOT EXISTS idx_asaas_events_failed
  ON asaas_events(received_at) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_asaas_events_account ON asaas_events(account_id);

ALTER TABLE asaas_events ENABLE ROW LEVEL SECURITY;
-- Zero policies, like admin_audit_log (040): the raw payload carries
-- the payer's document and Asaas account metadata. Service role only.

-- ------------------------------------------------------------
-- 7. The entitlement predicate
--
-- A FUNCTION, not a column and not a GENERATED column — generated
-- columns must be IMMUTABLE and this depends on now().
--
-- Read order matters: the kill switch short-circuits before any table
-- access, so while billing is disabled this costs one cheap settings
-- lookup and nothing else.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.account_is_entitled(target_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    NOT public.billing_enforcement_enabled()
    OR EXISTS (
      SELECT 1
      FROM accounts a
      WHERE a.id = target_account_id
        AND (
          a.billing_exempt
          -- Fail-open: an unset horizon means "never billed".
          OR a.plan_expires_at IS NULL
          -- Grace lives HERE and only here. Baking it into
          -- plan_expires_at would compound it on every renewal.
          OR a.plan_expires_at
             + (public.billing_setting_int('grace_days', 3) || ' days')::interval
             > NOW()
        )
    );
$$;

ALTER FUNCTION public.account_is_entitled(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.account_is_entitled(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.account_is_entitled(UUID) IS
  'Billing gate predicate. Reads accounts.plan_expires_at (the horizon), '
  'never accounts.billing_status (a label). Wired into is_account_member() '
  'by migration 054. Mirrored in TypeScript by src/lib/billing/entitlement.ts '
  '- keep the two in lockstep.';

-- ------------------------------------------------------------
-- 8. Grandfathering
--
-- Everyone who exists the moment this runs becomes permanently exempt.
-- Deliberately blunt: no pre-existing tenant can EVER be locked out by
-- a bug in this feature, regardless of what the kill switch or the
-- sweep cron do later.
--
-- The operator converts them individually from /admin/accounts/<id>,
-- or all at once with the snippet below when they're ready to charge.
-- Run that BY HAND — never from a migration, because a migration is
-- re-runnable and this decision is not.
--
--   UPDATE accounts
--      SET billing_exempt  = false,
--          billing_status  = 'trialing',
--          trial_ends_at   = now() + interval '30 days',
--          plan_expires_at = now() + interval '30 days'
--    WHERE billing_exempt
--      AND asaas_customer_id IS NULL;
-- ------------------------------------------------------------

UPDATE accounts
   SET billing_exempt = TRUE,
       billing_status = 'exempt'
 WHERE billing_exempt IS NOT TRUE
   AND created_at < NOW();
