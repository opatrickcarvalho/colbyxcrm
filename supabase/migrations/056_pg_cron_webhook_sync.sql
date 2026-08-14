-- ============================================================
-- 056_pg_cron_webhook_sync.sql
--
-- Adds /api/whatsapp/uazapi/webhook-sync/cron to the same pg_cron
-- ping list migration 051 set up for the four queue-drain endpoints.
--
-- Why: ensureWebhookRegistered() (src/lib/whatsapp/uazapi-webhook-sync.ts)
-- only ran from the QR-pairing status poll, which an operator has no
-- reason to revisit once already connected. An account paired before
-- an event-list change never re-registers, so its webhook subscription
-- silently drifts: inbound messages keep working (that event was in
-- the old list too), but delivery/read ticks stop advancing past
-- 'sent' with no error anywhere to explain why — confirmed against
-- live data (every recent outbound message had delivered_at/read_at
-- still null). Pinging every connected account's reconcile check once
-- a minute, the same way the queue drain already works, closes that
-- gap for every account going forward, not just a one-time fix.
--
-- `create or replace function` + `cron.schedule`'s upsert-by-name
-- means re-running this (or 051) is safe and doesn't duplicate the job.
-- ============================================================

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

  if v_base is null or v_secret is null then
    return;
  end if;

  foreach v_path in array array[
    '/api/whatsapp/scheduled-messages/cron',
    '/api/whatsapp/group-broadcasts/cron',
    '/api/automations/cron',
    '/api/flows/cron',
    '/api/whatsapp/uazapi/webhook-sync/cron'
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
  'Pings the app''s cron drain + health-check endpoints. Called by the pg_cron job "wacrm-drain-queues"; not meant to be called by clients.';

revoke all on function public.drain_wacrm_queues() from public;
revoke all on function public.drain_wacrm_queues() from anon;
revoke all on function public.drain_wacrm_queues() from authenticated;

select cron.schedule(
  'wacrm-drain-queues',
  '* * * * *',
  $job$select public.drain_wacrm_queues();$job$
);
