-- ============================================================
-- 041_whatsapp_scheduled_messages.sql — Scheduled WhatsApp sends
--
-- Lets an agent schedule a text or native-media message (image,
-- document, audio, video) to go out in an existing conversation at
-- an exact future instant. Drained by an external cron hitting
-- GET /api/whatsapp/scheduled-messages/cron, mirroring the existing
-- automation_pending_executions / flows cron pattern (poll rows
-- where status = 'pending' AND scheduled_at <= now(), claim with a
-- two-step UPDATE, process, mark done). No new queue dependency.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_scheduled_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  content_type TEXT NOT NULL
    CHECK (content_type IN ('text', 'image', 'document', 'audio', 'video')),
  content_text TEXT,
  media_url TEXT,
  filename TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  -- Display/audit only — scheduled_at is already an absolute UTC
  -- instant, so the drain query never consults this column.
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_scheduled_messages_media_required
    CHECK (content_type = 'text' OR media_url IS NOT NULL)
);

-- Drain hot path: due, still-pending rows ordered by schedule time.
CREATE INDEX IF NOT EXISTS idx_whatsapp_scheduled_due
  ON whatsapp_scheduled_messages(scheduled_at) WHERE status = 'pending';

-- Dashboard "list my account's schedule" reads.
CREATE INDEX IF NOT EXISTS idx_whatsapp_scheduled_account
  ON whatsapp_scheduled_messages(account_id, scheduled_at DESC);

ALTER TABLE whatsapp_scheduled_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_scheduled_messages_select ON whatsapp_scheduled_messages;
DROP POLICY IF EXISTS whatsapp_scheduled_messages_insert ON whatsapp_scheduled_messages;
DROP POLICY IF EXISTS whatsapp_scheduled_messages_update ON whatsapp_scheduled_messages;
DROP POLICY IF EXISTS whatsapp_scheduled_messages_delete ON whatsapp_scheduled_messages;

-- Same tier as conversations/messages: viewer reads, agent+ writes.
-- The cron route uses the service-role client and bypasses RLS, same
-- as every other cron-drained table in this schema.
CREATE POLICY whatsapp_scheduled_messages_select ON whatsapp_scheduled_messages FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY whatsapp_scheduled_messages_insert ON whatsapp_scheduled_messages FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY whatsapp_scheduled_messages_update ON whatsapp_scheduled_messages FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY whatsapp_scheduled_messages_delete ON whatsapp_scheduled_messages FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_scheduled_messages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
