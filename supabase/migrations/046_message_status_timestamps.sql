-- ============================================================
-- Per-message delivery/read timestamps.
--
-- `messages.status` (migration 001) already tracks the current tick
-- state (sending/sent/delivered/read/failed), but not *when* each
-- transition happened. `broadcast_recipients` already has
-- sent_at/delivered_at/read_at for exactly this reason — mirror the
-- same three columns onto `messages` so the inbox can show "Lido às
-- 14:32" the same way broadcasts already can.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
