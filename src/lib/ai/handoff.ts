import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
}): string {
  const { messages, replyCount } = args

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim())

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`

  const base = `🤖 AI agent handed off ${replies}.`

  if (!lastCustomer) return base

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN)
  return `${base} Last customer message: “${quote}”`
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}

/**
 * Tell a human the bot handed off — without this, a handoff to the
 * shared queue (no `handoffAgentId` configured) only sets
 * `ai_autoreply_disabled` on the conversation. Nothing else changes, so
 * nothing draws anyone's attention to it; an agent only discovers it by
 * happening to open that exact thread. Best-effort and never throws,
 * same discipline as `logAiUsage` — a notification failure must not
 * affect the handoff itself, which has already happened by the time
 * this runs.
 *
 * - `handoffAgentId` set → that agent already owns the thread (the
 *   caller just assigned it); notify only them.
 * - `handoffAgentId` null (shared queue) → nobody owns it, so notify
 *   every account member who can actually pick up a conversation
 *   (agent/admin/owner) — a silent handoff nobody sees defeats the
 *   point of handing off at all.
 */
export async function notifyAiHandoff(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    handoffAgentId: string | null
    summary: string
  },
): Promise<void> {
  const { accountId, conversationId, contactId, handoffAgentId, summary } = args
  try {
    let recipientIds: string[]
    if (handoffAgentId) {
      recipientIds = [handoffAgentId]
    } else {
      const { data: members } = await db
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .in('account_role', ['agent', 'admin', 'owner'])
      recipientIds = (members ?? []).map((m) => m.user_id as string)
    }
    if (recipientIds.length === 0) return

    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    const contactName =
      (contact?.name as string | null)?.trim() || (contact?.phone as string | null) || 'a contact'

    const rows = recipientIds.map((userId) => ({
      account_id: accountId,
      user_id: userId,
      type: 'ai_handoff' as const,
      conversation_id: conversationId,
      contact_id: contactId,
      title: `AI needs help with ${contactName}`,
      body: summary,
    }))
    const { error } = await db.from('notifications').insert(rows)
    if (error) {
      console.error('[ai handoff] notification insert failed:', error)
    }
  } catch (err) {
    console.error('[ai handoff] notification threw:', err)
  }
}
