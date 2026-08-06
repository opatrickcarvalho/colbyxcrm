-- ============================================================
-- 045_whatsapp_group_broadcast_bump.sql — atomic counter bump
--
-- whatsapp_group_broadcast_targets has a single writer (the cron
-- drain route, service role), but two overlapping cron invocations
-- could still process different targets of the same campaign
-- concurrently, and a naive read-then-write increment from the app
-- would lose updates under that race. This mirrors the existing
-- _bcast_bump (005) / claim_ai_reply_slot (029) pattern: a single
-- atomic UPDATE inside a SECURITY DEFINER function, called via RPC
-- from the cron route right after a target's status is settled.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.bump_whatsapp_group_broadcast_counters(
  p_broadcast_id UUID,
  p_success BOOLEAN
)
RETURNS VOID AS $$
  UPDATE whatsapp_group_broadcasts
  SET
    sent_count = sent_count + (CASE WHEN p_success THEN 1 ELSE 0 END),
    failed_count = failed_count + (CASE WHEN p_success THEN 0 ELSE 1 END),
    updated_at = NOW()
  WHERE id = p_broadcast_id;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- Only the cron route (service role) calls this.
GRANT EXECUTE ON FUNCTION public.bump_whatsapp_group_broadcast_counters(UUID, BOOLEAN) TO service_role;
