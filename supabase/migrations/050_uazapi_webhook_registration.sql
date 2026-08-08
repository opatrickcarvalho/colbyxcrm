-- ============================================================
-- Track which webhook registration uazapi actually holds.
--
-- The registration lives on uazapi's side, not ours, and
-- `registerWebhook()` only ever ran once per instance — inside the
-- pairing flow (POST /api/whatsapp/uazapi/connect). So when the event
-- list in the code grew to include `messages_update`, `presence`,
-- `labels` and `chat_labels`, nothing re-sent it. Every instance paired
-- before that change kept its old subscription, and the handlers written
-- for those events never fired once: 643 outbound messages sat at
-- `sent` with delivered_at/read_at null across the board, and
-- contacts.presence_status was empty on every row.
--
-- This column records a fingerprint of the registration we last
-- successfully pushed (callback URL + event list + message filters).
-- When the fingerprint the code computes differs from the stored one,
-- the status and sync routes re-register and update it. A deploy that
-- changes the event list therefore heals every instance on its next
-- status poll, instead of requiring each customer to re-pair by hand.
--
-- NULL means "never registered by the reconciling code path" — which is
-- true of every row that exists today, so they all reconcile once on
-- their next poll. That is the intended backfill; no data migration is
-- needed.
-- ============================================================

alter table whatsapp_config
  add column if not exists uazapi_webhook_registration text;

comment on column whatsapp_config.uazapi_webhook_registration is
  'Fingerprint (sha256 prefix) of the webhook registration last pushed to uazapi: callback URL + subscribed events + message filters. Computed by webhookRegistrationFingerprint() in src/lib/whatsapp/providers/uazapi.ts. NULL means the reconciling path has never pushed one, so the next status poll will.';
