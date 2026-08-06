-- ============================================================
-- 044_whatsapp_group_broadcasts.sql — Bulk send to WhatsApp groups
--
-- Deliberately a PARALLEL system to `broadcasts`/`broadcast_recipients`,
-- not an extension of it. That pair is coupled to Meta-approved
-- templates and to `contacts` (with delivered/read tracking that has
-- no equivalent at the group level — WhatsApp exposes no per-member
-- read receipt for a group). Groups are UAZAPI-only (see
-- src/lib/whatsapp/providers/capabilities.ts — Meta's capabilities has
-- `groups: false`), so this never needs to speak template Meta at all;
-- it sends free text/media the same way
-- POST /api/whatsapp/groups/[id]/messages already does.
--
-- Drained by an external cron hitting
-- GET /api/whatsapp/group-broadcasts/cron, mirroring the exact
-- pending/claim/process pattern already used by
-- whatsapp_scheduled_messages (041), automations, and flows.
--
-- Pacing: a campaign's per-group `send_at` is staggered at creation
-- time (target[i].send_at = base + i * delay_seconds) instead of the
-- drain route sleeping between sends — this is what makes the pacing
-- work regardless of how often the external cron polls. `delay_seconds`
-- is a user-set value (default row in whatsapp_group_broadcast_settings,
-- overridable per campaign); the low CHECK floor below only rejects
-- nonsensical input (0/negative), it does not encode WhatsApp policy —
-- WhatsApp does not publish rate limits for this unofficial channel, so
-- the app can only suggest a starting point, never enforce a "safe" one.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- Per-account pacing default. One row per account, mirrors
-- ai_configs (029) / whatsapp_config: settings-class, viewer+ reads,
-- admin+ writes.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_group_broadcast_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  -- Suggested starting point only (shown as the form's prefilled
  -- value with an explanatory hint) — the floor of 1 just keeps the
  -- column sane, it is not a WhatsApp-mandated number.
  delay_seconds INTEGER NOT NULL DEFAULT 8 CHECK (delay_seconds >= 1),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE whatsapp_group_broadcast_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_group_broadcast_settings_select ON whatsapp_group_broadcast_settings;
DROP POLICY IF EXISTS whatsapp_group_broadcast_settings_insert ON whatsapp_group_broadcast_settings;
DROP POLICY IF EXISTS whatsapp_group_broadcast_settings_update ON whatsapp_group_broadcast_settings;
DROP POLICY IF EXISTS whatsapp_group_broadcast_settings_delete ON whatsapp_group_broadcast_settings;

CREATE POLICY whatsapp_group_broadcast_settings_select ON whatsapp_group_broadcast_settings FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY whatsapp_group_broadcast_settings_insert ON whatsapp_group_broadcast_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY whatsapp_group_broadcast_settings_update ON whatsapp_group_broadcast_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY whatsapp_group_broadcast_settings_delete ON whatsapp_group_broadcast_settings FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_group_broadcast_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_group_broadcast_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- One row per campaign.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_group_broadcasts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  whatsapp_config_id UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL
    CHECK (content_type IN ('text', 'image', 'document', 'audio', 'video')),
  content_text TEXT,
  media_url TEXT,
  filename TEXT,
  -- Snapshot of the pacing used for this campaign — editing the
  -- account default later must not retroactively change an in-flight
  -- or already-sent campaign.
  delay_seconds INTEGER NOT NULL CHECK (delay_seconds >= 1),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  total_targets INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  -- Optional future start; NULL means the first target is due ~now.
  scheduled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_group_broadcasts_media_required
    CHECK (content_type = 'text' OR media_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_group_broadcasts_account
  ON whatsapp_group_broadcasts(account_id, created_at DESC);

ALTER TABLE whatsapp_group_broadcasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_group_broadcasts_select ON whatsapp_group_broadcasts;
DROP POLICY IF EXISTS whatsapp_group_broadcasts_insert ON whatsapp_group_broadcasts;
DROP POLICY IF EXISTS whatsapp_group_broadcasts_update ON whatsapp_group_broadcasts;
DROP POLICY IF EXISTS whatsapp_group_broadcasts_delete ON whatsapp_group_broadcasts;

-- Same tier as broadcasts/whatsapp_scheduled_messages: viewer reads,
-- agent+ writes. The cron route uses the service-role client and
-- bypasses RLS, same as every other cron-drained table in this schema.
CREATE POLICY whatsapp_group_broadcasts_select ON whatsapp_group_broadcasts FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY whatsapp_group_broadcasts_insert ON whatsapp_group_broadcasts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY whatsapp_group_broadcasts_update ON whatsapp_group_broadcasts FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY whatsapp_group_broadcasts_delete ON whatsapp_group_broadcasts FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_group_broadcasts;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_group_broadcasts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- One row per group per campaign — the drain unit. Only the cron
-- route (service role) ever writes these, so counters on the parent
-- campaign are bumped with a plain atomic UPDATE from that route
-- rather than a trigger — there is no multi-writer race to guard
-- against here, unlike broadcast_recipients (written by the dashboard
-- client and by the inbound status webhook).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_group_broadcast_targets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broadcast_id UUID NOT NULL REFERENCES whatsapp_group_broadcasts(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Drain hot path: due, still-pending rows ordered by schedule time.
CREATE INDEX IF NOT EXISTS idx_whatsapp_group_broadcast_targets_due
  ON whatsapp_group_broadcast_targets(send_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_whatsapp_group_broadcast_targets_broadcast
  ON whatsapp_group_broadcast_targets(broadcast_id);

ALTER TABLE whatsapp_group_broadcast_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_group_broadcast_targets_select ON whatsapp_group_broadcast_targets;
DROP POLICY IF EXISTS whatsapp_group_broadcast_targets_modify ON whatsapp_group_broadcast_targets;

CREATE POLICY whatsapp_group_broadcast_targets_select ON whatsapp_group_broadcast_targets FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM whatsapp_group_broadcasts b
      WHERE b.id = whatsapp_group_broadcast_targets.broadcast_id
        AND is_account_member(b.account_id)
    )
  );
CREATE POLICY whatsapp_group_broadcast_targets_modify ON whatsapp_group_broadcast_targets FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM whatsapp_group_broadcasts b
      WHERE b.id = whatsapp_group_broadcast_targets.broadcast_id
        AND is_account_member(b.account_id, 'agent')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM whatsapp_group_broadcasts b
      WHERE b.id = whatsapp_group_broadcast_targets.broadcast_id
        AND is_account_member(b.account_id, 'agent')
    )
  );
