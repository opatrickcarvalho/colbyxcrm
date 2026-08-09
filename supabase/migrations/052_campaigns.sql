-- ============================================================
-- 052_campaigns.sql — turn group broadcasts into a full campaigns module
--
-- Builds on 044/045 rather than starting a third parallel system: those
-- tables already carry the per-target `send_at` staggering and the
-- `pending -> processing` claim that the cron drain depends on. Renaming
-- them would buy nothing and would conflict with every upstream merge, so
-- the names stay and the capabilities grow.
--
-- What's new here:
--   1. A campaign can only send inside a business-hours window, on chosen
--      weekdays, with a randomised gap between sends (anti-spam pacing).
--   2. A target is now a group, a saved contact, OR a hand-typed phone
--      number — exactly one of the three.
--   3. Local message templates (NOT Meta's approved templates — this is
--      the unofficial UAZAPI path, which has no template concept).
--   4. Saved, reusable audiences, so "Leads Quentes" can be built once
--      and fired at repeatedly.
--
-- The Meta path (`broadcasts` / `broadcast_recipients`, migration 001) is
-- deliberately untouched.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Campaign-level scheduling + humanisation
-- ------------------------------------------------------------
ALTER TABLE whatsapp_group_broadcasts
  -- Percentage swing applied to `delay_seconds` per gap: 20 means each
  -- gap lands somewhere in 0.8x-1.2x. A campaign that fires on an exact
  -- metronome is the single most obvious bot signature, so the default
  -- is deliberately non-zero.
  ADD COLUMN IF NOT EXISTS delay_jitter_pct INTEGER NOT NULL DEFAULT 20
    CHECK (delay_jitter_pct BETWEEN 0 AND 90),
  -- NULL window_start/window_end means "no restriction, send around the
  -- clock" — kept nullable rather than defaulting to 00:00-23:59 so the
  -- UI can tell "unset" from "deliberately all day".
  ADD COLUMN IF NOT EXISTS window_start TIME,
  ADD COLUMN IF NOT EXISTS window_end TIME,
  -- ISO weekdays, 1 = Monday .. 7 = Sunday. NULL means every day.
  ADD COLUMN IF NOT EXISTS window_days SMALLINT[],
  -- The window is wall-clock, so it is meaningless without the zone it
  -- was authored in. Stored per campaign (not per account) because a
  -- campaign aimed at another region may legitimately differ.
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN IF NOT EXISTS spintax_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Zero-width characters: off by default because some WhatsApp clients
  -- render U+200B as a visible glyph.
  ADD COLUMN IF NOT EXISTS invisible_chars BOOLEAN NOT NULL DEFAULT FALSE,
  -- Audit only: which saved audience seeded this campaign's targets.
  -- Targets are snapshotted at creation, so later edits to the audience
  -- never mutate a campaign that already went out.
  ADD COLUMN IF NOT EXISTS audience_id UUID;

DO $$
BEGIN
  -- Both bounds or neither: a half-configured window would silently
  -- behave as "no window" and surprise the operator.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_group_broadcasts_window_pair'
  ) THEN
    ALTER TABLE whatsapp_group_broadcasts
      ADD CONSTRAINT whatsapp_group_broadcasts_window_pair
      CHECK (num_nonnulls(window_start, window_end) <> 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_group_broadcasts_window_days_valid'
  ) THEN
    ALTER TABLE whatsapp_group_broadcasts
      ADD CONSTRAINT whatsapp_group_broadcasts_window_days_valid
      CHECK (
        window_days IS NULL
        OR (
          array_length(window_days, 1) BETWEEN 1 AND 7
          AND window_days <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[]
        )
      );
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. A target is a group, a contact, or a raw phone number
--
-- `group_id` loses NOT NULL. The XOR check is what keeps the drain
-- route's branching honest: exactly one recipient kind per row, so
-- there is never an ambiguous target to interpret.
-- ------------------------------------------------------------
ALTER TABLE whatsapp_group_broadcast_targets
  ALTER COLUMN group_id DROP NOT NULL;

ALTER TABLE whatsapp_group_broadcast_targets
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  -- E.164-ish digits for a number typed or pasted by hand, normalised
  -- app-side before insert. Deliberately NOT a contacts FK: the whole
  -- point is reaching someone who was never saved.
  ADD COLUMN IF NOT EXISTS phone TEXT,
  -- The spintax variant actually rendered for THIS recipient, frozen at
  -- creation. Without it there is no way to answer "what exactly did we
  -- send this person?", since re-rendering would roll new dice.
  ADD COLUMN IF NOT EXISTS rendered_text TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_group_broadcast_targets_one_recipient'
  ) THEN
    ALTER TABLE whatsapp_group_broadcast_targets
      ADD CONSTRAINT whatsapp_group_broadcast_targets_one_recipient
      CHECK (num_nonnulls(group_id, contact_id, phone) = 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_whatsapp_group_broadcast_targets_contact
  ON whatsapp_group_broadcast_targets(contact_id) WHERE contact_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3. Local message templates
--
-- Separate from `quick_replies` (035) on purpose: those are short inbox
-- snippets owned by the composer, with no media and no spintax. Mixing
-- campaign concerns into that table would drag the inbox into every
-- campaign change and conflict on upstream merges.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Author / audit only — never used for tenancy isolation.
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text'
    CHECK (content_type IN ('text', 'image', 'document', 'audio', 'video')),
  -- May contain spintax; validated app-side by validateSpintax().
  content_text TEXT,
  media_url TEXT,
  filename TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_templates_account
  ON campaign_templates(account_id, created_at DESC);

ALTER TABLE campaign_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campaign_templates_select ON campaign_templates;
DROP POLICY IF EXISTS campaign_templates_insert ON campaign_templates;
DROP POLICY IF EXISTS campaign_templates_update ON campaign_templates;
DROP POLICY IF EXISTS campaign_templates_delete ON campaign_templates;

CREATE POLICY campaign_templates_select ON campaign_templates FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY campaign_templates_insert ON campaign_templates FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY campaign_templates_update ON campaign_templates FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY campaign_templates_delete ON campaign_templates FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON campaign_templates;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON campaign_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 4. Saved, reusable audiences
--
-- A campaign snapshots its targets at creation time, so an audience is
-- a reusable *recipe*, not a live link — editing "Leads Quentes"
-- tomorrow must not rewrite a campaign that already fired.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_audiences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_audiences_account
  ON campaign_audiences(account_id, created_at DESC);

ALTER TABLE campaign_audiences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campaign_audiences_select ON campaign_audiences;
DROP POLICY IF EXISTS campaign_audiences_insert ON campaign_audiences;
DROP POLICY IF EXISTS campaign_audiences_update ON campaign_audiences;
DROP POLICY IF EXISTS campaign_audiences_delete ON campaign_audiences;

CREATE POLICY campaign_audiences_select ON campaign_audiences FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY campaign_audiences_insert ON campaign_audiences FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY campaign_audiences_update ON campaign_audiences FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY campaign_audiences_delete ON campaign_audiences FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON campaign_audiences;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON campaign_audiences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Same three recipient kinds as a campaign target, same XOR rule.
CREATE TABLE IF NOT EXISTS campaign_audience_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  audience_id UUID NOT NULL REFERENCES campaign_audiences(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  group_id UUID REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_audience_members_one_recipient
    CHECK (num_nonnulls(contact_id, group_id, phone) = 1)
);

CREATE INDEX IF NOT EXISTS idx_campaign_audience_members_audience
  ON campaign_audience_members(audience_id);

ALTER TABLE campaign_audience_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campaign_audience_members_select ON campaign_audience_members;
DROP POLICY IF EXISTS campaign_audience_members_modify ON campaign_audience_members;

-- Membership is governed by the parent audience, mirroring how
-- whatsapp_group_broadcast_targets defers to its parent campaign (044).
CREATE POLICY campaign_audience_members_select ON campaign_audience_members FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM campaign_audiences a
      WHERE a.id = campaign_audience_members.audience_id
        AND is_account_member(a.account_id)
    )
  );
CREATE POLICY campaign_audience_members_modify ON campaign_audience_members FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM campaign_audiences a
      WHERE a.id = campaign_audience_members.audience_id
        AND is_account_member(a.account_id, 'agent')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM campaign_audiences a
      WHERE a.id = campaign_audience_members.audience_id
        AND is_account_member(a.account_id, 'agent')
    )
  );

-- Deferred to the end so the referenced table exists. ON DELETE SET NULL:
-- deleting an audience must never cascade into finished campaigns.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_group_broadcasts_audience_fk'
  ) THEN
    ALTER TABLE whatsapp_group_broadcasts
      ADD CONSTRAINT whatsapp_group_broadcasts_audience_fk
      FOREIGN KEY (audience_id) REFERENCES campaign_audiences(id) ON DELETE SET NULL;
  END IF;
END $$;
