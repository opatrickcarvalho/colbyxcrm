-- ============================================================
-- 059_messages_account_id.sql
--
-- Denormalizes account_id onto messages so Supabase Realtime can
-- filter the messages postgres_changes listener server-side
-- (`filter: 'account_id=eq.<accountId>'`) instead of relying solely
-- on RLS to drop other tenants' rows after they've already been
-- evaluated for delivery. Realtime's `filter` only supports simple
-- comparisons against a literal column on the watched table — it
-- cannot filter through the conversation_id -> conversations.account_id
-- join, hence this denormalization.
--
-- Also adds the composite indexes the Inbox's paginated queries need
-- as conversation/message history grows:
--   messages(conversation_id, created_at)      -- per-conversation page fetch
--   conversations(account_id, last_message_at) -- conversation list ordering
--
-- Sequencing for the new column (standard safe-migration pattern —
-- nullable, backfill, then NOT NULL) so this never locks/breaks a
-- live table with rows mid-flight:
--   1. add column nullable
--   2. backfill from conversations via conversation_id
--   3. add trigger so every future INSERT self-heals account_id even
--      if application code forgets to set it (several insert paths
--      run through the service-role client, bypassing RLS, so there
--      is no other backstop)
--   4. re-backfill (covers any rows inserted between step 1 and the
--      trigger going live)
--   5. SET NOT NULL + index
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 1) Nullable column first.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;

-- 2) Backfill existing rows from their conversation.
UPDATE messages m
SET account_id = c.account_id
FROM conversations c
WHERE m.conversation_id = c.id
  AND m.account_id IS NULL;

-- 3) Trigger backstop: auto-populate account_id from conversation_id
--    on every future INSERT where the caller didn't set it.
CREATE OR REPLACE FUNCTION public.set_message_account_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.account_id IS NULL THEN
    SELECT c.account_id INTO NEW.account_id
    FROM conversations c
    WHERE c.id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_message_account_id ON messages;
CREATE TRIGGER set_message_account_id
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.set_message_account_id();

-- 4) Re-backfill in case of a race between step 2 and the trigger
--    going live (idempotent no-op on a clean run).
UPDATE messages m
SET account_id = c.account_id
FROM conversations c
WHERE m.conversation_id = c.id
  AND m.account_id IS NULL;

-- 5) NOT NULL + index — the new hot filter key for Realtime and any
--    future account-scoped message query.
ALTER TABLE messages ALTER COLUMN account_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);

-- 6) Composite indexes for the Inbox's paginated queries.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_account_last_message ON conversations(account_id, last_message_at);
