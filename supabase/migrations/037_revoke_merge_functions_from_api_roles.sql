-- ============================================================
-- 037_revoke_merge_functions_from_api_roles
--
-- Close a privilege-escalation hole on the two one-time dedup
-- helpers shipped by migrations 022 and 036.
--
-- Both were written as:
--
--   ALTER FUNCTION public.merge_duplicate_*() OWNER TO postgres;
--   REVOKE ALL ON FUNCTION public.merge_duplicate_*() FROM PUBLIC;
--
-- The intent was "only the migration runner may call this". The
-- REVOKE does not achieve it. Supabase ships default privileges that
-- explicitly GRANT EXECUTE on every new function in `public` to the
-- `anon`, `authenticated` and `service_role` roles. `REVOKE ... FROM
-- PUBLIC` drops only the implicit PUBLIC grant; the three explicit
-- role grants survive untouched, and PostgREST happily exposes both
-- functions at POST /rest/v1/rpc/<name>.
--
-- The impact is not theoretical — it was reproduced against a live
-- project with nothing but the anon key, which ships in the browser
-- bundle and is public by design:
--
--   curl -X POST "$SUPABASE_URL/rest/v1/rpc/merge_duplicate_conversations" \
--        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
--        -H 'Content-Type: application/json' -d '{}'
--   → 200 OK
--
-- Both functions are SECURITY DEFINER owned by `postgres`, so they run
-- with RLS bypassed across every tenant. An anonymous caller could
-- therefore collapse conversations and contacts belonging to accounts
-- they cannot even read, and each merge ends in `DELETE FROM
-- conversations` / `DELETE FROM contacts` — the losing rows are gone.
-- No account_id filter can help: the functions take no arguments and
-- deliberately sweep the whole table.
--
-- The fix is to revoke from the roles by name. PUBLIC stays revoked as
-- well — harmless, and it keeps the intent explicit. The migration
-- runner connects as `postgres`, the function owner, which needs no
-- grant at all, so re-running 022 or 036 after this still works.
--
-- Idempotent: REVOKE on a privilege that is already absent is a no-op.
-- Safe on a database where either function does not exist yet — the
-- loop skips whatever is missing, so this can be applied before or
-- after 036 in a fresh bootstrap.
-- ============================================================

DO $$
DECLARE
  v_fn TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.merge_duplicate_contacts()',
    'public.merge_duplicate_conversations()'
  ]
  LOOP
    -- to_regprocedure returns NULL instead of raising when the
    -- function is absent, which is what makes this safe to run on a
    -- database that has not applied 022/036 yet.
    IF to_regprocedure(v_fn) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
        v_fn
      );
    END IF;
  END LOOP;
END $$;

-- Stop the same hole from reopening on the *next* function someone
-- adds. Supabase's default privileges are what re-granted EXECUTE
-- behind the REVOKEs in 022 and 036; this narrows them for functions
-- created by `postgres` in `public` from here on.
--
-- This matches what the repo already does by hand: every RPC that
-- anon or authenticated is meant to reach carries an explicit GRANT
-- (017:167, 018:112/205/283, 019:89/237, 025:75, 030:202/204,
-- 032:84/86). Those grants are untouched — ALTER DEFAULT PRIVILEGES
-- only applies to functions created *after* it runs, so no existing
-- RPC loses access.
--
-- Deliberately scoped to FUNCTIONS, and deliberately NOT applied to
-- service_role: the server-side callers (webhook, flows engine,
-- automations, public-API auth) reach RPCs with the service-role key
-- and must keep working. anon/authenticated reach the database only
-- through PostgREST under RLS, and from here on they get EXECUTE only
-- where a migration says so out loud.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
