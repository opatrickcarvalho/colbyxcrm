-- ============================================================
-- 071_bio_pages
--
-- "Link in bio" pages — one per account, a public page at /b/{slug}
-- with an ordered list of clickable buttons (generic link, WhatsApp,
-- social icon, inline embed), plus view/click logging so every button
-- is measurable. Modeled directly on ad_campaigns/ad_campaign_clicks
-- (068_ad_campaigns.sql, 070_ad_campaigns_readable_code.sql) — same
-- RLS shape (is_account_member), same "public route logs best-effort,
-- never renders an error page" convention as src/app/l/[code]/route.ts.
--
-- WhatsApp buttons deliberately do NOT duplicate wa.me-building logic:
-- a `whatsapp`-type link just points at an existing ad_campaigns row
-- (ad_campaign_id) and the public /b/{slug}/go/{linkId} route 302s
-- through the existing /l/{code} route, which owns the wa.me build,
-- its own click logging, and the inbound-webhook attribution.
--
-- GA4/Facebook Pixel are explicitly out of scope here (deferred by
-- the product owner to a later change) — no columns for them.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. bio_pages — one row per account.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bio_pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  -- Display casing kept in `slug`; `slug_key` (generated, lowercase)
  -- owns the uniqueness constraint and every public lookup — same
  -- split as ad_campaigns.code/code_key, and for the same reason: the
  -- public /b/{slug} route resolves by slug alone, before it knows
  -- which account it belongs to, and matching must be
  -- case-insensitive without ILIKE's wildcard-escaping concerns.
  slug TEXT NOT NULL,
  slug_key TEXT GENERATED ALWAYS AS (lower(slug)) STORED,
  display_name TEXT NOT NULL,
  bio TEXT,
  avatar_url TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bio_pages_slug_key ON bio_pages(slug_key);

ALTER TABLE bio_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bio_pages_select ON bio_pages;
DROP POLICY IF EXISTS bio_pages_insert ON bio_pages;
DROP POLICY IF EXISTS bio_pages_update ON bio_pages;
DROP POLICY IF EXISTS bio_pages_delete ON bio_pages;

-- The public /b/{slug} page and /b/{slug}/go/{linkId} redirect both
-- read this table with supabaseAdmin() (service role), which bypasses
-- RLS by design — there is no session on a live page view.
CREATE POLICY bio_pages_select ON bio_pages FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY bio_pages_insert ON bio_pages FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY bio_pages_update ON bio_pages FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY bio_pages_delete ON bio_pages FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON bio_pages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON bio_pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 2. bio_page_links — N per page, ordered.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bio_page_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bio_page_id UUID NOT NULL REFERENCES bio_pages(id) ON DELETE CASCADE,
  -- Denormalized from bio_pages.account_id (not resolved via a join)
  -- so RLS can use the same flat is_account_member(account_id, ...)
  -- policy shape as every other account-scoped table, instead of an
  -- EXISTS subquery through bio_pages.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('link', 'whatsapp', 'social', 'embed')),
  label TEXT NOT NULL,
  -- Required for link/social/embed, null for whatsapp (which routes
  -- through ad_campaign_id instead).
  url TEXT,
  -- Required for whatsapp, null otherwise.
  ad_campaign_id UUID REFERENCES ad_campaigns(id) ON DELETE SET NULL,
  -- lucide icon name (type=link) or a social platform key like
  -- 'instagram'/'tiktok'/'youtube' (type=social). Unused for
  -- whatsapp/embed.
  icon TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bio_page_links_type_shape CHECK (
    (type = 'whatsapp' AND ad_campaign_id IS NOT NULL AND url IS NULL)
    OR (type IN ('link', 'social', 'embed') AND url IS NOT NULL AND ad_campaign_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_bio_page_links_page_position
  ON bio_page_links(bio_page_id, position);
CREATE INDEX IF NOT EXISTS idx_bio_page_links_account
  ON bio_page_links(account_id);

ALTER TABLE bio_page_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bio_page_links_select ON bio_page_links;
DROP POLICY IF EXISTS bio_page_links_insert ON bio_page_links;
DROP POLICY IF EXISTS bio_page_links_update ON bio_page_links;
DROP POLICY IF EXISTS bio_page_links_delete ON bio_page_links;

CREATE POLICY bio_page_links_select ON bio_page_links FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY bio_page_links_insert ON bio_page_links FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY bio_page_links_update ON bio_page_links FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY bio_page_links_delete ON bio_page_links FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON bio_page_links;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON bio_page_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 3. bio_page_link_clicks — click log, mirrors ad_campaign_clicks.
--
-- Service-role only writes (the public /go/{linkId} route) — no
-- client insert/update policy, same posture as ad_campaign_clicks.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bio_page_link_clicks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  link_id UUID NOT NULL REFERENCES bio_page_links(id) ON DELETE CASCADE,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT,
  user_agent TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT
);

CREATE INDEX IF NOT EXISTS idx_bio_page_link_clicks_link
  ON bio_page_link_clicks(link_id, clicked_at DESC);

ALTER TABLE bio_page_link_clicks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bio_page_link_clicks_select ON bio_page_link_clicks;

CREATE POLICY bio_page_link_clicks_select ON bio_page_link_clicks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bio_page_links l
      WHERE l.id = bio_page_link_clicks.link_id
        AND is_account_member(l.account_id)
    )
  );

-- ------------------------------------------------------------
-- 4. bio_page_views — page-view log, separate from clicks (CTR needs
--    both). Same service-role-only-write posture.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bio_page_views (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bio_page_id UUID NOT NULL REFERENCES bio_pages(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_bio_page_views_page
  ON bio_page_views(bio_page_id, viewed_at DESC);

ALTER TABLE bio_page_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bio_page_views_select ON bio_page_views;

CREATE POLICY bio_page_views_select ON bio_page_views FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bio_pages p
      WHERE p.id = bio_page_views.bio_page_id
        AND is_account_member(p.account_id)
    )
  );

-- ------------------------------------------------------------
-- 5. Storage — bio-page-media bucket for avatar uploads.
--
-- Same shape as the `avatars` bucket (008_profile_avatars_storage.sql):
-- public read (renders via plain <img>/<Image> with no signed URLs),
-- writes scoped by a path-convention check. The difference is the
-- scoped segment is account_id, not auth.uid() — this is an
-- account-owned resource, any agent+ member of the account may
-- replace the page's avatar, not just whoever uploaded it.
-- Convention: bio-page-media/{account_id}/avatar-<timestamp>.<ext>
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'bio-page-media',
  'bio-page-media',
  TRUE,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Bio page media is publicly readable" ON storage.objects;
CREATE POLICY "Bio page media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'bio-page-media');

DROP POLICY IF EXISTS "Account members can upload bio page media" ON storage.objects;
CREATE POLICY "Account members can upload bio page media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'bio-page-media'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'agent')
  );

DROP POLICY IF EXISTS "Account members can update bio page media" ON storage.objects;
CREATE POLICY "Account members can update bio page media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'bio-page-media'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'agent')
  );

DROP POLICY IF EXISTS "Account members can delete bio page media" ON storage.objects;
CREATE POLICY "Account members can delete bio page media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'bio-page-media'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'agent')
  );

COMMENT ON COLUMN bio_pages.slug IS
  'Human-chosen public URL segment as typed by the operator — original casing kept for display.';
COMMENT ON COLUMN bio_pages.slug_key IS
  'lower(slug), generated. The actual uniqueness constraint and the public /b/{slug} lookup filter on this, not on slug.';
COMMENT ON COLUMN bio_page_links.ad_campaign_id IS
  'Set only for type=whatsapp — the public redirect delegates to the existing /l/{code} route for this campaign rather than rebuilding the wa.me link itself.';
