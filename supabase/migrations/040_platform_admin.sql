-- ============================================================
-- 040_platform_admin
--
-- Turns the product into a real micro-SaaS by giving the operator
-- (not a customer) a control plane over every tenant: a flag that
-- marks a user as a platform admin, a suspend/reactivate switch on
-- `accounts`, and an audit trail for both that and impersonation
-- ("enter as a customer to help them").
--
-- Design: rather than rewriting the ~30 RLS policies that already
-- gate every tenant table through `is_account_member(account_id,
-- min_role)` (migration 017), this modifies that ONE function to also
-- require `accounts.status = 'active'`. Every dependent policy —
-- contacts, conversations, messages, whatsapp_config, flows,
-- automations, broadcasts, and the rest — inherits the suspension
-- lock for free, confirmed live against pg_policies rather than
-- assumed from migration history. The single exception is
-- `accounts_select`: a suspended tenant still needs to read their own
-- `accounts` row (to see *why* they're locked out), so it's repointed
-- at a new `is_account_member_unrestricted()` that keeps the original,
-- status-blind role check. `profiles_select` needs no change — its
-- `auth.uid() = user_id` branch already lets a user read their own
-- row unconditionally, suspended or not.
--
-- `is_platform_admin` is deliberately grantable only by hand
-- (`UPDATE profiles SET is_platform_admin = true WHERE user_id = ...`
-- run once via the SQL editor/MCP) — no route in the app ever sets it,
-- on yourself or anyone else.
--
-- `admin_audit_log` / `admin_impersonation_sessions` are RLS-enabled
-- with zero policies for `authenticated`/`anon`: only the service-role
-- client (which bypasses RLS entirely) can touch them, the same
-- lockdown posture already used for other sensitive rows like
-- `account_invitations.token_hash`.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS
-- throughout; the two functions and the one repointed policy use
-- CREATE OR REPLACE / DROP IF EXISTS + CREATE, safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Platform-admin flag + account suspension fields
-- ------------------------------------------------------------

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_status_check'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_status_check CHECK (status IN ('active', 'suspended'));
  END IF;
END $$;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- ------------------------------------------------------------
-- 2. Audit log + impersonation sessions
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_user_id UUID NOT NULL REFERENCES auth.users(id),
  -- 'account_suspended' | 'account_reactivated' | 'impersonate_start' | 'impersonate_end'
  action TEXT NOT NULL,
  target_account_id UUID REFERENCES accounts(id),
  target_user_id UUID REFERENCES auth.users(id),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target_account ON admin_audit_log(target_account_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_user ON admin_audit_log(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log(created_at);

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
-- No policies for authenticated/anon: only the service-role client
-- (bypasses RLS) reads or writes this table, from src/app/api/admin/*.

CREATE TABLE IF NOT EXISTS admin_impersonation_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_user_id UUID NOT NULL REFERENCES auth.users(id),
  target_user_id UUID NOT NULL REFERENCES auth.users(id),
  target_account_id UUID NOT NULL REFERENCES accounts(id),
  -- SHA-256 hex digest, same convention as account_invitations.token_hash
  -- (migration 017/019) — the raw token is never stored.
  return_token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_impersonation_sessions_status_check'
  ) THEN
    ALTER TABLE admin_impersonation_sessions
      ADD CONSTRAINT admin_impersonation_sessions_status_check
      CHECK (status IN ('active', 'ended', 'expired'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_impersonation_return_token
  ON admin_impersonation_sessions(return_token_hash);
CREATE INDEX IF NOT EXISTS idx_admin_impersonation_status ON admin_impersonation_sessions(status);

ALTER TABLE admin_impersonation_sessions ENABLE ROW LEVEL SECURITY;
-- No policies for authenticated/anon — service-role only, same as above.

-- ------------------------------------------------------------
-- 3. Suspension-aware membership check
--
-- Identical role-hierarchy CASE to migration 017's original
-- `is_account_member`, plus a status gate. Every one of the ~30
-- policies built on this function (confirmed live via pg_policies:
-- contacts, tags, custom_fields, contact_notes, conversations,
-- whatsapp_config, message_templates, pipelines, deals, broadcasts,
-- broadcast_recipients, automations, automation_logs,
-- automation_steps, automation_pending_executions, flows, flow_nodes,
-- flow_runs, flow_run_events, message_reactions, messages,
-- pipeline_stages, contact_tags, contact_custom_values, quick_replies,
-- webhook_endpoints, api_keys, ai_configs, ai_knowledge_chunks,
-- ai_knowledge_documents, ai_usage_log, member_presence,
-- account_invitations, and accounts_update) now also requires the
-- account to be active — no per-policy changes needed.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  )
  AND EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = target_account_id AND a.status = 'active'
  );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;

-- Status-blind twin, for the one policy (accounts_select) that must
-- keep working for a suspended tenant.
CREATE OR REPLACE FUNCTION is_account_member_unrestricted(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER FUNCTION is_account_member_unrestricted(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member_unrestricted(UUID, account_role_enum) TO authenticated, service_role;

DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts
  FOR SELECT
  USING (is_account_member_unrestricted(id));
