-- ============================================================
-- 074_bio_page_links_nsfw
--
-- Per-button "sensitive content" age gate. When nsfw=true, the public
-- page (src/components/bio/bio-page-preview.tsx) intercepts the click
-- and shows a full-screen 18+ confirmation before following the
-- button's real destination — opt-in per button, not a page-wide
-- setting, since one bio page can mix safe and sensitive buttons.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE bio_page_links
  ADD COLUMN IF NOT EXISTS nsfw BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN bio_page_links.nsfw IS
  'When true, the public page shows a full-screen 18+ confirmation before following this button''s destination.';
