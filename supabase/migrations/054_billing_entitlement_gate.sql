-- ============================================================
-- 054_billing_entitlement_gate
--
-- Wires public.account_is_entitled() (053) into is_account_member()
-- (017, suspension-gated since 040). That single function backs ~30
-- RLS policies (contacts, tags, custom_fields, contact_notes,
-- conversations, whatsapp_config, message_templates, pipelines, deals,
-- broadcasts, broadcast_recipients, automations, automation_logs,
-- automation_steps, automation_pending_executions, flows, flow_nodes,
-- flow_runs, flow_run_events, message_reactions, messages,
-- pipeline_stages, contact_tags, contact_custom_values, quick_replies,
-- webhook_endpoints, api_keys, ai_configs, ai_knowledge_chunks,
-- ai_knowledge_documents, ai_usage_log, member_presence,
-- account_invitations, and accounts_update) — same trick 040 used for
-- suspension, so this migration touches no per-table policy.
--
-- What this does NOT touch
--   * is_account_member_unrestricted() — stays blind to both status
--     AND entitlement. It backs accounts_select (040) and the three
--     billing-history tables added in 053 (account_subscriptions,
--     subscription_payments). A locked-out tenant must still be able
--     to read their own account row, plan and invoices to pay their
--     way out — that is the entire point of the "unrestricted" twin.
--   * Anything running on the service-role client. Inbound WhatsApp
--     persistence (contact/conversation/message upsert) and the four
--     queue-drain crons use supabaseAdmin(), which bypasses RLS
--     entirely, so this gate never touches message history. The
--     app-level gate for those paths is
--     src/lib/whatsapp/inbound/side-effects.ts and
--     src/lib/whatsapp/send-message.ts — see the comments there for
--     why persistence and spend are gated differently.
--
-- Net effect once billing_enforcement_enabled is flipped true: an
-- unentitled account's own dashboard session (cookie auth, i.e. every
-- direct-from-browser supabase-js read) starts seeing EMPTY RESULT
-- SETS on the ~30 tables above — not errors, per the fail-open note
-- in 053. Server routes built on getCurrentAccount()/requireApiKey()
-- already throw a typed 402 before ever reaching Postgres (see
-- src/lib/auth/account.ts, src/lib/auth/api-context.ts); this
-- migration is the backstop for whatever reads directly.
--
-- Safe to apply together with 053, or any time after it — before
-- billing_enforcement_enabled is flipped to true this is as inert as
-- 053 itself, since account_is_entitled() short-circuits to TRUE.
-- ============================================================

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
  )
  -- The only line this migration adds. Kill-switched and exempt
  -- accounts pass through account_is_entitled() unchanged, so this is
  -- additive risk only: a bug here can lock tenants out, never let a
  -- suspended one back in (the status EXISTS above still applies).
  AND public.account_is_entitled(target_account_id);
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;

COMMENT ON FUNCTION is_account_member(UUID, account_role_enum) IS
  'Membership + status + entitlement gate for ~30 tenant tables. '
  'Entitlement check added by migration 054 — see public.account_is_entitled() '
  'in 053 for the predicate and its fail-open reasoning.';
