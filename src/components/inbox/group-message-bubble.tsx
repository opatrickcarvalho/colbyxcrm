'use client';

import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { MediaMessageLike } from '@/lib/media/message-like';
import {
  MediaAudioBubble,
  MediaDocumentBubble,
  MediaImageBubble,
  MediaUnavailable,
  MediaVideoBubble,
} from './message-media';
import type { GroupMessage } from './group-thread';

/**
 * A group chat message, styled and behaving like the 1:1 inbox's
 * `<MessageBubble>` (same media players, same lightbox hookup) — the
 * whole point of this file existing is that the group thread stops
 * hand-rolling its own `<img>`/`<audio controls>` and drifting away
 * from whatever the 1:1 side gets next.
 *
 * What it deliberately does NOT carry over: reply/quote and reactions.
 * `whatsapp_group_messages` (migration 043) has no columns for either —
 * adding them is a real schema decision, not a rendering one, so it's
 * out of scope here.
 */

/** Adapts a `GroupMessage` row's nullable DB columns to the shape the
 *  shared media bubbles expect (see `MediaMessageLike`'s doc comment). */
function toMediaMessage(message: GroupMessage): MediaMessageLike {
  return {
    content_type: message.content_type,
    // A document's filename lives in its own column here (unlike the
    // 1:1 inbox, where the composer folds it into content_text) — the
    // media bubbles only ever read one field, so fold it in the same
    // way at this boundary.
    content_text: message.content_text || message.filename || undefined,
    media_url: message.media_url ?? undefined,
    created_at: message.created_at,
  };
}

/** Deterministic per-sender color so the same person's initials always
 *  land on the same hue across the thread — same idea as WhatsApp's own
 *  per-participant name colors in a group. */
function senderColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 60% 42%)`;
}

function SenderAvatar({ label }: { label: string }) {
  const initial = (label.trim().charAt(0) || '?').toUpperCase();
  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
      style={{ backgroundColor: senderColor(label) }}
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}

export function GroupMessageBubble({
  message,
  senderLabel,
  onOpenMedia,
  onFirstAudioPlay,
}: {
  message: GroupMessage;
  /** Already resolved by the caller — "You" for outbound, the sender's
   *  name/phone/jid for inbound. */
  senderLabel: string;
  /** Opens the thread's media lightbox on this message. Omitted for
   *  audio/document, which have nothing to page through visually. */
  onOpenMedia?: () => void;
  /** Fires once, the first time an inbound voice note is played — the
   *  hook for sending WhatsApp's "played" receipt for it. */
  onFirstAudioPlay?: () => void;
}) {
  const t = useTranslations('Inbox.bubble');
  const isOwn = message.direction === 'outbound';
  const time = format(new Date(message.created_at), 'HH:mm');
  const mediaMessage = toMediaMessage(message);

  return (
    <div
      className={cn(
        'flex min-w-0 items-end gap-2',
        isOwn ? 'flex-row-reverse' : 'flex-row'
      )}
    >
      {!isOwn && <SenderAvatar label={senderLabel} />}
      {/* `min-w-0` is load-bearing here too — see message-actions.tsx
          (issue #165) for the long-unbroken-word bug this prevents. */}
      <div
        className={cn(
          'flex min-w-0 max-w-[75%] flex-col',
          isOwn ? 'items-end' : 'items-start'
        )}
      >
        {!isOwn && (
          <span className="text-muted-foreground mb-0.5 px-1 text-xs font-medium">
            {senderLabel}
          </span>
        )}
        <div
          className={cn(
            'relative rounded-2xl px-3 py-2',
            isOwn
              ? 'bg-primary text-primary-foreground rounded-br-md'
              : 'bg-muted text-foreground rounded-bl-md'
          )}
        >
          {message.content_type === 'text' ? (
            <p className="text-sm break-words [overflow-wrap:anywhere] whitespace-pre-wrap">
              {message.content_text}
            </p>
          ) : !message.media_url ? (
            <MediaUnavailable
              label={t(
                message.content_type === 'image'
                  ? 'photo'
                  : message.content_type === 'video'
                    ? 'video'
                    : message.content_type === 'audio'
                      ? 'audio'
                      : 'document'
              )}
              t={t}
            />
          ) : (
            <div>
              {message.content_type === 'image' ? (
                <MediaImageBubble
                  message={mediaMessage}
                  onOpen={onOpenMedia}
                  t={t}
                />
              ) : message.content_type === 'video' ? (
                <MediaVideoBubble
                  message={mediaMessage}
                  onOpen={onOpenMedia}
                  t={t}
                />
              ) : message.content_type === 'audio' ? (
                <MediaAudioBubble
                  message={mediaMessage}
                  t={t}
                  onFirstPlay={onFirstAudioPlay}
                />
              ) : (
                <MediaDocumentBubble message={mediaMessage} t={t} />
              )}
              {(message.content_type === 'image' ||
                message.content_type === 'video') &&
                message.content_text && (
                  <p className="mt-1 text-sm break-words [overflow-wrap:anywhere] whitespace-pre-wrap">
                    {message.content_text}
                  </p>
                )}
            </div>
          )}
          <div
            className={cn(
              'mt-1 flex items-center gap-1',
              isOwn ? 'justify-end' : 'justify-start'
            )}
          >
            <span
              className={cn(
                'text-[10px]',
                isOwn
                  ? 'text-primary-foreground/70'
                  : 'text-muted-foreground'
              )}
            >
              {time}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
