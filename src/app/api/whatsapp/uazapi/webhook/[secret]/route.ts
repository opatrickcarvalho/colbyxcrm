import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { runInboundSideEffects } from '@/lib/whatsapp/inbound/side-effects';

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
  content?: string;
  base64?: string;
  base64Data?: string;
  mimetype?: string;
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
    .select('id, account_id, user_id, provider, status')
    .eq('webhook_secret', secret)
    .maybeSingle();

  if (!config || config.provider !== 'uazapi') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: UazapiWebhookBody;
  try {
    body = (await request.json()) as UazapiWebhookBody;
    console.log('[uazapi/webhook] Received payload:', JSON.stringify(body, null, 2));
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

  if (event !== 'messages' && event !== 'message') {
    return NextResponse.json({ ok: true, ignored: event });
  }

  for (const message of messagesFrom(body)) {
    try {
      // UAZAPI is registered with excludeMessages: ['wasSentByApi'], but 
      // if that filter is edited away, API sends will echo back here.
      // We will deduplicate them below instead of blindly ignoring all `fromMe` messages,
      // so that messages sent natively from the phone app are captured in the CRM.
      
      // Group chats have no single contact to attribute a message to,
      // and the CRM's data model is one conversation per contact.
      if (message.isGroup) continue;

      // In 1-on-1 chats, chatid is always the remote contact's JID.
      // UAZAPI sometimes populates `sender` with the instance's own JID on inbound messages.
      const phone = jidToPhone(message.chatid ?? message.sender);
      if (!phone) {
        console.warn('[uazapi/webhook] skipping message with unusable sender');
        continue;
      }

      const { conversationId, contactId, contactCreated } =
        await resolveConversationByPhone(
          db,
          config.account_id,
          phone,
          message.senderName ?? null
        );

      // "First ever inbound from this contact" has to be counted BEFORE
      // the insert below, or the message we are about to store would
      // count itself and the trigger would never fire. Existing contacts
      // matter here too — someone added by CSV import can still be
      // sending for the first time.
      const { count: priorInboundCount } = await db
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'contact');
      const isFirstInboundMessage = (priorInboundCount ?? 0) === 0;

      const contentType = toContentType(message.messageType);
      let text = message.text || message.caption || message.content || '';
      const providerMessageId = message.messageid || message.id || null;
      let mediaUrl = null;

      const isMedia = ['image', 'video', 'audio', 'document'].includes(contentType);
      
      // Some versions/providers put the base64 in .base64 or .base64Data.
      // If it's a huge base64 string mistakenly put in .content (which causes the "huge broken link" bug), catch it too.
      let b64Str = message.base64 || message.base64Data || (isMedia && typeof message.content === 'string' && message.content.length > 500 ? message.content : null);

      if (isMedia && b64Str) {
        if (b64Str.includes('base64,')) {
          b64Str = b64Str.split('base64,')[1];
        }

        try {
          const buffer = Buffer.from(b64Str, 'base64');
          const ext = contentType === 'image' ? 'jpg' : contentType === 'video' ? 'mp4' : contentType === 'audio' ? 'mp3' : 'bin';
          const path = `account-${config.account_id}/${Date.now()}-uazapi.${ext}`;
          
          const mime = message.mimetype || (contentType === 'image' ? 'image/jpeg' : 'application/octet-stream');
          
          const { error: upErr } = await db.storage.from('chat-media').upload(path, buffer, {
            contentType: mime
          });
          
          if (upErr) {
            console.error('[uazapi/webhook] Failed to upload media:', upErr.message);
          } else {
            const { data: publicUrlData } = db.storage.from('chat-media').getPublicUrl(path);
            mediaUrl = publicUrlData.publicUrl;
            
            // Clean up text if it was used to hold the base64 string
            if (text === message.content) {
              text = message.caption || '';
            }
          }
        } catch (err) {
          console.error('[uazapi/webhook] Error processing base64 media:', err);
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
        sender_type: message.fromMe ? 'agent' : 'contact',
        content_type: contentType,
        content_text: text || null,
        media_url: mediaUrl,
        message_id: providerMessageId,
        status: message.fromMe ? 'sent' : 'received',
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
          // UAZAPI delivers button/list taps as ordinary text (the choice
          // ids ride in the `choices` string we sent, and the reply comes
          // back as its title). Until that round-trip is decoded there is
          // no reply id to pass, so taps behave as text here.
          interactiveReplyId: null,
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
