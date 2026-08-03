import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  getGroupInfo,
  leaveGroup,
  updateGroupAnnounce,
  updateGroupDescription,
  updateGroupImage,
  updateGroupLocked,
  updateGroupName,
  resolveGroupCredentials,
  GroupsNotAvailableError,
  type UazapiGroup,
} from '@/lib/whatsapp/providers/uazapi-groups';
import { fetchChatAvatar } from '@/lib/whatsapp/providers/uazapi';

async function loadLocalGroup(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  id: string
) {
  return supabase
    .from('whatsapp_groups')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const { data: localGroup, error: fetchError } = await loadLocalGroup(
      supabase,
      accountId,
      id
    );
    if (fetchError || !localGroup) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    let creds;
    try {
      creds = await resolveGroupCredentials(supabase, accountId);
    } catch (err) {
      if (err instanceof GroupsNotAvailableError) {
        // Still return the local snapshot so the page can render
        // (e.g. account switched away from UAZAPI after the group
        // was created) — just without a live participant list.
        return NextResponse.json({ data: localGroup, live: null });
      }
      throw err;
    }

    let live: UazapiGroup | null = null;
    let avatarUrl: string | null = null;
    try {
      live = await getGroupInfo(creds.host, creds.token, localGroup.group_jid);
      avatarUrl = await fetchChatAvatar(creds.host, creds.token, localGroup.group_jid);
    } catch (err) {
      console.error(
        '[GET /api/whatsapp/groups/[id]] getGroupInfo/fetchChatAvatar failed:',
        err instanceof Error ? err.message : err
      );
    }

    return NextResponse.json({ data: localGroup, live, avatarUrl });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { id } = await params;

    const limit = checkRateLimit(`groupManage:${userId}`, RATE_LIMITS.groupManage);
    if (!limit.success) return rateLimitResponse(limit);

    const { data: localGroup, error: fetchError } = await loadLocalGroup(
      supabase,
      accountId,
      id
    );
    if (fetchError || !localGroup) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const {
      name,
      description,
      image,
      is_announce,
      is_locked,
      max_participants,
      campaign_slug,
    } = body as {
      name?: string;
      description?: string;
      image?: string;
      is_announce?: boolean;
      is_locked?: boolean;
      max_participants?: number | null;
      campaign_slug?: string | null;
    };

    const localUpdate: Record<string, unknown> = {};
    if (max_participants !== undefined) localUpdate.max_participants = max_participants;
    if (campaign_slug !== undefined) localUpdate.campaign_slug = campaign_slug || null;

    const needsUazapi =
      name !== undefined ||
      description !== undefined ||
      image !== undefined ||
      is_announce !== undefined ||
      is_locked !== undefined;

    if (needsUazapi) {
      let creds;
      try {
        creds = await resolveGroupCredentials(supabase, accountId);
      } catch (err) {
        if (err instanceof GroupsNotAvailableError) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
        throw err;
      }

      try {
        let latest: UazapiGroup | null = null;
        if (name !== undefined) {
          latest = await updateGroupName(creds.host, creds.token, localGroup.group_jid, name);
        }
        if (description !== undefined) {
          latest = await updateGroupDescription(
            creds.host,
            creds.token,
            localGroup.group_jid,
            description
          );
        }
        if (image !== undefined) {
          latest = await updateGroupImage(creds.host, creds.token, localGroup.group_jid, image);
        }
        if (is_announce !== undefined) {
          latest = await updateGroupAnnounce(
            creds.host,
            creds.token,
            localGroup.group_jid,
            is_announce
          );
        }
        if (is_locked !== undefined) {
          latest = await updateGroupLocked(
            creds.host,
            creds.token,
            localGroup.group_jid,
            is_locked
          );
        }
        if (latest) {
          localUpdate.name = latest.name || localGroup.name;
          localUpdate.description = latest.description ?? null;
          localUpdate.is_announce = latest.isAnnounce;
          localUpdate.is_locked = latest.isLocked;
          localUpdate.participant_count = latest.participantCount;
          if (latest.inviteLink) localUpdate.invite_link = latest.inviteLink;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown provider error';
        console.error('[PATCH /api/whatsapp/groups/[id]] uazapi call failed:', message);
        return NextResponse.json({ error: `WhatsApp API error: ${message}` }, { status: 502 });
      }
    }

    if (Object.keys(localUpdate).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('whatsapp_groups')
      .update(localUpdate)
      .eq('id', id)
      .eq('account_id', accountId)
      .select()
      .single();

    if (error) {
      console.error('[PATCH /api/whatsapp/groups/[id]] update error:', error);
      return NextResponse.json(
        { error: 'WhatsApp was updated but saving locally failed.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { id } = await params;

    const limit = checkRateLimit(`groupManage:${userId}`, RATE_LIMITS.groupManage);
    if (!limit.success) return rateLimitResponse(limit);

    const { data: localGroup, error: fetchError } = await loadLocalGroup(
      supabase,
      accountId,
      id
    );
    if (fetchError || !localGroup) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
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

    try {
      await leaveGroup(creds.host, creds.token, localGroup.group_jid);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown provider error';
      console.error('[DELETE /api/whatsapp/groups/[id]] leaveGroup failed:', message);
      return NextResponse.json({ error: `WhatsApp API error: ${message}` }, { status: 502 });
    }

    const { error } = await supabase
      .from('whatsapp_groups')
      .update({ status: 'archived' })
      .eq('id', id)
      .eq('account_id', accountId);

    if (error) {
      console.error('[DELETE /api/whatsapp/groups/[id]] archive error:', error);
      return NextResponse.json(
        { error: 'Left the group on WhatsApp but failed to archive it locally.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
