-- ============================================================
-- 072_bio_pages_theme
--
-- Button background color + font color for bio pages (071_bio_pages.sql)
-- — the two customizable knobs the dashboard editor exposes. Stored as
-- plain hex strings and CHECK-constrained to that shape so a bad value
-- can't reach the public page's inline styles, and defaulted to the
-- values the page already rendered with (bg-neutral-900 / text-neutral-100)
-- so existing pages don't visually change on this migration.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE bio_pages
  ADD COLUMN IF NOT EXISTS button_color TEXT NOT NULL DEFAULT '#171717',
  ADD COLUMN IF NOT EXISTS text_color TEXT NOT NULL DEFAULT '#f5f5f5';

ALTER TABLE bio_pages
  DROP CONSTRAINT IF EXISTS bio_pages_button_color_hex,
  DROP CONSTRAINT IF EXISTS bio_pages_text_color_hex;

ALTER TABLE bio_pages
  ADD CONSTRAINT bio_pages_button_color_hex CHECK (button_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT bio_pages_text_color_hex CHECK (text_color ~ '^#[0-9a-fA-F]{6}$');

COMMENT ON COLUMN bio_pages.button_color IS
  'Hex color (#rrggbb) for every button''s background on the public page.';
COMMENT ON COLUMN bio_pages.text_color IS
  'Hex color (#rrggbb) for all text on the public page, including button labels.';
