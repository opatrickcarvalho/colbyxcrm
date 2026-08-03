import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message'

/**
 * Drain due `whatsapp_scheduled_messages` rows. Meant to be hit on a
 * schedule (Vercel Cron / external pinger) — requires a shared secret
 * via the `x-cron-secret` header to match `AUTOMATION_CRON_SECRET`.
 * Mirrors src/app/api/automations/cron/route.ts: a two-step claim
 * (status pending -> processing) guards against overlapping
 * invocations double-sending the same row.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('whatsapp_scheduled_messages')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  let failed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('whatsapp_scheduled_messages')
      .update({ status: 'processing' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      const result = await sendMessageToConversation(admin, row.account_id as string, {
        conversationId: row.conversation_id as string,
        messageType: row.content_type as string,
        contentText: (row.content_text as string | null) ?? undefined,
        mediaUrl: (row.media_url as string | null) ?? undefined,
        filename: (row.filename as string | null) ?? undefined,
      })

      await admin
        .from('whatsapp_scheduled_messages')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          message_id: result.messageId,
        })
        .eq('id', row.id)
      processed++
    } catch (err) {
      const message =
        err instanceof SendMessageError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Unknown error'
      console.error('[whatsapp/scheduled-messages/cron] send failed:', message)
      await admin
        .from('whatsapp_scheduled_messages')
        .update({ status: 'failed', error_message: message })
        .eq('id', row.id)
      failed++
    }
  }

  return NextResponse.json({ processed, failed })
}
