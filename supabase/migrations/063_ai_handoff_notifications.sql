-- Widen the notifications type check so the AI auto-reply bot can raise
-- a dedicated "needs a human" alert (027_notifications.sql only knew
-- about conversation_assigned). Additive only — existing rows/behaviour
-- untouched.
--
-- This closes a real gap: when the account has no specific handoff
-- agent configured (the "leave in shared queue" default), a handoff
-- today only sets ai_autoreply_disabled=true on the conversation — no
-- assignment happens, so the existing on_conversation_assigned trigger
-- never fires and nobody is told. The application code (see
-- src/lib/ai/handoff.ts) now inserts an 'ai_handoff' notification
-- directly for whoever needs to see it: the configured handoff agent
-- when one is set, otherwise every account member who can pick up a
-- conversation (agent/admin/owner).
alter table notifications
  drop constraint notifications_type_check;

alter table notifications
  add constraint notifications_type_check
  check (type in ('conversation_assigned', 'ai_handoff'));
