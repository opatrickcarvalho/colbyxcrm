-- ============================================================
-- 075_bio_page_link_groups.sql
--
-- Adds a third bio_page_links shape: type='whatsapp_group'. Unlike
-- type='whatsapp' (which points at one ad_campaigns row), this type
-- points at an ORDERED POOL of existing whatsapp_groups rows via the
-- new bio_page_link_groups join table. The public /b/{slug}/go/{id}
-- redirect (src/app/b/[slug]/go/[linkId]/route.ts) walks the pool in
-- order at click time and sends the visitor to the first group that
-- still has room (checked live via UAZAPI getGroupInfo) — no
-- "current group" pointer is persisted anywhere, so a group that
-- drops back below max_participants becomes eligible again on its
-- own, with no extra logic required.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Widen bio_page_links' type/shape CHECKs to allow whatsapp_group.
--    Its destination lives in bio_page_link_groups below, not in a
--    column, so both url and ad_campaign_id stay NULL for this type.
-- ------------------------------------------------------------
ALTER TABLE bio_page_links DROP CONSTRAINT IF EXISTS bio_page_links_type_check;
ALTER TABLE bio_page_links ADD CONSTRAINT bio_page_links_type_check
  CHECK (type IN ('link', 'whatsapp', 'whatsapp_group', 'social', 'embed'));

ALTER TABLE bio_page_links DROP CONSTRAINT IF EXISTS bio_page_links_type_shape;
ALTER TABLE bio_page_links ADD CONSTRAINT bio_page_links_type_shape CHECK (
  (type = 'whatsapp' AND ad_campaign_id IS NOT NULL AND url IS NULL)
  OR (type = 'whatsapp_group' AND ad_campaign_id IS NULL AND url IS NULL)
  OR (type IN ('link', 'social', 'embed') AND url IS NOT NULL AND ad_campaign_id IS NULL)
);

-- ------------------------------------------------------------
-- 2. bio_page_link_groups — the ordered pool of groups backing one
--    whatsapp_group-type link. Always replaced wholesale (delete +
--    insert) from the editor, never patched row-by-row, so there's no
--    updated_at/trigger.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bio_page_link_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  link_id UUID NOT NULL REFERENCES bio_page_links(id) ON DELETE CASCADE,
  -- Cascades on purpose: if a group is deleted elsewhere in the app,
  -- it should silently drop out of any pool referencing it rather
  -- than block the delete or leave a dangling row.
  whatsapp_group_id UUID NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
  -- Denormalized from bio_page_links.account_id (same reasoning as
  -- that column's own comment in 071_bio_pages.sql) so RLS stays a
  -- flat is_account_member(account_id, ...) check instead of an
  -- EXISTS-through-bio_page_links subquery.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bio_page_link_groups_link_group_key UNIQUE (link_id, whatsapp_group_id)
);

CREATE INDEX IF NOT EXISTS idx_bio_page_link_groups_link_position
  ON bio_page_link_groups(link_id, position);

ALTER TABLE bio_page_link_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bio_page_link_groups_select ON bio_page_link_groups;
DROP POLICY IF EXISTS bio_page_link_groups_insert ON bio_page_link_groups;
DROP POLICY IF EXISTS bio_page_link_groups_update ON bio_page_link_groups;
DROP POLICY IF EXISTS bio_page_link_groups_delete ON bio_page_link_groups;

CREATE POLICY bio_page_link_groups_select ON bio_page_link_groups FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY bio_page_link_groups_insert ON bio_page_link_groups FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY bio_page_link_groups_update ON bio_page_link_groups FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY bio_page_link_groups_delete ON bio_page_link_groups FOR DELETE
  USING (is_account_member(account_id, 'agent'));
