import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateSendMessageParams, SendMessageError } from '@/lib/whatsapp/send-message'

// PATCH/DELETE only apply while a scheduled message is still 'pending'
// — once the cron has claimed it ('processing') or it has a terminal
// status ('sent'/'failed'/'cancelled'), edits are rejected so a client
// can't race the drain into overwriting the audit trail of what was
// actually sent.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params

    const body = await request.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { content_text, media_url, filename, scheduled_at } = body as {
      content_text?: string | null
      media_url?: string | null
      filename?: string | null
      scheduled_at?: string
    }

    const { data: existing, error: fetchError } = await supabase
      .from('whatsapp_scheduled_messages')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()

    if (fetchError || !existing) {
      return NextResponse.json({ error: 'Scheduled message not found' }, { status: 404 })
    }
    if (existing.status !== 'pending') {
      return NextResponse.json(
        { error: `Cannot edit a scheduled message with status "${existing.status}"` },
        { status: 409 }
      )
    }

    const update: Record<string, unknown> = {}

    if (content_text !== undefined || media_url !== undefined) {
      try {
        validateSendMessageParams({
          messageType: existing.content_type as string,
          contentText: content_text ?? (existing.content_text as string | null),
          mediaUrl: media_url ?? (existing.media_url as string | null),
        })
      } catch (err) {
        if (err instanceof SendMessageError) {
          return NextResponse.json({ error: err.message }, { status: err.status })
        }
        throw err
      }
      if (content_text !== undefined) update.content_text = content_text || null
      if (media_url !== undefined) update.media_url = media_url || null
      if (filename !== undefined) update.filename = filename || null
    }

    if (scheduled_at !== undefined) {
      const scheduledDate = new Date(scheduled_at)
      if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
        return NextResponse.json(
          { error: 'scheduled_at must be a valid future date/time' },
          { status: 400 }
        )
      }
      update.scheduled_at = scheduledDate.toISOString()
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('whatsapp_scheduled_messages')
      .update(update)
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .select()
      .maybeSingle()

    if (error) {
      console.error('[PATCH /api/whatsapp/scheduled-messages/[id]] error:', error)
      return NextResponse.json({ error: 'Failed to update scheduled message' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'Scheduled message was already claimed for sending' },
        { status: 409 }
      )
    }

    return NextResponse.json({ data })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params

    const { data, error } = await supabase
      .from('whatsapp_scheduled_messages')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[DELETE /api/whatsapp/scheduled-messages/[id]] error:', error)
      return NextResponse.json({ error: 'Failed to cancel scheduled message' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'Scheduled message not found or no longer pending' },
        { status: 404 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
