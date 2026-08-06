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
  isGroup?: boolean;
  fromMe?: boolean;
  messageType?: string;
  text?: string;
  caption?: string;
  /**
   * Usually the message body as a string, but for a button/list tap
   * this is an object — WhatsApp's raw InteractiveResponseMessage,
   * e.g. `{ selectedID: "new", selectedDisplayText: "New customer",
   * contextInfo: {...} }`. See `extractButtonReply` below.
   */
  content?: string | Record<string, unknown>;
  base64?: string;
  base64Data?: string;
  mimetype?: string;
  /** Present on `messages_update` events (delivery/read ticks). */
  status?: string;
}

/**
 * Map uazapi's delivery-status vocabulary (Queued/Sent/Delivered/Read/
 * Failed/Canceled, per the OpenAPI spec's Message.status enum) onto
 * the values the `messages.status` CHECK constraint accepts
 * (migration 001). Unrecognised values return null so the caller can
 * skip the update rather than writing an invalid enum value — the
 * exact bug fixed in the inbound-message path above.
 */
function toMessagesStatus(status: string | undefined): string | null {
  switch ((status || '').toLowerCase()) {
    case 'queued':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
    case 'played':
      return 'read';
    case 'failed':
    case 'canceled':
    case 'cancelled':
      return 'failed';
    default:
      return null;
  }
}

/**
 * uazapi identifies people by JID (`5511999999999@s.whatsapp.net`).
 * Everything downstream — contact matching, the send path — works in
 * E.164, so strip the domain and restore the leading `+`.
 */
function jidToPhone(jid: string | undefined): string | null {
  if (!jid) return null;
  const local = jid.split('@')[0]?.split(':')[0];
  if (!local || !/^\d{7,15}$/.test(local)) return null;
  return `+${local}`;
}

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

/**
 * Detect a button/list tap. uazapi hands back WhatsApp's raw
 * InteractiveResponseMessage in `content` as an object — not a string,
 * not the `choices`-string echo the send-side comment elsewhere in
 * this file used to assume. Falling back to `message.content` as
 * plain text (the old code did, for every non-media message) dumped
 * this whole object — quoted-message context and all — into the
 * chat as a wall of JSON instead of the button title the customer
 * actually tapped.
 */
function extractButtonReply(
  content: string | Record<string, unknown> | undefined
): { id: string; title: string } | null {
  if (!content || typeof content !== 'object') return null;
  const title = content.selectedDisplayText;
  if (typeof title !== 'string' || !title) return null;
  const id = content.selectedID;
  return { id: typeof id === 'string' && id ? id : title, title };
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

  let body: UazapiWebhookBody;
  try {
    body = (await request.json()) as UazapiWebhookBody;
    console.log(
      '[uazapi/webhook] Received payload:',
      JSON.stringify(body, null, 2)
    );
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
  if (event === 'messages_update') {
    for (const message of messagesFrom(body)) {
      try {
        const providerMessageId = message.messageid || message.id || null;
        const mappedStatus = toMessagesStatus(message.status);
        if (!providerMessageId || !mappedStatus) continue;

        // 1) Mirror onto messages. No `.select()`: message_id is not
        // unique across the table (numbers can repeat ids), so this
        // updates 0..N rows — same shape as the Meta webhook's own
        // handleStatusUpdate.
        const { error: msgErr } = await db
          .from('messages')
          .update({ status: mappedStatus })
          .eq('message_id', providerMessageId);
        if (msgErr) {
          console.error(
            '[uazapi/webhook] messages_update: message status update failed:',
            msgErr.message
          );
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
      const phone = jidToPhone(message.chatid ?? message.sender);
      if (!phone) {
        console.warn('[uazapi/webhook] skipping message with unusable sender');
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

      const { error: insertError } = await db.from('messages').insert({
        conversation_id: conversationId,
        sender_type: message.fromMe ? 'agent' : 'customer',
        content_type: contentType,
        content_text: text || null,
        media_url: mediaUrl,
        message_id: providerMessageId,
        status: message.fromMe ? 'sent' : 'delivered',
        interactive_reply_id: interactiveReplyId,
      });

      if (insertError) {
        console.error(
          '[uazapi/webhook] message insert failed:',
          insertError.message
        );
        continue;
      }

      const preview = text || `[${contentType}]`;
      const { data: current } = await db
        .from('conversations')
        .select('unread_count')
        .eq('id', conversationId)
        .maybeSingle();

      await db
        .from('conversations')
        .update({
          last_message_text: preview,
          last_message_at: new Date().toISOString(),
          unread_count: (current?.unread_count ?? 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId);

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
