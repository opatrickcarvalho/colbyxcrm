import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  getBillingSettings,
  invalidateBillingSettingsCache,
} from '@/lib/billing/platform-settings';

/**
 * GET /api/admin/billing-settings
 *
 * The only reader of `platform_settings` outside the cached
 * `getBillingSettings()` helper — invalidates the cache first so an
 * operator opening this page never sees a stale kill-switch value
 * from another instance's change (the cache is otherwise a 60s TTL,
 * see src/lib/billing/platform-settings.ts).
 */
export async function GET() {
  try {
    await requirePlatformAdmin();
    invalidateBillingSettingsCache();
    const settings = await getBillingSettings();
    return NextResponse.json({ settings });
  } catch (err) {
    return toErrorResponse(err);
  }
}

interface UpdateSettingsBody {
  enforcementEnabled?: unknown;
  trialDays?: unknown;
  graceDays?: unknown;
}

/**
 * PATCH /api/admin/billing-settings
 *
 * Writes to `platform_settings` (migration 053), which every other
 * writer in the codebase treats as service-role-only, zero-RLS-policy
 * config — see the table's own comment. This is the ONE app route
 * allowed to touch it, and it exists purely so the kill switch,
 * trial_days and grace_days stop being "edit them by hand in the SQL
 * editor" — every other piece of this feature was already built.
 */
export async function PATCH(request: Request) {
  try {
    await requirePlatformAdmin();

    const body = (await request.json().catch(() => ({}))) as UpdateSettingsBody;
    const { enforcementEnabled, trialDays, graceDays } = body;

    const rows: { key: string; value: unknown }[] = [];

    if (enforcementEnabled !== undefined) {
      if (typeof enforcementEnabled !== 'boolean') {
        return NextResponse.json(
          { error: 'enforcementEnabled must be a boolean' },
          { status: 400 }
        );
      }
      rows.push({
        key: 'billing_enforcement_enabled',
        value: enforcementEnabled,
      });
    }
    if (trialDays !== undefined) {
      if (
        typeof trialDays !== 'number' ||
        !Number.isFinite(trialDays) ||
        trialDays < 0
      ) {
        return NextResponse.json(
          { error: 'trialDays must be a non-negative number' },
          { status: 400 }
        );
      }
      rows.push({ key: 'trial_days', value: Math.round(trialDays) });
    }
    if (graceDays !== undefined) {
      if (
        typeof graceDays !== 'number' ||
        !Number.isFinite(graceDays) ||
        graceDays < 0
      ) {
        return NextResponse.json(
          { error: 'graceDays must be a non-negative number' },
          { status: 400 }
        );
      }
      rows.push({ key: 'grace_days', value: Math.round(graceDays) });
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'No fields to update' },
        { status: 400 }
      );
    }

    const db = supabaseAdmin();
    const { error } = await db
      .from('platform_settings')
      .upsert(rows, { onConflict: 'key' });

    if (error) {
      console.error(
        '[PATCH /api/admin/billing-settings] upsert error:',
        error.message
      );
      return NextResponse.json(
        { error: 'Failed to update settings' },
        { status: 500 }
      );
    }

    // Every instance still takes up to 60s to notice via its own TTL
    // (see the module comment) — this only guarantees the operator's
    // OWN next request reflects the change immediately.
    invalidateBillingSettingsCache();
    const settings = await getBillingSettings();

    return NextResponse.json({ settings });
  } catch (err) {
    return toErrorResponse(err);
  }
}
