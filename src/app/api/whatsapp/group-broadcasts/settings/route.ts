import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { SUGGESTED_DELAY_SECONDS } from '@/lib/whatsapp/group-broadcast';

// GET/PUT /api/whatsapp/group-broadcasts/settings — the account's
// pacing default (whatsapp_group_broadcast_settings, one row per
// account). RLS already restricts writes to admin+; this route just
// upserts, it does not re-check role beyond `requireRole('agent')`
// (read-only for agents, RLS rejects an agent's UPDATE attempt).
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const { data, error } = await supabase
      .from('whatsapp_group_broadcast_settings')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[GET /api/whatsapp/group-broadcasts/settings] error:', error);
      return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
    }

    return NextResponse.json({
      data: data ?? { account_id: accountId, delay_seconds: SUGGESTED_DELAY_SECONDS },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const body = await request.json().catch(() => null);
    const { delay_seconds } = (body ?? {}) as { delay_seconds?: number };

    if (!Number.isFinite(delay_seconds) || (delay_seconds as number) < 1) {
      return NextResponse.json(
        { error: 'delay_seconds must be a number >= 1' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('whatsapp_group_broadcast_settings')
      .upsert(
        { account_id: accountId, delay_seconds, created_by: userId },
        { onConflict: 'account_id' }
      )
      .select()
      .single();

    if (error) {
      // RLS blocks non-admins from writing this table — surface that
      // as 403 rather than a generic 500.
      const status = error.code === '42501' ? 403 : 500;
      console.error('[PUT /api/whatsapp/group-broadcasts/settings] error:', error);
      return NextResponse.json(
        {
          error:
            status === 403
              ? 'Only account admins can change this setting'
              : 'Failed to save settings',
        },
        { status }
      );
    }

    return NextResponse.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
