-- Drain the four work queues from inside Postgres.
--
-- The app schedules nothing on its own: scheduled messages, group
-- broadcast targets, automation waits and flow steps all sit in their
-- tables until something calls the matching /cron endpoint. The repo
-- ships a `cron` sidecar in docker-compose.yml for that, but it only
-- exists when you deploy with Compose. On managed Node hosting nothing
-- polls those routes, so rows never leave `pending`.
--
-- pg_cron closes that gap without an extra machine: Postgres is always
-- up, so it pings the app once a minute and the app does all the work.
-- Nothing is sent from here — this only knocks on the door.
--
-- Migrating to a VPS later? Drop the schedule with
--   select cron.unschedule('wacrm-drain-queues');
-- and let the Compose sidecar take over. Both running at once is
-- harmless anyway: every endpoint claims rows with a `pending` ->
-- `processing` update, so the loser of a race finds nothing to do.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Base URL and shared secret come from Vault rather than being baked in
-- here: this file is committed, and `cron.job.command` is readable by
-- anyone who can read the catalog.
--
-- Set them once (values never enter the migration):
--   select vault.create_secret('https://your-crm.example.com', 'wacrm_base_url');
--   select vault.create_secret('<AUTOMATION_CRON_SECRET>', 'wacrm_cron_secret');
create or replace function public.drain_wacrm_queues()
returns void
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $fn$
declare
  v_base text;
  v_secret text;
  v_path text;
begin
  select decrypted_secret into v_base
    from vault.decrypted_secrets where name = 'wacrm_base_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'wacrm_cron_secret';

  -- No-op until both secrets exist, so scheduling this before they're
  -- set doesn't spew a failed request every minute.
  if v_base is null or v_secret is null then
    return;
  end if;

  -- pg_net queues each request and returns immediately, so a slow or
  -- unreachable app can't hold the cron worker: the four calls go out
  -- together and their responses are collected asynchronously.
  foreach v_path in array array[
    '/api/whatsapp/scheduled-messages/cron',
    '/api/whatsapp/group-broadcasts/cron',
    '/api/automations/cron',
    '/api/flows/cron'
  ]
  loop
    perform net.http_get(
      url := rtrim(v_base, '/') || v_path,
      headers := jsonb_build_object('x-cron-secret', v_secret),
      timeout_milliseconds := 50000
    );
  end loop;
end;
$fn$;

comment on function public.drain_wacrm_queues() is
  'Pings the app''s four /cron drain endpoints. Called by the pg_cron job "wacrm-drain-queues"; not meant to be called by clients.';

-- SECURITY DEFINER + Vault access means this must not be reachable from
-- PostgREST. pg_cron runs it as the job owner, which is unaffected.
revoke all on function public.drain_wacrm_queues() from public;
revoke all on function public.drain_wacrm_queues() from anon;
revoke all on function public.drain_wacrm_queues() from authenticated;

-- Once a minute — matches the sidecar's `sleep 60`. Re-running this
-- migration reschedules the existing job rather than duplicating it
-- (cron.schedule upserts on job name).
select cron.schedule(
  'wacrm-drain-queues',
  '* * * * *',
  $job$select public.drain_wacrm_queues();$job$
);
