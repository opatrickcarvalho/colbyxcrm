-- ============================================================
-- 042_whatsapp_groups.sql — WhatsApp group entity (Uazapi-only)
--
-- Standalone admin module: a group is NOT a conversation. No changes
-- to conversations/messages. Participant rosters are always fetched
-- live from Uazapi (getGroupInfo) — only participant_count is
-- mirrored locally (kept fresh by the 'groups' webhook event) so the
-- list view can render a capacity bar without an API round trip.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Ties the group to the WhatsApp number administering it. Kept even
  -- though today there's exactly one config per account — this column
  -- is what lets a future multi-number phase attribute groups to a
  -- specific number without another migration.
  whatsapp_config_id UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  group_jid TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  invite_link TEXT,
  participant_count INTEGER NOT NULL DEFAULT 0,
  max_participants INTEGER,
  -- Free-text tag for filtering in the admin UI. Not a foreign key —
  -- there's no campaigns table yet.
  campaign_slug TEXT,
  is_announce BOOLEAN NOT NULL DEFAULT FALSE,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_groups_account_jid_key UNIQUE (account_id, group_jid)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_account_status
  ON whatsapp_groups(account_id, status);

ALTER TABLE whatsapp_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_groups_select ON whatsapp_groups;
DROP POLICY IF EXISTS whatsapp_groups_insert ON whatsapp_groups;
DROP POLICY IF EXISTS whatsapp_groups_update ON whatsapp_groups;
DROP POLICY IF EXISTS whatsapp_groups_delete ON whatsapp_groups;

-- Same tier as conversations/broadcasts: viewer reads, agent+ writes
-- (group actions mutate real WhatsApp state). The webhook upsert path
-- uses the service-role client and bypasses RLS.
CREATE POLICY whatsapp_groups_select ON whatsapp_groups FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY whatsapp_groups_insert ON whatsapp_groups FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY whatsapp_groups_update ON whatsapp_groups FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY whatsapp_groups_delete ON whatsapp_groups FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_groups;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_groups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
