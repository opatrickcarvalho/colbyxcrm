'use client';

// ============================================================
// Shared fetch of GET /api/billing.
//
// Two consumers: the dashboard shell (which only needs `entitled` to
// decide whether to redirect to /billing) and the billing page itself
// (which needs the full snapshot). Kept as one hook rather than two
// so the response shape is defined once — see src/lib/billing/api-types.ts.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import type { BillingSummaryResponse } from '@/lib/billing/api-types';

interface UseBillingStatusResult {
  data: BillingSummaryResponse | null;
  loading: boolean;
  /** True once the first fetch has settled (success or failure). */
  loaded: boolean;
  refetch: () => Promise<void>;
}

/**
 * Fetches billing status for the caller's own account.
 *
 * `enabled` gates the fetch on auth having resolved — calling this
 * before a session exists would 401 and log noise on every logged-out
 * page load, since dashboard-shell mounts before `useAuth()` settles.
 */
export function useBillingStatus(enabled: boolean): UseBillingStatusResult {
  const [data, setData] = useState<BillingSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/billing');
      if (!res.ok) {
        // 401/402/403 all mean "nothing to show here" for this hook's
        // purposes — the page-level fetch (if any) handles the 402
        // specially. Don't throw; just leave `data` at its last value.
        return;
      }
      const json = (await res.json()) as BillingSummaryResponse;
      setData(json);
    } catch (err) {
      console.error('[useBillingStatus] fetch failed:', err);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refetch();
  }, [enabled, refetch]);

  return { data, loading, loaded, refetch };
}
