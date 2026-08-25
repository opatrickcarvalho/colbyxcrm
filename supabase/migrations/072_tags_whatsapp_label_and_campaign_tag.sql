-- ============================================================
-- 072_tags_whatsapp_label_and_campaign_tag
--
-- Two nullable, opt-in bridges, both following the exact precedent
-- 055_pipeline_stage_whatsapp_labels.sql set (a specific feature links
-- directly to whatsapp_labels; tags/contact_tags and whatsapp_labels
-- stay conceptually separate per 048's header comment — this does not
-- introduce a third label system):
--
--   1. tags.whatsapp_label_id — a CRM tag can optionally mirror a real
--      WhatsApp Business label. When a tag with this set gets applied
--      to a contact, the app pushes the corresponding label onto that
--      contact's WhatsApp chat too (see applyTagWhatsappLabel in
--      src/lib/whatsapp/label-write.ts) — so tagging a contact
--      "Veio do Anúncio" in the CRM also makes the label show up on
--      the phone, without the operator doing it twice.
--   2. ad_campaigns.tag_id — which CRM tag (068_ad_campaigns.sql) an
--      ad-link campaign auto-applies to a contact on attribution. Goes
--      through the tag, not directly to a WhatsApp label, so the same
--      "Veio do Anúncio" tag stays the single thing an operator manages
--      (visible on the contact, filterable, reusable across campaigns)
--      and the WhatsApp side rides along via bridge #1.
--
-- ON DELETE SET NULL throughout — deleting a WhatsApp label just
-- un-syncs the tag, deleting a tag just makes a campaign stop
-- auto-tagging; neither blocks the delete or orphans a row.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS whatsapp_label_id UUID REFERENCES whatsapp_labels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tags_whatsapp_label
  ON tags(whatsapp_label_id) WHERE whatsapp_label_id IS NOT NULL;

ALTER TABLE ad_campaigns
  ADD COLUMN IF NOT EXISTS tag_id UUID REFERENCES tags(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_tag
  ON ad_campaigns(tag_id) WHERE tag_id IS NOT NULL;

COMMENT ON COLUMN tags.whatsapp_label_id IS
  'Optional: the real WhatsApp Business label (whatsapp_labels) this CRM tag mirrors. Set from Settings > Campos e etiquetas.';
COMMENT ON COLUMN ad_campaigns.tag_id IS
  'CRM tag auto-applied to a contact on ad-campaign attribution. If that tag has whatsapp_label_id set, the WhatsApp label is pushed too.';
