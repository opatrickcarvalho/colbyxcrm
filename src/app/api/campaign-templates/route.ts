import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { validateSendMessageParams, SendMessageError } from '@/lib/whatsapp/send-message'
import { GROUP_CONTENT_TYPES } from '@/lib/whatsapp/group-broadcast'
import { validateSpintax } from '@/lib/campaigns/spintax'

// Reusable campaign message templates — local text/media snippets that
// may contain spintax (see 052_campaigns.sql for why this is kept
// separate from quick_replies). GET lists; POST creates. Mirrors
// quick-replies: RLS-scoped read via the user client, service-role
// write after an explicit role check.

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    // RLS (campaign_templates_select) scopes to the caller's account.
    const { data, error } = await supabase
      .from('campaign_templates')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ templates: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const content_type = typeof body.content_type === 'string' ? body.content_type : 'text'
  if (!(GROUP_CONTENT_TYPES as readonly string[]).includes(content_type)) {
    return NextResponse.json(
      { error: `content_type must be one of: ${GROUP_CONTENT_TYPES.join(', ')}` },
      { status: 400 },
    )
  }

  const content_text = typeof body.content_text === 'string' ? body.content_text : null
  const media_url = typeof body.media_url === 'string' ? body.media_url : null
  const filename = typeof body.filename === 'string' ? body.filename : null

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

  if (content_text) {
    const check = validateSpintax(content_text)
    if (!check.ok) {
      return NextResponse.json(
        { error: `Invalid spintax template: ${check.error}` },
        { status: 400 },
      )
    }
  }

  const { data, error } = await supabaseAdmin()
    .from('campaign_templates')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      name,
      content_type,
      content_text,
      media_url,
      filename,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ template: data }, { status: 201 })
}
