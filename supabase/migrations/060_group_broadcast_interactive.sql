-- ============================================================
-- 060_group_broadcast_interactive.sql
--
-- Adds an 'interactive' (button-message) content type to
-- whatsapp_group_broadcasts, so a campaign can send a WhatsApp
-- reply-buttons message (e.g. "Já segue a gente?" / "Ainda não")
-- instead of only text/media.
--
-- Deliberately reuses the existing InteractiveMessagePayload shape
-- (src/lib/whatsapp/interactive.ts) already sent/validated/persisted
-- end to end by sendMessageToConversation() for 1:1 conversations —
-- this migration only needs to give whatsapp_group_broadcasts
-- somewhere to store that payload and let the content_type CHECK
-- accept it. A tap on a button already lands back in the contact's
-- own conversation with `interactive_reply_id` set (existing UAZAPI
-- webhook parsing), and automations already trigger on that column
-- (src/lib/automations/engine.ts) — no other schema change needed.
--
-- 'interactive' is intentionally NOT supported for group-JID targets
-- (WhatsApp doesn't support buttons in group chats, and the group
-- send path — sendGroupContent() — has no interactive branch), so
-- the media-required constraint only needs to add one more exception,
-- not a new "who can use this type" rule; that's enforced in the API
-- route + cron instead.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_group_broadcasts
  ADD COLUMN IF NOT EXISTS interactive_payload JSONB;

ALTER TABLE whatsapp_group_broadcasts
  DROP CONSTRAINT IF EXISTS whatsapp_group_broadcasts_content_type_check;
ALTER TABLE whatsapp_group_broadcasts
  ADD CONSTRAINT whatsapp_group_broadcasts_content_type_check
  CHECK (content_type IN ('text', 'image', 'document', 'audio', 'video', 'interactive'));

ALTER TABLE whatsapp_group_broadcasts
  DROP CONSTRAINT IF EXISTS whatsapp_group_broadcasts_media_required;
ALTER TABLE whatsapp_group_broadcasts
  ADD CONSTRAINT whatsapp_group_broadcasts_media_required
  CHECK (content_type IN ('text', 'interactive') OR media_url IS NOT NULL);
