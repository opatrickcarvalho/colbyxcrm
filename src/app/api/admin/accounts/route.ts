import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

/**
 * GET /api/admin/accounts?q=<search>
 *
 * Platform-admin only. Lists every tenant account with the fields the
 * operator console table needs — member count, WhatsApp connection
 * status, account status. All queries use the service-role client
 * (`supabaseAdmin()`), which bypasses RLS entirely — that's the whole
 * point of a platform-admin route reading across tenants.
 *
 * Search matches account name OR owner email, done in JS after a
 * single unfiltered fetch rather than a SQL join — simplest thing that
 * works at "a few hundred customers" scale, which is what this MVP is
 * for. Revisit with a real query/index if the account count grows.
 */
export async function GET(request: Request) {
  try {
    await requirePlatformAdmin();
    const db = supabaseAdmin();

    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim().toLowerCase() ?? '';

    const { data: accounts, error: accountsErr } = await db
      .from('accounts')
      .select(
        'id, name, owner_user_id, status, created_at, billing_status, plan_expires_at, billing_exempt'
      )
      .order('created_at', { ascending: false })
      .limit(500);

    if (accountsErr) {
      console.error('[admin/accounts] list error:', accountsErr);
      return NextResponse.json(
        { error: 'Failed to load accounts' },
        { status: 500 }
      );
    }

    const rows = accounts ?? [];
    if (rows.length === 0) {
      return NextResponse.json({ accounts: [] });
    }

    const accountIds = rows.map((a) => a.id);
    const ownerIds = rows.map((a) => a.owner_user_id);

    const [memberRowsRes, ownerProfilesRes, configsRes] = await Promise.all([
      db.from('profiles').select('account_id').in('account_id', accountIds),
      db.from('profiles').select('user_id, email').in('user_id', ownerIds),
      db
        .from('whatsapp_config')
        .select('account_id, provider, status')
        .in('account_id', accountIds),
    ]);

    const memberCounts = new Map<string, number>();
    for (const row of memberRowsRes.data ?? []) {
      memberCounts.set(
        row.account_id,
        (memberCounts.get(row.account_id) ?? 0) + 1
      );
    }
    const ownerEmailByUserId = new Map(
      (ownerProfilesRes.data ?? []).map((p) => [p.user_id, p.email as string])
    );
    const configByAccount = new Map(
      (configsRes.data ?? []).map((c) => [c.account_id, c])
    );

    const result = rows
      .map((a) => {
        const config = configByAccount.get(a.id);
        return {
          id: a.id,
          name: a.name,
          ownerEmail: ownerEmailByUserId.get(a.owner_user_id) ?? null,
          status: a.status as 'active' | 'suspended',
          memberCount: memberCounts.get(a.id) ?? 0,
          whatsapp: config
            ? { provider: config.provider, status: config.status }
            : null,
          billing: {
            status: (a.billing_status as string | null) ?? null,
            planExpiresAt: (a.plan_expires_at as string | null) ?? null,
            exempt: a.billing_exempt === true,
          },
          createdAt: a.created_at,
        };
      })
      .filter((a) => {
        if (!q) return true;
        return (
          a.name.toLowerCase().includes(q) ||
          (a.ownerEmail?.toLowerCase().includes(q) ?? false)
        );
      });

    return NextResponse.json({ accounts: result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
