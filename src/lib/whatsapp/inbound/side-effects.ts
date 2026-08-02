// ============================================================
// What happens after an inbound message is stored.
//
// Persisting the message is the easy half. The half that makes the CRM
// a CRM — advancing a Flow run, firing automation triggers, letting the
// AI assistant reply, marking a broadcast as replied, emitting
// `message.received` to the customer's own webhooks — used to live
// inline in the Meta webhook route, which meant it only ever ran for
// Meta. A UAZAPI message landed in the inbox and then nothing else
// happened.
//
// This module is that second half, lifted out and given a
// provider-neutral signature. Both webhooks call it with their own
// already-resolved ids, so a message behaves the same way regardless of
// which backend carried it.
//
// The ordering here is load-bearing and is preserved exactly as the
// Meta path had it:
//
//   1. broadcast reply flag  — before anything can fail
//   2. Flows                 — awaited, because whether the runner
//                              *consumed* the message decides which
//                              automation triggers may fire
//   3. automations           — content-level triggers suppressed when a
//                              flow consumed; relationship-level ones
//                              fire regardless
//   4. AI auto-reply         — only for plain text no flow consumed
//   5. message.received      — public-API webhook fan-out
//
// Everything is awaited rather than fire-and-forget. These run inside a
// route's `after()` block, which only keeps the function alive for
// promises it can see; a detached promise can be frozen part-way
// through, which is exactly the failure mode issues #301 and #409
// reported (a run logged with zero steps executed).
// ============================================================

import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { supabaseAdmin } from '@/lib/flows/admin-client';

/**
 * If this contact was a recent broadcast recipient, mark the reply so
 * the broadcast's `replied_count` advances (via the aggregate trigger
 * from migration 003).
 *
 * Account-scoped, so a reply in a shared inbox counts no matter which
 * teammate sent the original. Swallows its own errors — a bookkeeping
 * miss must never cost us the rest of the inbound pipeline.
 */
export async function flagBroadcastReplyIfAny(
  accountId: string,
  contactId: string
) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !recs || recs.length === 0) return;

    const row = recs[0];
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr);
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err);
  }
}

export interface InboundSideEffectParams {
  accountId: string;
  /**
   * Sender-of-record for inserts needing a NOT NULL user_id FK. Always
   * the member who saved the WhatsApp config; arbitrary post-017 but
   * stable.
   */
  configOwnerUserId: string;
  contactId: string;
  conversationId: string;
  /** The backend's own message id (Meta wamid, UAZAPI messageid). */
  providerMessageId: string;
  /** As stored on `messages.content_type`. */
  contentType: string;
  /** Body text, or the caption for media. */
  contentText: string;
  /**
   * Set only when the customer tapped a reply button or list row. Its
   * presence changes three things: the Flow runner gets an
   * `interactive_reply` instead of a text message, the
   * `interactive_reply` automation trigger fires, and the AI assistant
   * stays out of it (a tap is navigation, not a question).
   */
  interactiveReplyId?: string | null;
  /** First message this contact has ever sent us. */
  isFirstInboundMessage: boolean;
  /** True when this inbound is what created the contact row. */
  contactWasCreated: boolean;
}

/**
 * Run every downstream effect of an inbound message. Never throws — each
 * stage owns its own error handling, because a webhook that 500s just
 * gets the same payload redelivered.
 */
export async function runInboundSideEffects(
  params: InboundSideEffectParams
): Promise<void> {
  const {
    accountId,
    configOwnerUserId,
    contactId,
    conversationId,
    providerMessageId,
    contentType,
    contentText,
    interactiveReplyId,
    isFirstInboundMessage,
    contactWasCreated,
  } = params;

  await flagBroadcastReplyIfAny(accountId, contactId);

  // Awaited, not fire-and-forget: `consumed` decides whether the
  // content-level automation triggers below are allowed to fire. When
  // an account has no active flows the runner early-exits on one
  // indexed SELECT, so this is close to free.
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId,
    conversationId,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText,
          meta_message_id: providerMessageId,
        }
      : {
          kind: 'text',
          text: contentText,
          meta_message_id: providerMessageId,
        },
    isFirstInboundMessage,
  });
  const flowConsumed = flowResult.consumed;

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = [];

  // A consumed message means the customer is navigating a bot menu, not
  // sending a fresh trigger word that should fork into automations.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) automationTriggers.push('interactive_reply');
  }

  // Relationship-level triggers are about WHO is messaging, not what
  // they said, so they fire even when a flow consumed the message.
  // Both are dispatched (rather than one canonical choice) so an
  // automation can listen to whichever semantic it wants; a contact
  // added by CSV import that then messages for the first time hits
  // `first_inbound_message` but not `new_contact_created`.
  if (contactWasCreated) automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage)
    automationTriggers.unshift('first_inbound_message');

  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId,
      context: {
        message_text: contentText,
        conversation_id: conversationId,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err));
  }

  // Flows win over the LLM: the assistant only speaks for plain text the
  // deterministic runner declined. `dispatchInboundToAiReply` owns its
  // own eligibility gates (account opt-in, per-conversation cap, the
  // sticky disable flag) and never throws.
  if (!flowConsumed && !interactiveReplyId && contentText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId,
      contactId,
      configOwnerUserId,
    });
  }

  // Public-API fan-out. Early-exits when the account has no matching
  // endpoint, and never throws.
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversationId,
    contact_id: contactId,
    whatsapp_message_id: providerMessageId,
    content_type: contentType,
    text: contentText,
  });
}
