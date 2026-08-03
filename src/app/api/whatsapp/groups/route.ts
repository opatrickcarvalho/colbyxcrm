import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  createGroup,
  resolveGroupCredentials,
  GroupsNotAvailableError,
} from '@/lib/whatsapp/providers/uazapi-groups';

// Dashboard CRUD for whatsapp_groups. Group-mutating calls always go
// to UAZAPI first (the real WhatsApp group), then get mirrored onto
// the local row — never the other way around, so the local table can
// never claim a state the actual group doesn't have.
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const { data, error } = await supabase
      .from('whatsapp_groups')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/whatsapp/groups] error:', error);
      return NextResponse.json({ error: 'Failed to load groups' }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`groupManage:${userId}`, RATE_LIMITS.groupManage);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { name, participants, campaign_slug, max_participants } = body as {
      name?: string;
      participants?: string[];
      campaign_slug?: string | null;
      max_participants?: number | null;
    };

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!Array.isArray(participants) || participants.length === 0) {
      return NextResponse.json(
        { error: 'participants must be a non-empty array of phone numbers' },
        { status: 400 }
      );
    }

    let creds;
    try {
      creds = await resolveGroupCredentials(supabase, accountId);
    } catch (err) {
      if (err instanceof GroupsNotAvailableError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    let group;
    try {
      group = await createGroup(creds.host, creds.token, {
        name: name.trim(),
        participants,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown provider error';
      console.error('[POST /api/whatsapp/groups] uazapi createGroup failed:', message);
      return NextResponse.json({ error: `WhatsApp API error: ${message}` }, { status: 502 });
    }

    if (!group.jid) {
      return NextResponse.json(
        { error: 'UAZAPI created the group but returned no group id.' },
        { status: 502 }
      );
    }

    const { data, error } = await supabase
      .from('whatsapp_groups')
      .insert({
        account_id: accountId,
        whatsapp_config_id: creds.configId,
        group_jid: group.jid,
        name: group.name || name.trim(),
        description: group.description || null,
        invite_link: group.inviteLink || null,
        participant_count: group.participantCount,
        max_participants: max_participants ?? null,
        campaign_slug: campaign_slug || null,
        is_announce: group.isAnnounce,
        is_locked: group.isLocked,
        created_by: userId,
      })
      .select()
      .single();

    if (error) {
      console.error('[POST /api/whatsapp/groups] insert error:', error);
      return NextResponse.json(
        { error: 'Group was created on WhatsApp but failed to save locally.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
