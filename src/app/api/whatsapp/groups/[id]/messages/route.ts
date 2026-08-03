import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { createUazapiProvider } from '@/lib/whatsapp/providers/uazapi';
import {
  resolveGroupCredentials,
  GroupsNotAvailableError,
} from '@/lib/whatsapp/providers/uazapi-groups';

const MEDIA_KINDS = new Set(['image', 'video', 'document', 'audio']);

// GET /api/whatsapp/groups/[id]/messages — activity feed, newest first.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const { data: group, error: groupErr } = await supabase
      .from('whatsapp_groups')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (groupErr || !group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get('limit')) || 50, 200);
    const before = searchParams.get('before');

    let query = supabase
      .from('whatsapp_group_messages')
      .select('*')
      .eq('group_id', id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (before) query = query.lt('created_at', before);

    const { data, error } = await query;
    if (error) {
      console.error('[GET /api/whatsapp/groups/[id]/messages] error:', error);
      return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 });
    }

    return NextResponse.json({ data: (data ?? []).reverse() });
  } catch (error) {
    return toErrorResponse(error);
  }
}

// POST /api/whatsapp/groups/[id]/messages — send text or native media.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { id } = await params;

    const limit = checkRateLimit(`groupManage:${userId}`, RATE_LIMITS.groupManage);
    if (!limit.success) return rateLimitResponse(limit);

    const { data: group, error: groupErr } = await supabase
      .from('whatsapp_groups')
      .select('id, group_jid')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (groupErr || !group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const { content_type, content_text, media_url, filename } = (body ?? {}) as {
      content_type?: string;
      content_text?: string;
      media_url?: string;
      filename?: string;
    };

    const isMedia = content_type ? MEDIA_KINDS.has(content_type) : false;
    if (!content_type || (content_type !== 'text' && !isMedia)) {
      return NextResponse.json(
        { error: 'content_type must be text, image, video, document or audio' },
        { status: 400 }
      );
    }
    if (content_type === 'text' && !content_text?.trim()) {
      return NextResponse.json({ error: 'content_text is required' }, { status: 400 });
    }
    if (isMedia && !media_url) {
      return NextResponse.json({ error: 'media_url is required' }, { status: 400 });
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

    const provider = createUazapiProvider({ host: creds.host, token: creds.token });

    let providerMessageId: string;
    try {
      if (content_type === 'text') {
        const result = await provider.sendText({ to: group.group_jid, text: content_text! });
        providerMessageId = result.messageId;
      } else {
        const result = await provider.sendMedia({
          to: group.group_jid,
          kind: content_type as 'image' | 'video' | 'document' | 'audio',
          link: media_url!,
          caption: content_type === 'audio' ? undefined : content_text || undefined,
          filename: content_type === 'document' ? filename : undefined,
        });
        providerMessageId = result.messageId;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown provider error';
      console.error('[POST /api/whatsapp/groups/[id]/messages] send failed:', message);
      return NextResponse.json({ error: `WhatsApp API error: ${message}` }, { status: 502 });
    }

    const { data, error } = await supabase
      .from('whatsapp_group_messages')
      .insert({
        account_id: accountId,
        group_id: id,
        direction: 'outbound',
        content_type,
        content_text: content_text || null,
        media_url: media_url || null,
        filename: filename || null,
        provider_message_id: providerMessageId,
      })
      .select()
      .single();

    if (error) {
      console.error('[POST /api/whatsapp/groups/[id]/messages] insert error:', error);
      return NextResponse.json(
        { error: 'Message was sent to WhatsApp but failed to save locally.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
