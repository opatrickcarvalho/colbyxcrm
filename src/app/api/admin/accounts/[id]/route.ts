import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

/**
 * GET /api/admin/accounts/[id]
 *
 * Platform-admin only. Account detail: the account row, its members
 * (for the "Entrar como" picker), its WhatsApp connection, and usage
 * counts computed on demand (no rollup table for this MVP — fine at
 * the query volumes a per-account admin page sees).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const db = supabaseAdmin();

    const { data: account, error: accountErr } = await db
      .from('accounts')
      .select('id, name, owner_user_id, status, suspended_at, suspended_reason, created_at')
      .eq('id', id)
      .maybeSingle();

    if (accountErr) {
      console.error('[admin/accounts/:id] account fetch error:', accountErr);
      return NextResponse.json(
        { error: 'Failed to load account' },
        { status: 500 }
      );
    }
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();

    const [
      membersRes,
      configRes,
      contactsCountRes,
      conversationsCountRes,
      messagesCountRes,
    ] = await Promise.all([
      db
        .from('profiles')
        .select('user_id, full_name, email, account_role')
        .eq('account_id', id)
        .order('account_role', { ascending: false }),
      db
        .from('whatsapp_config')
        .select('provider, status, connected_at')
        .eq('account_id', id)
        .maybeSingle(),
      db
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', id),
      db
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', id),
      db
        .from('messages')
        .select('id, conversations!inner(account_id)', {
          count: 'exact',
          head: true,
        })
        .eq('conversations.account_id', id)
        .gte('created_at', thirtyDaysAgo),
    ]);

    return NextResponse.json({
      account,
      members: membersRes.data ?? [],
      whatsapp: configRes.data ?? null,
      usage: {
        contactCount: contactsCountRes.count ?? 0,
        conversationCount: conversationsCountRes.count ?? 0,
        messagesLast30d: messagesCountRes.count ?? 0,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
