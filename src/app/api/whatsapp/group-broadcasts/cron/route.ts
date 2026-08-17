import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { createUazapiProvider } from '@/lib/whatsapp/providers/uazapi'
import {
  resolveGroupCredentials,
  GroupsNotAvailableError,
} from '@/lib/whatsapp/providers/uazapi-groups'
import { sendGroupContent, type GroupContentType } from '@/lib/whatsapp/group-broadcast'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { isWithinWindow, type SendWindow } from '@/lib/campaigns/schedule'

/** The campaign fields this route reads, shared by the cache and the guard. */
interface CampaignRow {
  account_id: string
  status: string
  content_type: string
  content_text: string | null
  media_url: string | null
  filename: string | null
  interactive_payload: InteractiveMessagePayload | null
  window_start: string | null
  window_end: string | null
  window_days: number[] | null
  timezone: string | null
}

/**
 * Is the campaign's sending window open right now? A campaign with no
 * window configured is always open — `window_start`/`window_end` are
 * NOT NULL together (migration 052 enforces the pair), so checking one
 * would do; both are read for clarity.
 */
function isCampaignWindowOpen(broadcast: CampaignRow): boolean {
  if (!broadcast.window_start || !broadcast.window_end) return true
  const window: SendWindow = {
    // Postgres TIME round-trips as 'HH:MM:SS'; schedule.ts's parser
    // accepts only 'HH:MM', so the seconds are trimmed here rather than
    // loosening a parser that guards user input elsewhere.
    start: broadcast.window_start.slice(0, 5),
    end: broadcast.window_end.slice(0, 5),
    days: broadcast.window_days ?? [1, 2, 3, 4, 5, 6, 7],
    timeZone: broadcast.timezone || 'America/Sao_Paulo',
  }
  return isWithinWindow(new Date(), window)
}
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message'

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
 *
 * A target is a group, a saved contact, or a hand-typed phone number
 * — exactly one of `group_id` / `contact_id` / `phone` is set (the
 * XOR check in 052_campaigns.sql), and that's what decides which send
 * path a row takes below.
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

  // One fetch per campaign, not per target: a 50-row batch is usually
  // 50 targets of the SAME campaign, and the window check below needs
  // the parent row before anything is claimed.
  const broadcastCache = new Map<string, CampaignRow | null>()
  const loadBroadcast = async (id: string): Promise<CampaignRow | null> => {
    if (broadcastCache.has(id)) return broadcastCache.get(id) ?? null
    const { data } = await admin
      .from('whatsapp_group_broadcasts')
      .select(
        'account_id, status, content_type, content_text, media_url, filename, interactive_payload, window_start, window_end, window_days, timezone'
      )
      .eq('id', id)
      .single()
    const value = (data as CampaignRow | null) ?? null
    broadcastCache.set(id, value)
    return value
  }

  for (const row of due) {
    const kind: 'group' | 'contact' | 'phone' = row.group_id
      ? 'group'
      : row.contact_id
        ? 'contact'
        : 'phone'

    const broadcast = await loadBroadcast(row.broadcast_id as string)

    // The window is checked BEFORE the claim, deliberately. Claiming
    // first and reverting to 'pending' on a closed window leaves a hole:
    // if the process dies between those two writes the row is stranded
    // in 'processing', which the drain query never selects again — it
    // would neither send nor fail, just silently vanish. Skipping before
    // the claim costs one cached read and has no such state.
    //
    // Re-checking at all (on top of the precomputed `send_at`) matters
    // because planSendTimes() bakes in the window as it existed at
    // creation time; an operator can narrow or move it afterwards, and
    // targets already staggered into the old window have no way to know.
    // It applies to every recipient kind — the window is a property of
    // the campaign, not of how a given target happens to be addressed.
    // A paused campaign leaves its pending targets exactly as they are
    // — pause/resume operate on the campaign row only, not per-target,
    // so this is the one gate that keeps a paused campaign from having
    // any of them claimed while resume (which re-plans send_at for
    // what's still pending) hasn't run yet.
    if (broadcast && broadcast.status === 'paused') continue

    if (broadcast && !isCampaignWindowOpen(broadcast)) continue

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
      if (!broadcast) {
        await fail('Parent broadcast no longer exists')
        continue
      }

      if (kind === 'group') {
        // Defense in depth — the API route already rejects an
        // interactive campaign that has any group target, so this
        // should be unreachable. sendGroupContent()'s payload type
        // excludes 'interactive' entirely (WhatsApp doesn't support
        // buttons in group chats), so this must be caught before that
        // call, not left to a type error at runtime.
        if (broadcast.content_type === 'interactive') {
          await fail('Interactive campaigns cannot target groups')
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
          content_type: broadcast.content_type as Exclude<GroupContentType, 'interactive'>,
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
      } else {
        // contact_id or phone: find-or-create the conversation, then
        // send through the same core the dashboard composer and the
        // public API use — this persists the message + updates the
        // conversation on its own, so (unlike the group branch above)
        // there is no separate feed table to mirror into here.
        const messageText =
          (row.rendered_text as string | null) ?? (broadcast.content_text as string | null)

        let conversationId: string
        if (kind === 'contact') {
          const { data: contact } = await admin
            .from('contacts')
            .select('phone, name')
            .eq('id', row.contact_id)
            .eq('account_id', broadcast.account_id)
            .maybeSingle()
          if (!contact) {
            await fail('Target contact no longer exists')
            continue
          }
          const resolvedConv = await resolveConversationByPhone(
            admin,
            broadcast.account_id as string,
            contact.phone as string,
            contact.name as string | null
          )
          conversationId = resolvedConv.conversationId
        } else {
          const resolvedConv = await resolveConversationByPhone(
            admin,
            broadcast.account_id as string,
            row.phone as string
          )
          conversationId = resolvedConv.conversationId
        }

        const result = await sendMessageToConversation(admin, broadcast.account_id as string, {
          conversationId,
          messageType: broadcast.content_type as string,
          contentText: messageText,
          mediaUrl: broadcast.media_url as string | null,
          filename: broadcast.filename as string | null,
          interactivePayload: broadcast.interactive_payload,
        })

        await admin
          .from('whatsapp_group_broadcast_targets')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            provider_message_id: result.whatsappMessageId,
            error_message: null,
          })
          .eq('id', row.id)
      }

      await admin.rpc('bump_whatsapp_group_broadcast_counters', {
        p_broadcast_id: row.broadcast_id,
        p_success: true,
      })
      processed++
    } catch (err) {
      const message =
        err instanceof GroupsNotAvailableError
          ? err.message
          : err instanceof SendMessageError
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
