-- ============================================================
-- 043_whatsapp_group_messages.sql — Group activity feed
--
-- Deliberately its own table, not a repurposing of `messages`.
-- `conversations`/`messages` are built around "one agent, one
-- customer" (assignment, unread counts, automations/flows/AI
-- auto-reply all keyed off a single contact) — a group has many
-- senders and the goal here is visibility + light moderation, not an
-- attendance queue. Keeping this fully decoupled avoids retrofitting
-- that whole pipeline for group semantics it was never designed for.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_group_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  -- Null on outbound (we are the sender).
  sender_jid TEXT,
  sender_phone TEXT,
  sender_name TEXT,
  content_type TEXT NOT NULL
    CHECK (content_type IN ('text', 'image', 'document', 'audio', 'video')),
  content_text TEXT,
  media_url TEXT,
  filename TEXT,
  -- uazapi's wamid, kept for potential future dedup/status tracking.
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_group_messages_group
  ON whatsapp_group_messages(group_id, created_at DESC);

ALTER TABLE whatsapp_group_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_group_messages_select ON whatsapp_group_messages;
DROP POLICY IF EXISTS whatsapp_group_messages_insert ON whatsapp_group_messages;

-- Same tier as the groups table itself: viewer reads, agent+ writes.
-- Inbound rows are written by the webhook via the service-role client
-- (bypasses RLS); this policy only gates the outbound compose path.
CREATE POLICY whatsapp_group_messages_select ON whatsapp_group_messages FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY whatsapp_group_messages_insert ON whatsapp_group_messages FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
