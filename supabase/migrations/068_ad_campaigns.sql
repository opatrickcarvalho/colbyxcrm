-- ============================================================
-- 068_ad_campaigns
--
-- Attribution for WhatsApp leads that arrive from paid traffic (a Meta
-- "Click to WhatsApp" ad, an Instagram bio link, a QR code, a Google Ads
-- landing page, ...).
--
-- Why this can't just read Meta's `referral`/`ctwa_clid` field: this
-- CRM's WhatsApp connection is UAZAPI (038_whatsapp_provider_uazapi.sql),
-- an unofficial Baileys-based bridge. It never receives the official
-- WhatsApp Cloud API's ad-click referral object, so attribution has to
-- be reconstructed CRM-side instead of read off the wire.
--
-- The mechanism: an `ad_campaigns` row owns a short code and a prefilled
-- wa.me message template. The code reaches the lead's outgoing message
-- one of two ways — via this CRM's own `/l/{code}` redirect (see
-- src/app/l/[code]/route.ts), which also logs a click in
-- `ad_campaign_clicks`, or pasted directly into a native Meta
-- "Click to WhatsApp" ad's own prefilled-message field (that ad type
-- sends the user straight into WhatsApp with no URL hop, so our
-- redirect can't sit in the middle of it — same code, no click log).
-- Either way, the inbound webhook
-- (src/app/api/whatsapp/uazapi/webhook/[secret]/route.ts) reads the
-- code back out of the first message from a brand-new contact and
-- tags it.
--
-- Naming: 052_campaigns.sql already claimed "campaigns" for OUTBOUND
-- bulk-send broadcasts (whatsapp_group_broadcasts et al, surfaced as
-- "Campaigns" in the sidebar). This is a different, INBOUND-attribution
-- concept — hence `ad_campaigns`, not another `campaigns` table, to
-- avoid colliding with that module's name and code.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ad_campaigns — one row per paid-traffic source.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Author / audit only — never used for tenancy isolation.
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  -- Short code, GLOBALLY unique (not scoped to account_id): the public
  -- /l/{code} redirect and the inbound webhook's first-touch matcher
  -- both start from just the code, before they know which account it
  -- belongs to.
  code TEXT NOT NULL,
  -- wa.me prefilled-message template. Must contain the literal
  -- placeholder {code}, substituted with this campaign's own code —
  -- dynamically by the redirect route, or once by hand when an operator
  -- copies the rendered text into a native Meta ad's prefilled message.
  message_template TEXT NOT NULL DEFAULT 'Olá! Vim pelo anúncio #{code}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_campaigns_code ON ad_campaigns(code);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_account
  ON ad_campaigns(account_id, created_at DESC);

ALTER TABLE ad_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_campaigns_select ON ad_campaigns;
DROP POLICY IF EXISTS ad_campaigns_insert ON ad_campaigns;
DROP POLICY IF EXISTS ad_campaigns_update ON ad_campaigns;
DROP POLICY IF EXISTS ad_campaigns_delete ON ad_campaigns;

-- The public /l/{code} redirect and the inbound webhook both read/write
-- this table with the service-role client (supabaseAdmin(), same as
-- resolveConversationByPhone and the webhook itself), which bypasses
-- RLS by design — there is no session on a live ad click.
CREATE POLICY ad_campaigns_select ON ad_campaigns FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY ad_campaigns_insert ON ad_campaigns FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY ad_campaigns_update ON ad_campaigns FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY ad_campaigns_delete ON ad_campaigns FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON ad_campaigns;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ad_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 2. ad_campaign_clicks — minimal click log, /l/{code} path only.
--
-- Exists to support the redirect's click count and a rough
-- click -> conversation funnel, not as a general analytics event
-- store. No client INSERT/UPDATE policy: service-role only, same
-- posture as automation_pending_executions / flow_runs.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ad_campaign_clicks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT,
  user_agent TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  -- Set best-effort by the webhook once a matching inbound message
  -- arrives: the most recent unmatched click for the campaign. A
  -- heuristic, not a cryptographic pairing — see the webhook route's
  -- comment at the match site.
  matched_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  matched_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ad_campaign_clicks_campaign
  ON ad_campaign_clicks(campaign_id, clicked_at DESC);
-- Backs the webhook's "most recent unmatched click for this campaign"
-- lookup specifically.
CREATE INDEX IF NOT EXISTS idx_ad_campaign_clicks_unmatched
  ON ad_campaign_clicks(campaign_id, clicked_at DESC)
  WHERE matched_contact_id IS NULL;

ALTER TABLE ad_campaign_clicks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_campaign_clicks_select ON ad_campaign_clicks;

CREATE POLICY ad_campaign_clicks_select ON ad_campaign_clicks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM ad_campaigns c
      WHERE c.id = ad_campaign_clicks.campaign_id
        AND is_account_member(c.account_id)
    )
  );

-- ------------------------------------------------------------
-- 3. contacts — attribution, snapshotted so it survives a later
--    campaign rename/delete.
-- ------------------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_source_campaign_id UUID
    REFERENCES ad_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_source_campaign_name TEXT,
  ADD COLUMN IF NOT EXISTS lead_source_matched_code TEXT,
  ADD COLUMN IF NOT EXISTS lead_source_matched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_lead_source_campaign
  ON contacts(lead_source_campaign_id) WHERE lead_source_campaign_id IS NOT NULL;

COMMENT ON COLUMN ad_campaigns.code IS
  'Short, globally-unique tracking code embedded in the wa.me prefilled message, e.g. #AB12CD.';
COMMENT ON COLUMN contacts.lead_source_campaign_name IS
  'Snapshot of ad_campaigns.name at match time — survives the campaign being renamed or deleted later.';
