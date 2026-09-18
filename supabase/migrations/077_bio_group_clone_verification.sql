-- ============================================================
-- 077_bio_group_clone_verification.sql
--
-- Verification trail for the whatsapp_group_pool auto-clone
-- (src/lib/bio/whatsapp-group-pool.ts, 076_bio_page_link_group_pool_claims.sql):
-- after cloning + mirroring the template's settings onto a new group,
-- the module now re-reads the group and checks it actually matches
-- (description, announce/locked flags, and — the one the operator
-- specifically asked to guarantee — that every admin from the
-- template group is really an admin on the clone). Anything still
-- wrong after up to two automatic retries gets recorded here instead
-- of only reaching a server log no one reads.
--
-- setup_issues / setup_checked_at are NULL for every group that
-- didn't go through auto-clone (manually created or imported groups)
-- — NULL means "not applicable", an empty array means "checked and
-- clean", a non-empty array is what the dashboard warns about.
--
-- notifications gets a matching 'bio_group_clone_issue' type (same
-- shape as the existing 'ai_handoff' broadcast added in
-- 063_ai_handoff_notifications.sql) plus a nullable group_id so a
-- notification can deep-link straight to the affected group, the
-- same way conversation_id already does for chat notifications.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_groups
  ADD COLUMN IF NOT EXISTS setup_issues TEXT[],
  ADD COLUMN IF NOT EXISTS setup_checked_at TIMESTAMPTZ;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES whatsapp_groups(id) ON DELETE SET NULL;

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'ai_handoff', 'bio_group_clone_issue'));
