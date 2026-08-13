// ============================================================
// Entitlement guard for SERVICE-ROLE code paths.
//
// The RLS gate (migration 054) covers everything that runs as the
// signed-in user. It deliberately does NOT cover the engine: crons,
// webhooks and the send core all use `supabaseAdmin()`, which
// bypasses RLS entirely — that is what lets an inbound WhatsApp
// message keep being persisted for an unpaid tenant.
//
// So the engine needs its own check, applied at exactly the points
// that SPEND money or SEND messages on the customer's behalf, and
// nowhere else. Persistence of inbound data is never guarded here.
//
// Memoised because a cron drains up to 50 rows per pass and they
// frequently belong to one account: without the cache that's 50
// identical queries per minute, forever.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isEntitled } from './entitlement';
import { getBillingSettings } from './platform-settings';

const CACHE_TTL_MS = 30_000;

type CacheEntry = { entitled: boolean; at: number };

/**
 * Process-wide cache. 30s is short enough that a payment confirmed
 * by the webhook unblocks the next cron pass, and long enough to
 * collapse a whole batch into one query.
 */
const cache = new Map<string, CacheEntry>();

/**
 * Is this account allowed to send / spend right now?
 *
 * Fail-OPEN on any error, matching `isEntitled()` and the SQL
 * predicate: a database blip must not silently stop every tenant's
 * scheduled messages. The consequence of being wrong in this
 * direction is a few messages sent for a lapsed account; the
 * consequence of being wrong the other way is a paying customer's
 * campaign never going out, with a `failed` row and no explanation.
 */
export async function accountIsEntitled(
  db: SupabaseClient,
  accountId: string
): Promise<boolean> {
  if (!accountId) return true;

  const now = Date.now();
  const hit = cache.get(accountId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.entitled;

  let entitled = true;
  try {
    const settings = await getBillingSettings();
    // Cheap out before touching the accounts table at all when
    // billing is switched off platform-wide.
    if (settings.enforcementEnabled) {
      const { data, error } = await db
        .from('accounts')
        .select('billing_status, plan_expires_at, billing_exempt')
        .eq('id', accountId)
        .maybeSingle();

      if (error) {
        console.error('[billing/guard] accounts read error:', error.message);
      } else {
        entitled = isEntitled(data, settings, new Date(now));
      }
    }
  } catch (err) {
    console.error('[billing/guard] unexpected error:', err);
  }

  cache.set(accountId, { entitled, at: now });
  return entitled;
}

/**
 * Forget a cached decision. Call after the webhook moves an
 * account's horizon so the very next send is unblocked rather than
 * waiting out the TTL — the customer just paid; they should not
 * watch their queue sit still for another 30 seconds.
 */
export function invalidateEntitlement(accountId: string): void {
  cache.delete(accountId);
}

/** Test seam. */
export function clearEntitlementCache(): void {
  cache.clear();
}
