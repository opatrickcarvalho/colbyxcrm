-- ============================================================
-- 048_whatsapp_labels.sql — WhatsApp Business labels, mirrored from
-- UAZAPI (GET /labels, POST /label/edit, POST /chat/labels), not a
-- CRM-only construct. Deliberately separate from `tags`/`contact_tags`
-- (issue raised mid-implementation: a parallel CRM label would create
-- "two forms of label" — one in the CRM, one on the phone. This table
-- IS the WhatsApp Business label, cached locally and kept in sync by
-- the `labels`/`chat_labels` webhook events plus the app-initiated
-- writes through the endpoints above).
--
-- UAZAPI-only (see providers/capabilities.ts) — Meta Cloud API has no
-- equivalent concept.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_labels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- uazapi's own label id (its `labelid`, e.g. "10") — a small string,
  -- NOT necessarily numeric-stable across instances, so stored as text.
  uazapi_label_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- uazapi's fixed 0-19 palette index, not a free hex color.
  color_code INTEGER NOT NULL CHECK (color_code BETWEEN 0 AND 19),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, uazapi_label_id)
);

CREATE TABLE IF NOT EXISTS conversation_whatsapp_labels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  whatsapp_label_id UUID NOT NULL REFERENCES whatsapp_labels(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(conversation_id, whatsapp_label_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_whatsapp_labels_conversation
  ON conversation_whatsapp_labels(conversation_id);

ALTER TABLE whatsapp_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_whatsapp_labels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_labels_select ON whatsapp_labels;
DROP POLICY IF EXISTS whatsapp_labels_insert ON whatsapp_labels;
DROP POLICY IF EXISTS whatsapp_labels_update ON whatsapp_labels;
DROP POLICY IF EXISTS whatsapp_labels_delete ON whatsapp_labels;

CREATE POLICY whatsapp_labels_select ON whatsapp_labels FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY whatsapp_labels_insert ON whatsapp_labels FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY whatsapp_labels_update ON whatsapp_labels FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY whatsapp_labels_delete ON whatsapp_labels FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS conversation_whatsapp_labels_select ON conversation_whatsapp_labels;
DROP POLICY IF EXISTS conversation_whatsapp_labels_insert ON conversation_whatsapp_labels;
DROP POLICY IF EXISTS conversation_whatsapp_labels_delete ON conversation_whatsapp_labels;

CREATE POLICY conversation_whatsapp_labels_select ON conversation_whatsapp_labels FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_whatsapp_labels.conversation_id
        AND is_account_member(c.account_id)
    )
  );
CREATE POLICY conversation_whatsapp_labels_insert ON conversation_whatsapp_labels FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_whatsapp_labels.conversation_id
        AND is_account_member(c.account_id, 'agent')
    )
  );
CREATE POLICY conversation_whatsapp_labels_delete ON conversation_whatsapp_labels FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_whatsapp_labels.conversation_id
        AND is_account_member(c.account_id, 'agent')
    )
  );
