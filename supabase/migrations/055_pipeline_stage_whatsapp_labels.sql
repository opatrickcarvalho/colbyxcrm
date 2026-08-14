-- ============================================================
-- 055_pipeline_stage_whatsapp_labels.sql — links a pipeline stage to
-- the WhatsApp Business label (whatsapp_labels, migration 048) that
-- represents it on the phone. Deliberately NOT a new label concept:
-- see 048's header comment on why `tags`/`contact_tags` stay separate
-- from WhatsApp labels — this column reuses that same table, it does
-- not introduce a third one.
--
-- Nullable and opt-in per stage: a stage with no linked label behaves
-- exactly as it did before this migration. ON DELETE SET NULL so
-- deleting the WhatsApp label (or disconnecting UAZAPI, which cascades
-- via whatsapp_labels' own account_id FK) just unlinks the stage
-- rather than blocking the delete or orphaning the row.
-- ============================================================

ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS whatsapp_label_id UUID REFERENCES whatsapp_labels(id) ON DELETE SET NULL;

-- Reverse lookup used by the chat_labels webhook handler (uazapi
-- webhook route): "which stage(s) does this newly-applied label map
-- to". Partial — most stages will have no label linked.
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_whatsapp_label
  ON pipeline_stages(whatsapp_label_id)
  WHERE whatsapp_label_id IS NOT NULL;
