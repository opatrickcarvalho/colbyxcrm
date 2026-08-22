-- ============================================================
-- 067_gif_sticker_content_types.sql
--
-- Adds 'gif' and 'sticker' as first-class `content_type` values on
-- `messages` and `whatsapp_group_messages`.
--
-- Both used to be folded into 'image' by the uazapi webhook's
-- `toContentType` (a sticker is a webp image on the wire; WhatsApp's
-- "GIF" is really a silent looping mp4 — uazapi's own `videoplay` type
-- — not an actual .gif file). That made every sticker and GIF render
-- and get captioned exactly like an ordinary photo in the inbox.
-- Reported directly: "os GIFs devem ser como GIF, e figurinhas como
-- figurinhas, tudo está como imagem."
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_content_type_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN (
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive', 'gif', 'sticker'
  ));

ALTER TABLE whatsapp_group_messages
  DROP CONSTRAINT IF EXISTS whatsapp_group_messages_content_type_check;

ALTER TABLE whatsapp_group_messages
  ADD CONSTRAINT whatsapp_group_messages_content_type_check
  CHECK (content_type IN (
    'text', 'image', 'document', 'audio', 'video', 'gif', 'sticker'
  ));
