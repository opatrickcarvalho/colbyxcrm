// ============================================================
// Platform-wide branding (site name, logo, favicon), with a short
// TTL cache — same shape as src/lib/billing/platform-settings.ts.
//
// `platform_settings` is service-role only (RLS enabled, zero
// policies), so this module is server-only. It is read on nearly
// every page render (root layout metadata, dashboard/auth layouts,
// the favicon route), which is why it caches: without it, every
// page load would add a DB round trip for a value that changes at
// most a few times ever.
//
// 60 seconds is the deliberate trade: an operator saving new
// branding sees it reflected on their own next request (the API
// route invalidates the cache before responding); every other
// running instance picks it up within a minute, no deploy required.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';

export interface BrandingSettings {
  siteName: string | null;
  logoUrl: string | null;
  iconUrl: string | null;
}

const BRANDING_FALLBACK: BrandingSettings = {
  siteName: null,
  logoUrl: null,
  iconUrl: null,
};

const CACHE_TTL_MS = 60_000;

let cached: BrandingSettings | null = null;
let cachedAt = 0;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Read the branding settings, cached for 60s per process.
 *
 * NEVER throws. On any failure — including a deployment that has
 * not yet run migration 057, where the keys simply don't exist —
 * it returns the fallback (everything null), so every consumer
 * falls back to today's hardcoded defaults instead of erroring.
 *
 * Pass `{ skipCache: true }` for a low-traffic surface where the old
 * value being visible for up to 60s after a save is unacceptable
 * (e.g. the logged-out login screen) — trades a DB round trip on
 * that request for a hard guarantee of freshness.
 */
export async function getBrandingSettings(
  opts: { skipCache?: boolean } = {}
): Promise<BrandingSettings> {
  const now = Date.now();
  if (!opts.skipCache && cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const db = supabaseAdmin();
    const { data, error } = await db
      .from('platform_settings')
      .select('key, value')
      .in('key', [
        'branding_site_name',
        'branding_logo_url',
        'branding_icon_url',
      ]);

    if (error) {
      console.error('[branding/get-branding] read error:', error.message);
      cached = BRANDING_FALLBACK;
      cachedAt = now;
      return cached;
    }

    const byKey = new Map<string, unknown>(
      (data ?? []).map((row) => [row.key as string, row.value])
    );

    cached = {
      siteName: readString(byKey.get('branding_site_name')),
      logoUrl: readString(byKey.get('branding_logo_url')),
      iconUrl: readString(byKey.get('branding_icon_url')),
    };
    cachedAt = now;
    return cached;
  } catch (err) {
    console.error('[branding/get-branding] unexpected error:', err);
    cached = BRANDING_FALLBACK;
    cachedAt = now;
    return cached;
  }
}

/**
 * Drop the settings cache. Called by the admin PATCH route so an
 * operator saving branding sees it take effect on their own next
 * request instead of waiting out the TTL.
 */
export function invalidateBrandingSettingsCache(): void {
  cached = null;
  cachedAt = 0;
  iconBytesCache = null;
}

interface IconBytesCache {
  url: string;
  bytes: ArrayBuffer;
  contentType: string;
  fetchedAt: number;
}

let iconBytesCache: IconBytesCache | null = null;

/**
 * Fetch and cache the raw bytes of the custom favicon, so
 * src/app/icon.tsx never hits Storage more than once per minute per
 * server process. Returns null if no custom icon is configured, or
 * if fetching it fails (the caller falls back to the default glyph).
 */
export async function getBrandingIconBytes(): Promise<{
  bytes: ArrayBuffer;
  contentType: string;
} | null> {
  const { iconUrl } = await getBrandingSettings();
  if (!iconUrl) return null;

  const now = Date.now();
  if (
    iconBytesCache &&
    iconBytesCache.url === iconUrl &&
    now - iconBytesCache.fetchedAt < CACHE_TTL_MS
  ) {
    return {
      bytes: iconBytesCache.bytes,
      contentType: iconBytesCache.contentType,
    };
  }

  try {
    const res = await fetch(iconUrl);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') ?? 'image/png';
    iconBytesCache = { url: iconUrl, bytes, contentType, fetchedAt: now };
    return { bytes, contentType };
  } catch (err) {
    console.error('[branding/get-branding] icon fetch error:', err);
    return null;
  }
}
