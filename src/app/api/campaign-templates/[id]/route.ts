import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { validateSendMessageParams, SendMessageError } from '@/lib/whatsapp/send-message'
import { GROUP_CONTENT_TYPES } from '@/lib/whatsapp/group-broadcast'
import { validateSpintax } from '@/lib/campaigns/spintax'

// Update / delete a single campaign template. Templates are account-
// shared, so every mutation is scoped by `account_id` (the service-role
// client bypasses the agent-gated RLS, so both the role check and the
// account scope are enforced here) — same pattern as quick-replies.

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if (typeof body.name === 'string') {
    const name = body.name.trim()
    if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    update.name = name
  }

  // content_type drives which shape content_text/media_url must take —
  // same convention as quick-replies' `kind` switch — so changing it
  // requires the matching content in the SAME request rather than
  // trying to infer validity against whatever the row already has.
  if ('content_type' in body) {
    const content_type = body.content_type
    if (
      typeof content_type !== 'string' ||
      !(GROUP_CONTENT_TYPES as readonly string[]).includes(content_type)
    ) {
      return NextResponse.json(
        { error: `content_type must be one of: ${GROUP_CONTENT_TYPES.join(', ')}` },
        { status: 400 },
      )
    }
    const content_text = typeof body.content_text === 'string' ? body.content_text : null
    const media_url = typeof body.media_url === 'string' ? body.media_url : null
    try {
      validateSendMessageParams({
        messageType: content_type,
        contentText: content_text,
        mediaUrl: media_url,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }
    update.content_type = content_type
    update.content_text = content_text
    update.media_url = media_url
    if ('filename' in body) {
      update.filename = typeof body.filename === 'string' ? body.filename : null
    }
  } else {
    if ('content_text' in body) {
      update.content_text = typeof body.content_text === 'string' ? body.content_text : null
    }
    if ('media_url' in body) {
      update.media_url = typeof body.media_url === 'string' ? body.media_url : null
    }
    if ('filename' in body) {
      update.filename = typeof body.filename === 'string' ? body.filename : null
    }
  }

  if (typeof update.content_text === 'string' && update.content_text) {
    const check = validateSpintax(update.content_text)
    if (!check.ok) {
      return NextResponse.json(
        { error: `Invalid spintax template: ${check.error}` },
        { status: 400 },
      )
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true })
  }

  const { error } = await supabaseAdmin()
    .from('campaign_templates')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { error } = await supabaseAdmin()
    .from('campaign_templates')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
