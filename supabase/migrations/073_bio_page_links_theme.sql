-- ============================================================
-- 073_bio_page_links_theme
--
-- Moves button_color/text_color (072_bio_pages_theme.sql) from
-- bio_pages down to bio_page_links — buttons are a separate scheme
-- from the profile header (avatar/name/bio), each one individually
-- colorable, not one color applied to every button and to the
-- profile text at once. The profile header goes back to a fixed
-- color, no longer configurable by this feature.
--
-- No data migration needed: as of this migration every bio_pages row
-- still has the untouched defaults ('#171717'/'#f5f5f5'), so backing
-- bio_page_links.button_color/text_color onto those same defaults is
-- exactly equivalent to what every page currently renders.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE bio_page_links
  ADD COLUMN IF NOT EXISTS button_color TEXT NOT NULL DEFAULT '#171717',
  ADD COLUMN IF NOT EXISTS text_color TEXT NOT NULL DEFAULT '#f5f5f5';

ALTER TABLE bio_page_links
  DROP CONSTRAINT IF EXISTS bio_page_links_button_color_hex,
  DROP CONSTRAINT IF EXISTS bio_page_links_text_color_hex;

ALTER TABLE bio_page_links
  ADD CONSTRAINT bio_page_links_button_color_hex CHECK (button_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT bio_page_links_text_color_hex CHECK (text_color ~ '^#[0-9a-fA-F]{6}$');

ALTER TABLE bio_pages
  DROP CONSTRAINT IF EXISTS bio_pages_button_color_hex,
  DROP CONSTRAINT IF EXISTS bio_pages_text_color_hex;

ALTER TABLE bio_pages
  DROP COLUMN IF EXISTS button_color,
  DROP COLUMN IF EXISTS text_color;

COMMENT ON COLUMN bio_page_links.button_color IS
  'Hex color (#rrggbb) for this button''s own background — set per button, not shared with the page.';
COMMENT ON COLUMN bio_page_links.text_color IS
  'Hex color (#rrggbb) for this button''s own label — set per button. The profile name/bio use a fixed color, unrelated to this.';
