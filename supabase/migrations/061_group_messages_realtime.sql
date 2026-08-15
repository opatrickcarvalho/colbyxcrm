-- ============================================================
-- 061_group_messages_realtime.sql — Realtime for the group thread
--
-- whatsapp_group_messages (migration 043) was never added to the
-- supabase_realtime publication, so the group inbox tab had no live
-- updates — a new inbound/outbound message only appeared after
-- switching groups and re-fetching. Mirrors what 001_initial_schema.sql
-- already does for `messages`/`conversations`.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'whatsapp_group_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_group_messages;
  END IF;
END $$;
