import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { validateSendMessageParams, SendMessageError } from '@/lib/whatsapp/send-message'

// Dashboard CRUD for whatsapp_scheduled_messages. The actual send
// happens later, out-of-band, via the cron drain route
// (src/app/api/whatsapp/scheduled-messages/cron/route.ts) which reuses
// sendMessageToConversation — this route only ever persists a row.
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent')

    const { searchParams } = new URL(request.url)
    const conversationId = searchParams.get('conversation_id')

    let query = supabase
      .from('whatsapp_scheduled_messages')
      .select('*, conversation:conversations(id, contact:contacts(name, phone))')
      .eq('account_id', accountId)
      .order('scheduled_at', { ascending: true })

    if (conversationId) {
      query = query.eq('conversation_id', conversationId)
    }

    const { data, error } = await query
    if (error) {
      console.error('[GET /api/whatsapp/scheduled-messages] error:', error)
      return NextResponse.json(
        { error: 'Failed to load scheduled messages' },
        { status: 500 }
      )
    }

    return NextResponse.json({ data })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(
      `scheduledMessageCreate:${userId}`,
      RATE_LIMITS.scheduledMessageCreate
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const {
      conversation_id,
      message_type,
      content_text,
      media_url,
      filename,
      scheduled_at,
      timezone,
    } = body as {
      conversation_id?: string
      message_type?: string
      content_text?: string | null
      media_url?: string | null
      filename?: string | null
      scheduled_at?: string
      timezone?: string
    }

    if (!conversation_id || !message_type || !scheduled_at) {
      return NextResponse.json(
        { error: 'conversation_id, message_type and scheduled_at are required' },
        { status: 400 }
      )
    }

    // Scheduling only supports text + native media (not templates or
    // interactive payloads — those have their own capability-gating
    // concerns that don't fit a fire-later flow cleanly). Reject early.
    if (!['text', 'image', 'document', 'audio', 'video'].includes(message_type)) {
      return NextResponse.json(
        { error: `Unsupported message_type "${message_type}" for scheduling` },
        { status: 400 }
      )
    }

    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    const scheduledDate = new Date(scheduled_at)
    if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
      return NextResponse.json(
        { error: 'scheduled_at must be a valid future date/time' },
        { status: 400 }
      )
    }

    // Scope the conversation lookup by account so a caller can't
    // schedule a send into a conversation belonging to another tenant.
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversation_id)
      .eq('account_id', accountId)
      .maybeSingle()

    if (convError || !conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const { data, error } = await supabase
      .from('whatsapp_scheduled_messages')
      .insert({
        account_id: accountId,
        conversation_id,
        created_by: userId,
        content_type: message_type,
        content_text: content_text || null,
        media_url: media_url || null,
        filename: filename || null,
        scheduled_at: scheduledDate.toISOString(),
        timezone: timezone || 'America/Sao_Paulo',
      })
      .select()
      .single()

    if (error) {
      console.error('[POST /api/whatsapp/scheduled-messages] insert error:', error)
      return NextResponse.json(
        { error: 'Failed to schedule message' },
        { status: 500 }
      )
    }

    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
