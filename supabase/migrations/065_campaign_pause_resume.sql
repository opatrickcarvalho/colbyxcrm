-- Add 'paused' as a campaign status so an in-flight group broadcast can
-- be paused and resumed without losing its still-pending targets
-- (044_whatsapp_group_broadcasts.sql). Targets themselves need no new
-- status: pausing just stops the cron drain from claiming new ones
-- (see the cron route's status gate) — a target already 'processing'
-- when paused finishes normally, and resuming re-plans send_at for
-- whatever is still 'pending' rather than replaying stale timestamps
-- in one burst.
alter table whatsapp_group_broadcasts
  drop constraint whatsapp_group_broadcasts_status_check;

alter table whatsapp_group_broadcasts
  add constraint whatsapp_group_broadcasts_status_check
  check (status = any (array['pending'::text, 'sending'::text, 'paused'::text, 'sent'::text, 'failed'::text, 'cancelled'::text]));
