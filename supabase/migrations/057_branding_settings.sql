-- ============================================================
-- 057_branding_settings.sql
--
-- Storage for the platform-wide Branding feature (superadmin ->
-- /admin/branding): custom site name, favicon and logo applied to
-- the whole deployed instance.
--
-- No new table — reuses `platform_settings` (migration 053), the
-- existing service-role-only key/value config store, with three new
-- keys written by /api/admin/branding:
--   branding_site_name  (text, JSONB string)
--   branding_logo_url   (text, JSONB string, public Storage URL)
--   branding_icon_url   (text, JSONB string, public Storage URL)
-- Keys simply don't exist until the first save; readers treat a
-- missing key as unset, same convention as the billing settings.
--
-- Creates the `branding` Storage bucket: publicly readable (so the
-- uploaded logo/icon render via plain <img> / fetch without signed
-- URLs), but with NO write policies at all — every writer is the
-- platform-admin-gated API route using the service-role client,
-- which bypasses RLS entirely. Unlike 008_profile_avatars_storage's
-- per-user path-scoped policies, there both is and needs to be
-- exactly one writer here, so per-user path checks don't apply.
--
-- Idempotent — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'branding',
  'branding',
  TRUE,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Branding assets are publicly readable" ON storage.objects;
CREATE POLICY "Branding assets are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'branding');
