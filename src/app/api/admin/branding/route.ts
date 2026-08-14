import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  getBrandingSettings,
  invalidateBrandingSettingsCache,
} from '@/lib/branding/get-branding';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);
const MAX_SITE_NAME_LENGTH = 120;

/**
 * GET /api/admin/branding
 *
 * Invalidates the cache first so an operator opening this page never
 * sees a stale value from another instance's change (the cache is
 * otherwise a 60s TTL, see src/lib/branding/get-branding.ts).
 */
export async function GET() {
  try {
    await requirePlatformAdmin();
    invalidateBrandingSettingsCache();
    const settings = await getBrandingSettings();
    return NextResponse.json({ settings });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function extensionFor(file: File): string {
  const fromName = file.name.split('.').pop()?.toLowerCase();
  if (fromName && fromName.length <= 5) return fromName;
  const fromMime = file.type.split('/').pop();
  return fromMime === 'svg+xml' ? 'svg' : (fromMime ?? 'png');
}

/**
 * PATCH /api/admin/branding
 *
 * Writes to `platform_settings` (migration 057), same posture as
 * every other writer of that table: service-role-only. This is the
 * one route allowed to touch the `branding_*` keys and the
 * `branding` Storage bucket.
 *
 * Accepts multipart/form-data (it may carry files):
 *   siteName?: string
 *   icon?: File, logo?: File
 *   clearIcon?: 'true', clearLogo?: 'true'
 */
export async function PATCH(request: Request) {
  try {
    await requirePlatformAdmin();

    const form = await request.formData();
    const siteNameRaw = form.get('siteName');
    const icon = form.get('icon');
    const logo = form.get('logo');
    const clearIcon = form.get('clearIcon') === 'true';
    const clearLogo = form.get('clearLogo') === 'true';

    const rows: { key: string; value: unknown }[] = [];
    const db = supabaseAdmin();

    if (typeof siteNameRaw === 'string') {
      const trimmed = siteNameRaw.trim();
      if (trimmed.length > MAX_SITE_NAME_LENGTH) {
        return NextResponse.json(
          { error: `siteName must be at most ${MAX_SITE_NAME_LENGTH} characters` },
          { status: 400 }
        );
      }
      rows.push({ key: 'branding_site_name', value: trimmed || null });
    }

    for (const [field, file, clear, key] of [
      ['icon', icon, clearIcon, 'branding_icon_url'],
      ['logo', logo, clearLogo, 'branding_logo_url'],
    ] as const) {
      if (file instanceof File && file.size > 0) {
        if (!ALLOWED_MIME.has(file.type)) {
          return NextResponse.json(
            { error: `${field} has an unsupported image type` },
            { status: 400 }
          );
        }
        if (file.size > MAX_FILE_BYTES) {
          return NextResponse.json(
            { error: `${field} exceeds the 2MB limit` },
            { status: 400 }
          );
        }

        const path = `${field}.${extensionFor(file)}`;
        const { error: uploadError } = await db.storage
          .from('branding')
          .upload(path, file, {
            cacheControl: '60',
            upsert: true,
            contentType: file.type,
          });
        if (uploadError) {
          console.error(
            `[PATCH /api/admin/branding] upload error (${field}):`,
            uploadError.message
          );
          return NextResponse.json(
            { error: `Failed to upload ${field}` },
            { status: 500 }
          );
        }

        const {
          data: { publicUrl },
        } = db.storage.from('branding').getPublicUrl(path);
        rows.push({ key, value: `${publicUrl}?v=${Date.now()}` });
      } else if (clear) {
        rows.push({ key, value: null });
      }
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'No fields to update' },
        { status: 400 }
      );
    }

    const { error } = await db
      .from('platform_settings')
      .upsert(rows, { onConflict: 'key' });

    if (error) {
      console.error('[PATCH /api/admin/branding] upsert error:', error.message);
      return NextResponse.json(
        { error: 'Failed to update settings' },
        { status: 500 }
      );
    }

    invalidateBrandingSettingsCache();
    const settings = await getBrandingSettings();

    return NextResponse.json({ settings });
  } catch (err) {
    return toErrorResponse(err);
  }
}
