import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { createUazapiProvider } from '@/lib/whatsapp/providers/uazapi'
import {
  resolveGroupCredentials,
  GroupsNotAvailableError,
} from '@/lib/whatsapp/providers/uazapi-groups'
import { sendGroupContent, type GroupContentType } from '@/lib/whatsapp/group-broadcast'

/**
 * Drain due `whatsapp_group_broadcast_targets` rows. Meant to be hit
 * on a schedule (same external pinger as the other cron-drained
 * endpoints) — requires the shared secret via `x-cron-secret` to
 * match `AUTOMATION_CRON_SECRET`. Mirrors
 * src/app/api/whatsapp/scheduled-messages/cron/route.ts: a two-step
 * claim (status pending -> processing) guards against overlapping
 * invocations double-sending the same row. Pacing between sends comes
 * from each target's pre-staggered `send_at` (set at campaign
 * creation), not from anything in this loop — this route just drains
 * whatever is due.
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
    .from('whatsapp_group_broadcast_targets')
    .select('*')
    .eq('status', 'pending')
    .lte('send_at', new Date().toISOString())
    .order('send_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  let failed = 0
  const touchedBroadcastIds = new Set<string>()

  for (const row of due) {
    const { data: claim } = await admin
      .from('whatsapp_group_broadcast_targets')
      .update({ status: 'processing' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    touchedBroadcastIds.add(row.broadcast_id as string)
    // First target claimed for this campaign flips it from "pending"
    // (not started) to "sending" (in flight); a no-op once it's
    // already sending.
    await admin
      .from('whatsapp_group_broadcasts')
      .update({ status: 'sending' })
      .eq('id', row.broadcast_id)
      .eq('status', 'pending')

    const fail = async (message: string) => {
      console.error('[whatsapp/group-broadcasts/cron] send failed:', message)
      await admin
        .from('whatsapp_group_broadcast_targets')
        .update({ status: 'failed', error_message: message })
        .eq('id', row.id)
      await admin.rpc('bump_whatsapp_group_broadcast_counters', {
        p_broadcast_id: row.broadcast_id,
        p_success: false,
      })
      failed++
    }

    try {
      const { data: broadcast } = await admin
        .from('whatsapp_group_broadcasts')
        .select('account_id, content_type, content_text, media_url, filename')
        .eq('id', row.broadcast_id)
        .single()
      if (!broadcast) {
        await fail('Parent broadcast no longer exists')
        continue
      }

      const { data: group } = await admin
        .from('whatsapp_groups')
        .select('group_jid, account_id')
        .eq('id', row.group_id)
        .single()
      if (!group) {
        await fail('Target group no longer exists')
        continue
      }

      const creds = await resolveGroupCredentials(admin, broadcast.account_id as string)
      const provider = createUazapiProvider({ host: creds.host, token: creds.token })

      const result = await sendGroupContent(provider, group.group_jid as string, {
        content_type: broadcast.content_type as GroupContentType,
        content_text: broadcast.content_text as string | null,
        media_url: broadcast.media_url as string | null,
        filename: broadcast.filename as string | null,
      })

      await admin
        .from('whatsapp_group_broadcast_targets')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          provider_message_id: result.messageId,
          error_message: null,
        })
        .eq('id', row.id)

      // Mirror into the group's normal message feed so the campaign
      // shows up in the same thread a human sending from the group
      // chat would see — same table POST /groups/[id]/messages writes.
      await admin.from('whatsapp_group_messages').insert({
        account_id: broadcast.account_id,
        group_id: row.group_id,
        direction: 'outbound',
        content_type: broadcast.content_type,
        content_text: broadcast.content_text,
        media_url: broadcast.media_url,
        filename: broadcast.filename,
        provider_message_id: result.messageId,
      })

      await admin.rpc('bump_whatsapp_group_broadcast_counters', {
        p_broadcast_id: row.broadcast_id,
        p_success: true,
      })
      processed++
    } catch (err) {
      const message =
        err instanceof GroupsNotAvailableError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Unknown error'
      await fail(message)
    }
  }

  // Close out any campaign whose targets are all in a terminal state.
  for (const broadcastId of touchedBroadcastIds) {
    const { count: remaining } = await admin
      .from('whatsapp_group_broadcast_targets')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .in('status', ['pending', 'processing'])
    if (remaining && remaining > 0) continue

    const { data: counts } = await admin
      .from('whatsapp_group_broadcasts')
      .select('sent_count')
      .eq('id', broadcastId)
      .single()

    await admin
      .from('whatsapp_group_broadcasts')
      .update({ status: (counts?.sent_count ?? 0) > 0 ? 'sent' : 'failed' })
      .eq('id', broadcastId)
      .eq('status', 'sending')
  }

  return NextResponse.json({ processed, failed })
}
