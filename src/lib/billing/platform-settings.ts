// ============================================================
// Platform-wide billing settings, with a short TTL cache.
//
// `platform_settings` is service-role only (RLS enabled, zero
// policies — same posture as admin_audit_log), so this module is
// server-only. It is read on essentially every authenticated
// request via getCurrentAccount(), which is why it caches: without
// the cache this would add a DB round trip to every API call in the
// product for a value that changes maybe twice a year.
//
// 60 seconds is the deliberate trade: flipping the kill switch takes
// effect within a minute across every running instance, with no
// deploy and no cache-busting infrastructure.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';

import { BILLING_SETTINGS_FALLBACK, type BillingSettings } from './entitlement';

export interface PlatformBillingSettings extends BillingSettings {
  /** Days of free trial seeded onto a brand-new account. */
  trialDays: number;
}

const PLATFORM_FALLBACK: PlatformBillingSettings = {
  ...BILLING_SETTINGS_FALLBACK,
  trialDays: 7,
};

const CACHE_TTL_MS = 60_000;

let cached: PlatformBillingSettings | null = null;
let cachedAt = 0;

/** Coerce a JSONB scalar that may arrive as a JSON string or a number. */
function readInt(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : fallback;
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * Read the billing knobs, cached for 60s per process.
 *
 * NEVER throws and never propagates a DB error. On any failure —
 * including a deployment that has not yet run migration 053, where
 * the table does not exist — it returns the fallback, which has
 * `enforcementEnabled: false`. That is the whole point: a database
 * hiccup must not lock every tenant out of the product. The failure
 * mode is "billing stops being enforced for a minute", not "the CRM
 * goes dark".
 */
export async function getBillingSettings(): Promise<PlatformBillingSettings> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;

  try {
    const db = supabaseAdmin();
    const { data, error } = await db
      .from('platform_settings')
      .select('key, value')
      .in('key', ['billing_enforcement_enabled', 'trial_days', 'grace_days']);

    if (error) {
      // Pre-053 schema (relation does not exist) lands here too.
      console.error('[billing/platform-settings] read error:', error.message);
      cached = PLATFORM_FALLBACK;
      cachedAt = now;
      return cached;
    }

    const byKey = new Map<string, unknown>(
      (data ?? []).map((row) => [row.key as string, row.value])
    );

    cached = {
      enforcementEnabled: readBool(
        byKey.get('billing_enforcement_enabled'),
        PLATFORM_FALLBACK.enforcementEnabled
      ),
      graceDays: readInt(byKey.get('grace_days'), PLATFORM_FALLBACK.graceDays),
      trialDays: readInt(byKey.get('trial_days'), PLATFORM_FALLBACK.trialDays),
    };
    cachedAt = now;
    return cached;
  } catch (err) {
    console.error('[billing/platform-settings] unexpected error:', err);
    cached = PLATFORM_FALLBACK;
    cachedAt = now;
    return cached;
  }
}

/**
 * Drop the cache. Called by the admin PATCH route so an operator
 * flipping the kill switch sees it take effect on their own next
 * request instead of waiting out the TTL. Other instances still take
 * up to 60s — acceptable, and the SQL side (`account_is_entitled`)
 * is immediate regardless, since it reads the table directly.
 */
export function invalidateBillingSettingsCache(): void {
  cached = null;
  cachedAt = 0;
}
