import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { runInboundSideEffects } from '@/lib/whatsapp/inbound/side-effects';
import { isValidStatusTransition } from '@/lib/whatsapp/status-ladder';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import {
  createUazapiProvider,
  fetchChatAvatar,
} from '@/lib/whatsapp/providers/uazapi';
import { decrypt } from '@/lib/whatsapp/encryption';
import { extractButtonReply } from '@/lib/whatsapp/providers/uazapi-inbound';
import { jidToPhone } from '@/lib/whatsapp/phone-utils';

/**
 * POST /api/whatsapp/uazapi/webhook/[secret]
 *
 * Inbound events from UAZAPI.
 *
 * Authentication is the secret in the path, and that is not a
 * shortcut — uazapi signs nothing. The Meta webhook next door verifies
 * an HMAC-SHA256 over the raw body (lib/whatsapp/webhook-signature);
 * there is no equivalent here, so the unguessable URL is the only
 * thing standing between a stranger and someone's inbox. It is 32
 * random bytes, minted per account (migration 038 puts a unique index
 * on the column), and it is looked up with the service-role client
 * because there is no user session on this path.
 *
 * Why a separate route instead of teaching the Meta webhook a second
 * dialect: the envelopes have nothing in common (`entry[].changes[]`
 * versus `{event, instance, data}`), Meta needs a GET verification
 * handshake and a raw-body read for its signature, and uazapi needs
 * neither. Translating one into the other would mean maintaining a
 * second, invisible schema.
 */

interface UazapiWebhookBody {
  event?: string;
  EventType?: string;
  instance?: string | { id?: string };
  data?: unknown;
  message?: unknown;
}

interface UazapiMessage {
  id?: string;
  messageid?: string;
  chatid?: string;
  sender?: string;
  senderName?: string;
  /**
   * uazapi's resolved phone-number JID for the sender, present when the
   * chat is LID-addressed (`sender`/`chatid` come back as `…@lid`).
   * Only identifies the remote party on an INBOUND message — on
   * `fromMe` it is the connected number itself.
   */
  sender_pn?: string;
  /** The original `…@lid` sender address, when uazapi resolved one. */
  sender_lid?: string;
  isGroup?: boolean;
  fromMe?: boolean;
  messageType?: string;
  text?: string;
  caption?: string;
  /**
   * Usually the message body as a string, but for a button/list tap
   * this is an object — WhatsApp's raw reply envelope, e.g.
   * `{ selectedButtonID: "btn_1", Response: { SelectedDisplayText:
   * "Resposta 01" }, contextInfo: {...} }`. The casing varies between
   * payloads; `extractButtonReply` in lib/whatsapp/providers/
   * uazapi-inbound.ts is what makes sense of it.
   */
  content?: string | Record<string, unknown>;
  base64?: string;
  base64Data?: string;
  mimetype?: string;
  /** Present on `messages_update` events (delivery/read ticks). */
  status?: string | number;
  /**
   * When WhatsApp says the message was sent. Documented as milliseconds
   * in uazapi's OpenAPI spec, but the underlying Baileys frame carries
   * seconds and some deployments pass it straight through — hence the
   * magnitude sniff in {@link toCreatedAt} rather than a blind `* 1000`.
   */
  messageTimestamp?: number | string;
  /** Provider id of the message this one quotes, for swipe replies. */
  quoted?: string;
  /** Baileys format fallback */
  key?: { id?: string };
  update?: { status?: string | number };
}

/**
 * The message's own timestamp as an ISO string, or null to let the
 * column default to now().
 *
 * Storing this matters because the thread is ordered by `created_at`.
 * Without it every message was stamped at the moment our webhook
 * happened to process it, so a retried delivery or an out-of-order batch
 * reordered the conversation. The Meta webhook has always stored the
 * provider's timestamp; this path just never did.
 */
function toCreatedAt(raw: number | string | undefined): string | null {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!n || !Number.isFinite(n) || n <= 0) return null;
  // Seconds-vs-milliseconds: anything below ~1e11 is a seconds epoch
  // (1e11 ms is year 1973, 1e11 s is year 5138 — no real message lands
  // between them), so scale those up.
  const ms = n < 1e11 ? n * 1000 : n;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  // A timestamp far in the future is a malformed payload, not a
  // message — better to fall back to now() than to pin a row to 2087
  // where it would sit at the top of every thread forever.
  if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;
  return date.toISOString();
}

/**
 * Map uazapi's delivery-status vocabulary (Queued/Sent/Delivered/Read/
 * Failed/Canceled, per the OpenAPI spec's Message.status enum) onto
 * the values the `messages.status` CHECK constraint accepts
 * (migration 001). Unrecognised values return null so the caller can
 * skip the update rather than writing an invalid enum value — the
 * exact bug fixed in the inbound-message path above.
 */
function toMessagesStatus(status: string | number | undefined): string | null {
  const s = String(status || '').toLowerCase();
  switch (s) {
    case 'queued':
    case 'pending':
    case '1':
      return 'sending';
    case 'sent':
    case 'server_ack':
    case '2':
      return 'sent';
    case 'delivered':
    case 'delivery_ack':
    case '3':
      return 'delivered';
    case 'read':
    case 'played':
    case 'read_ack':
    case '4':
    case '5':
      return 'read';
    case 'failed':
    case 'canceled':
    case 'cancelled':
    case 'error':
    case '0':
      return 'failed';
    default:
      return null;
  }
}

// jidToPhone lives in @/lib/whatsapp/phone-utils — shared with the
// contact-extraction path, which needs the exact same PN-vs-LID rules.

/**
 * Map uazapi's message types onto the `content_type` values the
 * messages table already accepts (migrations 001 + 010). Anything
 * unrecognised is stored as text so an exotic type still shows up in
 * the thread rather than vanishing.
 */
function toContentType(messageType: string | undefined): string {
  switch ((messageType || '').toLowerCase()) {
    case 'image':
    case 'imagemessage':
    case 'sticker':
    case 'stickermessage':
      // Stickers are webp images on the wire (uazapi's own send-media
      // enum lists `sticker` as a distinct type, but the download/
      // upload path only cares that it's an image). Reusing 'image'
      // means isMedia below and extFromMime's existing image/webp
      // entry both pick it up with no further changes.
      return 'image';
    case 'video':
    case 'videomessage':
      return 'video';
    case 'audio':
    case 'ptt':
    case 'audiomessage':
      return 'audio';
    case 'document':
    case 'documentmessage':
      return 'document';
    default:
      return 'text';
  }
}

function messagesFrom(body: UazapiWebhookBody): UazapiMessage[] {
  const raw = body.data ?? body.message;
  if (Array.isArray(raw)) return raw as UazapiMessage[];
  if (raw && typeof raw === 'object') return [raw as UazapiMessage];
  return [];
}

/**
 * File extension for a resolved mime type, falling back to a
 * reasonable default per content_type when the mime is unrecognised
 * (audio in particular must not default to `mp3` — voice notes come
 * back as `audio/ogg`, and forcing an mp3 extension on ogg bytes is
 * why some players refused to open the file).
 */
function extFromMime(mime: string, contentType: string): string {
  const base = mime.split(';')[0]?.trim().toLowerCase();
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/amr': 'amr',
    'application/pdf': 'pdf',
  };
  if (base && known[base]) return known[base];
  const guessed = base?.split('/')[1];
  if (guessed) return guessed;
  if (contentType === 'image') return 'jpg';
  if (contentType === 'video') return 'mp4';
  if (contentType === 'audio') return 'ogg';
  return 'bin';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ secret: string }> }
) {
  const { secret } = await params;

  // Cheap shape check before touching the database, so a scan for
  // `/webhook/test` costs a string comparison rather than a query.
  if (!secret || secret.length < 32) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const db = supabaseAdmin();

  const { data: config } = await db
    .from('whatsapp_config')
    // user_id is the sender-of-record the downstream inserts need for
    // their NOT NULL FKs — same role it plays on the Meta path.
    // uazapi_host/uazapi_instance_token are needed to resolve inbound
    // media via /message/download (see the media-handling block below).
    .select(
      'id, account_id, user_id, provider, status, uazapi_host, uazapi_instance_token'
    )
    .eq('webhook_secret', secret)
    .maybeSingle();

  if (!config || config.provider !== 'uazapi') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Suspended accounts get no further inbound processing — the RLS
  // layer (is_account_member, migration 040) would reject every write
  // anyway once this reaches contacts/conversations/messages. Still
  // 200 — uazapi retries on non-2xx, and a retry can't fix a
  // suspension.
  const { data: acct } = await db
    .from('accounts')
    .select('status')
    .eq('id', config.account_id)
    .maybeSingle();
  if (acct?.status === 'suspended') {
    return NextResponse.json({ ok: true, ignored: 'account_suspended' });
  }
  // DO NOT extend the condition above to cover unpaid accounts.
  //
  // Suspension is an operator action against abuse — stopping cold is
  // the point. Non-payment is a billing state, and dropping inbound
  // messages for it destroys customer data permanently: WhatsApp does
  // not replay, and there is no backfill. A tenant who lapses for a
  // week and then pays must find that week's conversations waiting.
  //
  // The billing gate lives further down, inside
  // `runInboundSideEffects`, where it stops only the flows,
  // automations and AI replies — never the persistence above it.
  // The two checks look similar and are deliberately not the same
  // check. See src/lib/whatsapp/inbound/side-effects.ts.

  let body: UazapiWebhookBody;
  try {
    body = (await request.json()) as UazapiWebhookBody;
    // Never log the whole envelope in production: it carries customers'
    // message text in the clear, and this fires on every event. The Meta
    // webhook next door logs nothing of the sort. Locally the full dump
    // is genuinely useful — uazapi's payload shapes are under-documented
    // and this is how most of them were discovered.
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        '[uazapi/webhook] Received payload:',
        JSON.stringify(body, null, 2)
      );
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const event = (body.event || body.EventType || '').toLowerCase();

  // Pairing replays up to seven days of chat through this event. We
  // deliberately drop it: importing would create hundreds of contacts
  // and conversations at once and fire flows, automations and AI
  // auto-replies against every one of them. The webhook is registered
  // without `history` in its event list too — this is the belt to that
  // pair of braces, since the registration can be edited on uazapi's
  // dashboard.
  if (event === 'history') {
    return NextResponse.json({ ok: true, ignored: 'history' });
  }

  if (event === 'connection') {
    const status = (body.data as { status?: string } | undefined)?.status;
    if (status && status !== config.status) {
      await db
        .from('whatsapp_config')
        .update({
          status,
          connected_at:
            status === 'connected' ? new Date().toISOString() : undefined,
          updated_at: new Date().toISOString(),
        })
        .eq('id', config.id);
    }
    return NextResponse.json({ ok: true });
  }

  // Delivery/read ticks for messages we sent. `registerWebhook()`
  // (providers/uazapi.ts) subscribes to this event; without this
  // branch it fell into the generic "ignored" bucket below and
  // messages.status never advanced past 'sent'.
  if (event === 'messages_update' || event === 'messages.update') {
    for (const message of messagesFrom(body)) {
      try {
        const providerMessageId =
          message.messageid || message.id || message.key?.id || null;
        const rawStatus = message.status ?? message.update?.status;
        const mappedStatus = toMessagesStatus(rawStatus);
        if (!providerMessageId || !mappedStatus) continue;

        // 1) Mirror onto messages, timestamped and ladder-guarded per
        // row — message_id is not unique across the table (numbers
        // can repeat ids), so this can touch 0..N rows, same shape as
        // the Meta webhook's own handleStatusUpdate. The per-row fetch
        // (vs. a blind update) is what lets us stamp sent_at/
        // delivered_at/read_at without regressing an already-later
        // timestamp on a re-delivered or out-of-order webhook.
        const { data: msgRows, error: msgFetchErr } = await db
          .from('messages')
          .select('id, status')
          .eq('message_id', providerMessageId);
        if (msgFetchErr) {
          console.error(
            '[uazapi/webhook] messages_update: message fetch failed:',
            msgFetchErr.message
          );
        } else {
          const tsIso = new Date().toISOString();
          for (const row of msgRows ?? []) {
            if (!isValidStatusTransition(row.status, mappedStatus)) continue;
            const update: Record<string, unknown> = { status: mappedStatus };
            if (mappedStatus === 'sent') update.sent_at = tsIso;
            if (mappedStatus === 'delivered') update.delivered_at = tsIso;
            if (mappedStatus === 'read') update.read_at = tsIso;
            const { error: msgErr } = await db
              .from('messages')
              .update(update)
              .eq('id', row.id);
            if (msgErr) {
              console.error(
                '[uazapi/webhook] messages_update: message status update failed:',
                msgErr.message
              );
            }
          }
        }

        // 2) Mirror onto broadcast_recipients, forward-only on the
        // ladder — a UAZAPI-connected account can still run
        // broadcasts (broadcast-core.ts sends through whichever
        // provider is configured), so its recipients need the same
        // status mirror Meta's path already gets.
        const { data: recipient, error: recFetchErr } = await db
          .from('broadcast_recipients')
          .select('id, status')
          .eq('whatsapp_message_id', providerMessageId)
          .maybeSingle();

        if (recFetchErr) {
          console.error(
            '[uazapi/webhook] messages_update: broadcast recipient fetch failed:',
            recFetchErr.message
          );
        } else if (
          recipient &&
          isValidStatusTransition(recipient.status, mappedStatus)
        ) {
          const tsIso = new Date().toISOString();
          const update: Record<string, unknown> = { status: mappedStatus };
          if (mappedStatus === 'sent') update.sent_at = tsIso;
          if (mappedStatus === 'delivered') update.delivered_at = tsIso;
          if (mappedStatus === 'read') update.read_at = tsIso;

          const { error: recUpdateErr } = await db
            .from('broadcast_recipients')
            .update(update)
            .eq('id', recipient.id);
          if (recUpdateErr) {
            console.error(
              '[uazapi/webhook] messages_update: broadcast recipient update failed:',
              recUpdateErr.message
            );
          }
        }

        // 3) Webhook fan-out, for parity with the Meta path's public
        // API. Bounded to one row purely to resolve the owning
        // conversation/account.
        const { data: msgRow } = await db
          .from('messages')
          .select('conversation_id')
          .eq('message_id', providerMessageId)
          .limit(1)
          .maybeSingle();
        if (msgRow) {
          await dispatchWebhookEvent(
            db,
            config.account_id,
            'message.status_updated',
            {
              whatsapp_message_id: providerMessageId,
              conversation_id: msgRow.conversation_id,
              status: mappedStatus,
            }
          );
        }
      } catch (err) {
        console.error(
          '[uazapi/webhook] failed to process a messages_update entry:',
          err instanceof Error ? err.message : err
        );
      }
    }
    return NextResponse.json({ ok: true });
  }

  // Contact online/last-seen — best-effort. uazapi's OpenAPI spec lists
  // `presence` as a subscribable event but documents no payload shape
  // for it, so this parses defensively (a handful of plausible field
  // names) and silently ignores anything it doesn't recognise rather
  // than throwing. Most numbers also hide last-seen from a non-contact
  // at the WhatsApp privacy-settings level, so a lot of contacts will
  // simply never populate these columns — that's expected, not a bug.
  if (event === 'presence') {
    try {
      const raw = (body.data ?? {}) as Record<string, unknown>;
      const chatId = String(
        raw.chatid ?? raw.ChatID ?? raw.id ?? raw.from ?? raw.Sender ?? ''
      );
      const phone = jidToPhone(chatId);
      const stateRaw = String(
        raw.state ?? raw.presence ?? raw.status ?? ''
      ).toLowerCase();
      const presenceStatus =
        stateRaw === 'available'
          ? 'available'
          : stateRaw === 'unavailable'
            ? 'unavailable'
            : null;

      if (phone && presenceStatus) {
        const nowIso = new Date().toISOString();
        const update: Record<string, unknown> = {
          presence_status: presenceStatus,
          presence_updated_at: nowIso,
        };
        // Going offline is the closest thing to a "last seen" moment
        // uazapi gives us; only that transition advances the column.
        if (presenceStatus === 'unavailable') {
          update.last_seen_at = nowIso;
        }
        const { error: presenceErr } = await db
          .from('contacts')
          .update(update)
          .eq('account_id', config.account_id)
          .eq('phone', phone);
        if (presenceErr) {
          console.error(
            '[uazapi/webhook] presence: contact update failed:',
            presenceErr.message
          );
        }
      }
    } catch (err) {
      console.error(
        '[uazapi/webhook] failed to process a presence entry:',
        err instanceof Error ? err.message : err
      );
    }
    return NextResponse.json({ ok: true });
  }

  // WhatsApp Business label lifecycle at the instance level (created /
  // renamed / recolored / deleted on the phone or via the CRM's own
  // editLabel() call). Mirrors into `whatsapp_labels` — the CRM's
  // "conversation label" IS this table, not a parallel construct (see
  // migration 048's doc comment).
  if (event === 'labels') {
    try {
      const raw = (body.data ?? {}) as Record<string, unknown>;
      const uazapiLabelId = String(raw.labelid ?? raw.id ?? '');
      if (uazapiLabelId) {
        if (raw.delete === true) {
          const { error: delErr } = await db
            .from('whatsapp_labels')
            .delete()
            .eq('account_id', config.account_id)
            .eq('uazapi_label_id', uazapiLabelId);
          if (delErr) {
            console.error(
              '[uazapi/webhook] labels: delete failed:',
              delErr.message
            );
          }
        } else {
          const name = typeof raw.name === 'string' ? raw.name : null;
          const color = Number(raw.color);
          if (name && Number.isFinite(color)) {
            const { error: upsertErr } = await db
              .from('whatsapp_labels')
              .upsert(
                {
                  account_id: config.account_id,
                  uazapi_label_id: uazapiLabelId,
                  name,
                  color_code: color,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: 'account_id,uazapi_label_id' }
              );
            if (upsertErr) {
              console.error(
                '[uazapi/webhook] labels: upsert failed:',
                upsertErr.message
              );
            }
          }
        }
      }
    } catch (err) {
      console.error(
        '[uazapi/webhook] failed to process a labels entry:',
        err instanceof Error ? err.message : err
      );
    }
    return NextResponse.json({ ok: true });
  }

  // A chat's label SET changed (labels applied/removed on the phone,
  // or reconciling our own setChatLabels() call). `wa_label` is the
  // authoritative full list for the chat, so this replaces —
  // deliberately not a lookup-and-create: a label event on a chat this
  // CRM has never seen a conversation for is not a reason to invent one.
  if (event === 'chat_labels') {
    try {
      const raw = (body.data ?? {}) as Record<string, unknown>;
      const chatId = String(raw.chatid ?? raw.id ?? raw.JID ?? '');
      const phone = jidToPhone(chatId);
      const waLabelIds = Array.isArray(raw.wa_label)
        ? raw.wa_label.filter((v): v is string => typeof v === 'string')
        : [];

      if (phone) {
        const { data: contact } = await db
          .from('contacts')
          .select('id')
          .eq('account_id', config.account_id)
          .eq('phone', phone)
          .maybeSingle();

        // `maybeSingle()` would ERROR — not return null — the moment a
        // contact has two conversations, and the error was discarded, so
        // the whole event vanished with no log. A contact can genuinely
        // have more than one row here (an archived thread plus a live
        // one), so take the most recent and move on.
        let conversation: { id: string } | null = null;
        if (contact) {
          const { data: rows, error: convErr } = await db
            .from('conversations')
            .select('id')
            .eq('contact_id', contact.id)
            .order('last_message_at', { ascending: false, nullsFirst: false })
            .limit(1);
          if (convErr) {
            console.error(
              '[uazapi/webhook] chat_labels: conversation lookup failed:',
              convErr.message
            );
          }
          conversation = rows?.[0] ?? null;
        }

        if (conversation && contact) {
          const contactId = contact.id;
          const { data: localLabels } = await db
            .from('whatsapp_labels')
            .select('id, uazapi_label_id')
            .eq('account_id', config.account_id)
            .in('uazapi_label_id', waLabelIds.length > 0 ? waLabelIds : ['']);

          const targetIds = (localLabels ?? []).map((l) => l.id as string);

          // `wa_label` is the authoritative full set for the chat, so
          // anything not in it is pruned. Built with the array overload
          // rather than by pasting ids into a PostgREST filter string —
          // the hand-rolled `("''")` sentinel for the empty case was one
          // quoting rule away from silently matching nothing.
          const prune = db
            .from('conversation_whatsapp_labels')
            .delete()
            .eq('conversation_id', conversation.id);
          const { error: delErr } = await (targetIds.length > 0
            ? prune.not('whatsapp_label_id', 'in', `(${targetIds.join(',')})`)
            : prune);
          if (delErr) {
            console.error(
              '[uazapi/webhook] chat_labels: prune failed:',
              delErr.message
            );
          }

          if (targetIds.length > 0) {
            const { error: insErr } = await db
              .from('conversation_whatsapp_labels')
              .upsert(
                targetIds.map((whatsapp_label_id) => ({
                  conversation_id: conversation.id,
                  whatsapp_label_id,
                })),
                { onConflict: 'conversation_id,whatsapp_label_id' }
              );
            if (insErr) {
              console.error(
                '[uazapi/webhook] chat_labels: insert failed:',
                insErr.message
              );
            }
          }

          // Reverse half of the Kanban stage<->label link (migration
          // 055; forward half is POST /api/deals/[id]/move). A
          // stage-linked label just became part of this chat's set —
          // follow it by moving the matching open deal. `targetIds`
          // are already whatsapp_labels rows scoped to
          // config.account_id (the query above filters on it), so any
          // pipeline_stages row matching one of them is automatically
          // account-scoped too — no extra join needed. Ambiguous
          // matches (a pipeline with 2+ linked stages simultaneously
          // labeled, or a contact with 0/2+ open deals in that
          // pipeline) are skipped and logged, never guessed — same
          // "don't invent state" rule as the rest of this handler.
          try {
            if (targetIds.length > 0) {
              const { data: matchedStages } = await db
                .from('pipeline_stages')
                .select('id, pipeline_id')
                .in('whatsapp_label_id', targetIds);

              const stagesByPipeline = new Map<string, string[]>();
              for (const s of matchedStages ?? []) {
                const list = stagesByPipeline.get(s.pipeline_id) ?? [];
                list.push(s.id);
                stagesByPipeline.set(s.pipeline_id, list);
              }

              for (const [pipelineId, stageIds] of stagesByPipeline) {
                if (stageIds.length !== 1) {
                  console.warn(
                    '[uazapi/webhook] chat_labels: ambiguous stage match, skipping',
                    { pipelineId, count: stageIds.length }
                  );
                  continue;
                }
                const targetStageId = stageIds[0];

                const { data: openDeals, error: dealsErr } = await db
                  .from('deals')
                  .select('id, stage_id')
                  .eq('account_id', config.account_id)
                  .eq('pipeline_id', pipelineId)
                  .eq('contact_id', contactId)
                  .eq('status', 'open');
                if (dealsErr) {
                  console.error(
                    '[uazapi/webhook] chat_labels: deal lookup failed:',
                    dealsErr.message
                  );
                  continue;
                }
                if (!openDeals || openDeals.length !== 1) {
                  continue; // 0 or 2+ open deals in this pipeline — ambiguous
                }
                const deal = openDeals[0];
                if (deal.stage_id === targetStageId) continue;

                const { error: moveErr } = await db
                  .from('deals')
                  .update({ stage_id: targetStageId })
                  .eq('id', deal.id);
                if (moveErr) {
                  console.error(
                    '[uazapi/webhook] chat_labels: deal move failed:',
                    moveErr.message
                  );
                }
              }
            }
          } catch (err) {
            console.error(
              '[uazapi/webhook] chat_labels: reverse stage sync failed:',
              err instanceof Error ? err.message : err
            );
          }
        }
      }
    } catch (err) {
      console.error(
        '[uazapi/webhook] failed to process a chat_labels entry:',
        err instanceof Error ? err.message : err
      );
    }
    return NextResponse.json({ ok: true });
  }

  // Group metadata/membership changes (participant count, name, topic,
  // announce/locked toggles). Mirrors the group into `whatsapp_groups`
  // by (account_id, group_jid) — creates the row if the group exists
  // on WhatsApp but wasn't created through this CRM (e.g. made
  // directly from a phone), updates it otherwise. This is what keeps
  // the groups admin screen's capacity bar live without polling
  // `/group/info` on every render.
  if (event === 'groups') {
    const raw = (body.data ?? {}) as Record<string, unknown>;
    const groupJid = String(raw.JID ?? raw.jid ?? '');
    if (!groupJid) {
      return NextResponse.json({ ok: true, ignored: 'groups_no_jid' });
    }

    const participants = (raw.Participants ??
      raw.participants ??
      []) as unknown[];
    const name = (raw.Name as string) || (raw.name as string) || null;
    const description =
      (raw.Topic as string) || (raw.description as string) || null;
    const isAnnounce = Boolean(raw.IsAnnounce ?? raw.isAnnounce ?? false);
    const isLocked = Boolean(raw.IsLocked ?? raw.isLocked ?? false);

    const update: Record<string, unknown> = {
      participant_count: participants.length,
      is_announce: isAnnounce,
      is_locked: isLocked,
      updated_at: new Date().toISOString(),
    };
    if (name) update.name = name;
    if (description !== null) update.description = description;

    const { data: existingGroup } = await db
      .from('whatsapp_groups')
      .select('id')
      .eq('account_id', config.account_id)
      .eq('group_jid', groupJid)
      .maybeSingle();

    if (existingGroup) {
      const { error: groupUpdateErr } = await db
        .from('whatsapp_groups')
        .update(update)
        .eq('id', existingGroup.id);
      if (groupUpdateErr) {
        console.error(
          '[uazapi/webhook] groups: update failed:',
          groupUpdateErr.message
        );
      }
    } else if (name) {
      // Only auto-create when we at least have a name — a bare
      // membership delta with no name shouldn't spawn a half-empty row.
      const { error: groupInsertErr } = await db
        .from('whatsapp_groups')
        .insert({
          account_id: config.account_id,
          whatsapp_config_id: config.id,
          group_jid: groupJid,
          name,
          description,
          participant_count: participants.length,
          is_announce: isAnnounce,
          is_locked: isLocked,
        });
      if (groupInsertErr) {
        console.error(
          '[uazapi/webhook] groups: insert failed:',
          groupInsertErr.message
        );
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (event !== 'messages' && event !== 'message') {
    return NextResponse.json({ ok: true, ignored: event });
  }

  for (const message of messagesFrom(body)) {
    try {
      // UAZAPI is registered with excludeMessages: ['wasSentByApi'], but
      // if that filter is edited away, API sends will echo back here.
      // We will deduplicate them below instead of blindly ignoring all `fromMe` messages,
      // so that messages sent natively from the phone app are captured in the CRM.

      // Group chats have no single contact to attribute a message to —
      // they get their own activity feed instead (whatsapp_group_messages,
      // migration 043), decoupled from the contact-centric
      // conversations/messages model (assignment, unread counts,
      // automations/flows/AI auto-reply all assume one customer, which a
      // group with hundreds of senders doesn't fit). Only groups already
      // tracked locally (created/synced through this CRM) get their
      // messages stored; a message from an untracked group is ignored.
      if (message.isGroup) {
        const groupJid = message.chatid;
        if (!groupJid) continue;

        const { data: localGroup } = await db
          .from('whatsapp_groups')
          .select('id')
          .eq('account_id', config.account_id)
          .eq('group_jid', groupJid)
          .maybeSingle();
        if (!localGroup) continue;

        const groupProviderMessageId = message.messageid || message.id || null;

        // Our own compose route (POST /api/whatsapp/groups/[id]/messages)
        // already inserts the outbound row on send; this dedupes the
        // webhook echo of that same send (or a native phone-app send
        // that happens to arrive as fromMe) by provider message id.
        if (message.fromMe && groupProviderMessageId) {
          const { data: existingGroupMsg } = await db
            .from('whatsapp_group_messages')
            .select('id')
            .eq('group_id', localGroup.id)
            .eq('provider_message_id', groupProviderMessageId)
            .maybeSingle();
          if (existingGroupMsg) continue;
        }

        const groupContentType = toContentType(message.messageType);
        const isGroupMedia = ['image', 'video', 'audio', 'document'].includes(
          groupContentType
        );
        const groupText = isGroupMedia
          ? message.caption || ''
          : message.text ||
            message.caption ||
            (typeof message.content === 'string' ? message.content : '') ||
            '';

        let groupMediaUrl: string | null = null;
        if (isGroupMedia) {
          try {
            let buffer: Buffer;
            let mime: string;
            let b64Str = message.base64 || message.base64Data || null;
            if (b64Str) {
              if (b64Str.includes('base64,')) {
                b64Str = b64Str.split('base64,')[1];
              }
              buffer = Buffer.from(b64Str, 'base64');
              mime = message.mimetype || 'application/octet-stream';
            } else if (
              groupProviderMessageId &&
              config.uazapi_host &&
              config.uazapi_instance_token
            ) {
              const provider = createUazapiProvider({
                host: config.uazapi_host,
                token: decrypt(config.uazapi_instance_token),
              });
              const resolved = await provider.fetchInboundMedia(
                groupProviderMessageId
              );
              buffer = resolved.buffer;
              mime = resolved.contentType;
            } else {
              throw new Error(
                'group media message has neither inline bytes nor a message id to download'
              );
            }

            const ext = extFromMime(mime, groupContentType);
            const path = `account-${config.account_id}/group-${Date.now()}-uazapi.${ext}`;
            const { error: groupUpErr } = await db.storage
              .from('chat-media')
              .upload(path, buffer, { contentType: mime });
            if (groupUpErr) {
              console.error(
                '[uazapi/webhook] group: failed to upload media:',
                groupUpErr.message
              );
            } else {
              const { data: publicUrlData } = db.storage
                .from('chat-media')
                .getPublicUrl(path);
              groupMediaUrl = publicUrlData.publicUrl;
            }
          } catch (err) {
            console.error(
              '[uazapi/webhook] failed to resolve group inbound media:',
              err instanceof Error ? err.message : err
            );
          }
        }

        const { error: groupMsgErr } = await db
          .from('whatsapp_group_messages')
          .insert({
            account_id: config.account_id,
            group_id: localGroup.id,
            direction: message.fromMe ? 'outbound' : 'inbound',
            sender_jid: message.sender ?? null,
            sender_phone: jidToPhone(message.sender),
            sender_name: message.senderName ?? null,
            content_type: groupContentType,
            content_text: groupText || null,
            media_url: groupMediaUrl,
            provider_message_id: groupProviderMessageId,
          });
        if (groupMsgErr) {
          console.error(
            '[uazapi/webhook] group: failed to insert message:',
            groupMsgErr.message
          );
        }
        continue;
      }

      // In 1-on-1 chats, chatid is always the remote contact's JID.
      // UAZAPI sometimes populates `sender` with the instance's own JID on inbound messages.
      //
      // When the chat is LID-addressed, neither yields a phone (see
      // jidToPhone) — fall back to uazapi's own resolved PN. That field
      // identifies the OTHER party only on an inbound message; on a
      // `fromMe` event it is our own number, which would file the
      // message under a "contact" that is really the operator.
      const phone =
        jidToPhone(message.chatid ?? message.sender) ??
        (message.fromMe ? null : jidToPhone(message.sender_pn));
      if (!phone) {
        // Deliberately skipped rather than resolved to the LID's digits:
        // a phantom contact corrupts the inbox far worse than a dropped
        // message, and it is silent — this at least leaves a trace.
        console.warn(
          '[uazapi/webhook] skipping message with no resolvable phone number (LID-only chat?):',
          message.chatid ?? message.sender
        );
        continue;
      }

      const { conversationId, contactId, contactCreated, avatarUrl } =
        await resolveConversationByPhone(
          db,
          config.account_id,
          phone,
          // `senderName` on a `fromMe` event is the connected WhatsApp
          // account's OWN profile push-name (uazapi reports it
          // regardless of direction) — resolveConversationByPhone uses
          // this to name a NEW contact and to RENAME an existing one,
          // so trusting it here would save/overwrite the contact with
          // the agent's own name on every message sent natively from
          // the phone, until the next real inbound reply corrected it.
          // Only a genuine inbound message's senderName identifies the
          // other party.
          message.fromMe ? null : (message.senderName ?? null)
        );

      // Best-effort profile-photo backfill. uazapi never rides this
      // along on the message payload — `Chat.image` only comes back
      // from a dedicated `/chat/details` call — so only pay for it
      // once, on whichever message first arrives for a contact that
      // doesn't have one on file yet. Failure here must never break
      // message processing, hence the isolated try/catch.
      if (!avatarUrl && config.uazapi_host && config.uazapi_instance_token) {
        try {
          const fetchedAvatarUrl = await fetchChatAvatar(
            config.uazapi_host,
            decrypt(config.uazapi_instance_token),
            phone
          );
          if (fetchedAvatarUrl) {
            await db
              .from('contacts')
              .update({ avatar_url: fetchedAvatarUrl })
              .eq('id', contactId);
          }
        } catch (err) {
          console.error(
            '[uazapi/webhook] failed to backfill profile picture:',
            err instanceof Error ? err.message : err
          );
        }
      }

      // "First ever inbound from this contact" has to be counted BEFORE
      // the insert below, or the message we are about to store would
      // count itself and the trigger would never fire. Existing contacts
      // matter here too — someone added by CSV import can still be
      // sending for the first time.
      const { count: priorInboundCount } = await db
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer');
      const isFirstInboundMessage = (priorInboundCount ?? 0) === 0;

      const buttonReply = extractButtonReply(message.content);
      // A tap on a button/list we sent takes priority over messageType —
      // uazapi doesn't give this its own messageType (it still reports
      // whatever the underlying transport frame is), the shape of
      // `content` is what actually identifies it.
      const contentType = buttonReply
        ? 'interactive'
        : toContentType(message.messageType);
      const isMedia = ['image', 'video', 'audio', 'document'].includes(
        contentType
      );
      // `content` on a media message is WhatsApp's own (often
      // JSON-shaped) media envelope — a `.enc` CDN URL plus the
      // decryption key, not text a human should ever see. Falling back
      // to it here was the "giant link" bug: nothing downstream could
      // render that string usefully, so it got stored as message text
      // verbatim. Only a real caption belongs in a media message's text.
      // Same reasoning for a button reply: show the tapped title, never
      // the raw response object (`content` is only ever a plain string
      // here for an ordinary text message — see extractButtonReply).
      const text = isMedia
        ? message.caption || ''
        : buttonReply
          ? buttonReply.title
          : message.text ||
            message.caption ||
            (typeof message.content === 'string' ? message.content : '') ||
            '';
      const interactiveReplyId = buttonReply?.id ?? null;
      const providerMessageId = message.messageid || message.id || null;
      let mediaUrl: string | null = null;

      if (isMedia) {
        try {
          let buffer: Buffer;
          let mime: string;

          // Some uazapi deployments do send the bytes inline; prefer
          // that fast path when present.
          let b64Str = message.base64 || message.base64Data || null;
          if (b64Str) {
            if (b64Str.includes('base64,')) {
              b64Str = b64Str.split('base64,')[1];
            }
            buffer = Buffer.from(b64Str, 'base64');
            mime = message.mimetype || 'application/octet-stream';
          } else if (providerMessageId) {
            // The common case: no inline bytes, just the encrypted
            // envelope above. uazapi's own /message/download endpoint
            // does the decryption server-side and hands back a
            // fetchable URL — this is the same call the outbound
            // media-proxy route uses, wrapped by the provider adapter.
            if (!config.uazapi_host || !config.uazapi_instance_token) {
              throw new Error(
                'uazapi host/instance token missing on config row'
              );
            }
            const provider = createUazapiProvider({
              host: config.uazapi_host,
              token: decrypt(config.uazapi_instance_token),
            });
            const resolved =
              await provider.fetchInboundMedia(providerMessageId);
            buffer = resolved.buffer;
            mime = resolved.contentType;
          } else {
            throw new Error(
              'media message has neither inline bytes nor a message id to download'
            );
          }

          const ext = extFromMime(mime, contentType);
          const path = `account-${config.account_id}/${Date.now()}-uazapi.${ext}`;

          const { error: upErr } = await db.storage
            .from('chat-media')
            .upload(path, buffer, {
              contentType: mime,
            });

          if (upErr) {
            console.error(
              '[uazapi/webhook] Failed to upload media:',
              upErr.message
            );
          } else {
            const { data: publicUrlData } = db.storage
              .from('chat-media')
              .getPublicUrl(path);
            mediaUrl = publicUrlData.publicUrl;
          }
        } catch (err) {
          // No media_url and an empty/caption-only text is a message
          // the UI shows as "unavailable" rather than a broken giant
          // link — a strict improvement over the old failure mode even
          // when the download itself fails (bad token, expired link).
          console.error(
            '[uazapi/webhook] failed to resolve inbound media:',
            err instanceof Error ? err.message : err
          );
        }
      }

      if (message.fromMe && providerMessageId) {
        const { data: existing } = await db
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('message_id', providerMessageId)
          .maybeSingle();

        if (existing) {
          // This message was already inserted when sent via the CRM API.
          continue;
        }
      }

      // Swipe-reply context. Same treatment as the Meta path: the quote
      // is resolved to OUR row id, scoped to this conversation so a
      // quoted id from elsewhere cannot link across threads. A parent we
      // never stored is fine — the message renders without the quote
      // rather than being dropped.
      let replyToInternalId: string | null = null;
      if (message.quoted) {
        const { data: parent } = await db
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('message_id', message.quoted)
          .maybeSingle();
        replyToInternalId = parent?.id ?? null;
      }

      const createdAt = toCreatedAt(message.messageTimestamp);

      const { error: insertError } = await db.from('messages').insert({
        conversation_id: conversationId,
        sender_type: message.fromMe ? 'agent' : 'customer',
        content_type: contentType,
        content_text: text || null,
        media_url: mediaUrl,
        message_id: providerMessageId,
        status: message.fromMe ? 'sent' : 'delivered',
        interactive_reply_id: interactiveReplyId,
        reply_to_message_id: replyToInternalId,
        // An inbound message that yields neither text nor a recognised
        // button reply is, in practice, always a reply envelope this
        // parser has not seen yet — and it arrives in the thread blank,
        // with nothing left to diagnose it from. Keeping the raw object
        // makes the next occurrence self-describing instead of
        // unreproducible. Narrow on purpose: a message that parsed fine
        // stores nothing extra.
        ...(!message.fromMe &&
        !buttonReply &&
        !text &&
        message.content &&
        typeof message.content === 'object'
          ? { interactive_payload: message.content }
          : {}),
        // Omitted entirely when unparseable, so the column default wins.
        ...(createdAt ? { created_at: createdAt } : {}),
      });

      if (insertError) {
        console.error(
          '[uazapi/webhook] message insert failed:',
          insertError.message
        );
        continue;
      }

      // The conversation summary advances in BOTH directions — a message
      // sent from the operator's phone is still the last thing said.
      //
      // The unread bump does not. It is only correct for a message from
      // the customer. The Meta webhook can increment unconditionally
      // because Meta never echoes our own sends back; uazapi does, so
      // copying that shape here meant every message sent from the phone
      // marked its own conversation unread. That is the false unread dot
      // — it was treated in the UI once, but this is where it came from.
      const preview = text || `[${contentType}]`;
      const summary: Record<string, unknown> = {
        last_message_text: preview,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Also the snapshot the re-open check needs: read once here rather
      // than a second time inside the side effects. `status` is still the
      // pre-message value — inserting a message does not change it.
      let priorStatus: string | null = null;
      if (!message.fromMe) {
        const { data: current } = await db
          .from('conversations')
          .select('unread_count, status')
          .eq('id', conversationId)
          .maybeSingle();
        summary.unread_count = (current?.unread_count ?? 0) + 1;
        priorStatus = (current?.status as string | null) ?? null;
      }

      await db.from('conversations').update(summary).eq('id', conversationId);

      // The half that makes this a CRM rather than a message log:
      // Flows, automations, AI auto-reply, broadcast reply tracking and
      // the public-API `message.received` event. Shared verbatim with
      // the Meta webhook so an inbound behaves identically on both
      // providers.
      // Note: We only run these side-effects for true inbound messages from contacts.
      if (!message.fromMe) {
        await runInboundSideEffects({
          accountId: config.account_id,
          configOwnerUserId: config.user_id,
          contactId,
          conversationId,
          conversationStatus: priorStatus,
          providerMessageId: providerMessageId ?? '',
          contentType,
          contentText: text,
          interactiveReplyId,
          isFirstInboundMessage,
          contactWasCreated: contactCreated,
        });
      }
    } catch (err) {
      // One malformed message must not cost us the rest of the batch.
      console.error(
        '[uazapi/webhook] failed to process a message:',
        err instanceof Error ? err.message : err
      );
    }
  }

  // Always 200 once the secret checked out. uazapi retries on non-2xx,
  // and a retry cannot fix a bug on our side — it just replays the
  // same failure.
  return NextResponse.json({ ok: true });
}
