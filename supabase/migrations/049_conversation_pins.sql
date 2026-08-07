-- ============================================================
-- 049_conversation_pins.sql — Pin conversations to the top of the
-- inbox list, personal per agent (mirrors WhatsApp's own "pin chat",
-- max 3, but scoped per user rather than per WhatsApp number since
-- multiple agents share one inbox here).
--
-- The "max 3" cap is enforced in application code (POST
-- /api/conversations/[id]/pin), not a DB constraint, so a friendly
-- 409 can be returned instead of a raw constraint-violation error.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_pins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_pins_user
  ON conversation_pins(user_id, pinned_at DESC);

ALTER TABLE conversation_pins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_pins_select ON conversation_pins;
DROP POLICY IF EXISTS conversation_pins_insert ON conversation_pins;
DROP POLICY IF EXISTS conversation_pins_delete ON conversation_pins;

-- Personal: a pin is only ever visible to / manageable by the agent
-- who set it, not the whole account (unlike every other table here,
-- which gates on is_account_member). The account_id check on top is
-- belt-and-suspenders so a pin can never outlive its account.
CREATE POLICY conversation_pins_select ON conversation_pins FOR SELECT
  USING (user_id = auth.uid() AND is_account_member(account_id));
CREATE POLICY conversation_pins_insert ON conversation_pins FOR INSERT
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id));
CREATE POLICY conversation_pins_delete ON conversation_pins FOR DELETE
  USING (user_id = auth.uid() AND is_account_member(account_id));
