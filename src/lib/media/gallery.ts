import type { MediaMessageLike } from "./message-like";

/**
 * The set of media in a thread that the lightbox can page through, built
 * from the messages the thread already holds (no extra fetch).
 *
 * Only images, videos and GIFs qualify: an audio bubble has nothing to
 * look at, a sticker is too small to page through full-size, and a
 * document is handed to the OS rather than rendered. Rows with no
 * `media_url` are skipped — that's either media Meta refused to verify
 * (`verifyAndBuildUrl` returns null in the webhook) or media whose bytes
 * Meta has since expired, and both render as "unavailable" in the bubble.
 *
 * Generic over any row shape that carries `MediaMessageLike` plus an
 * `id` — both the 1:1 inbox's `Message` and a WhatsApp group's
 * `GroupMessage` qualify, so the 1:1 thread and the group thread share
 * one lightbox instead of two.
 */

export type MediaGalleryKind = "image" | "video" | "gif";

export interface MediaGalleryItem {
  /** The source row's `id` — the lightbox's identity for "which one is open". */
  messageId: string;
  url: string;
  kind: MediaGalleryKind;
  /** Caption, when the sender attached one. */
  caption?: string;
  createdAt: string;
  /** Shown in the lightbox header — "You" for an own message, the
   *  contact's name in a 1:1 thread, or the sender's name in a group. */
  authorLabel: string;
  /** The row itself, so a download can derive its filename. */
  message: MediaMessageLike;
}

function galleryKind(
  contentType: MediaMessageLike["content_type"],
): MediaGalleryKind | null {
  if (contentType === "image") return "image";
  if (contentType === "video") return "video";
  if (contentType === "gif") return "gif";
  return null;
}

/**
 * A row the gallery can be built from. Deliberately more permissive than
 * `MediaMessageLike` on `content_text`/`media_url` — the 1:1 inbox's
 * `Message` leaves them `undefined`, a WhatsApp group's `GroupMessage`
 * (a plain DB row) carries `null` instead, and both need to work here
 * without every caller normalising first.
 */
interface MediaSourceRow {
  id: string;
  content_type: MediaMessageLike["content_type"];
  content_text?: string | null;
  media_url?: string | null;
  created_at: string;
}

/**
 * Viewable media in thread order. Order matters — it's what ← / → walk,
 * and the thread hands messages over already sorted by `created_at`.
 *
 * `resolveAuthorLabel` is the caller's job because "who sent this" means
 * different things per thread: the 1:1 inbox only distinguishes "you" vs
 * the one contact, while a group has to name the actual sender.
 */
export function collectMediaGallery<T extends MediaSourceRow>(
  messages: T[],
  resolveAuthorLabel: (message: T) => string,
): MediaGalleryItem[] {
  const items: MediaGalleryItem[] = [];
  for (const message of messages) {
    const kind = galleryKind(message.content_type);
    if (!kind || !message.media_url) continue;
    items.push({
      messageId: message.id,
      url: message.media_url,
      kind,
      caption: message.content_text || undefined,
      createdAt: message.created_at,
      authorLabel: resolveAuthorLabel(message),
      message: {
        content_type: message.content_type,
        content_text: message.content_text ?? undefined,
        media_url: message.media_url ?? undefined,
        created_at: message.created_at,
      },
    });
  }
  return items;
}

/** Index of a message in the gallery, or -1 when it isn't in it. */
export function galleryIndexOf(
  items: MediaGalleryItem[],
  messageId: string | null,
): number {
  if (!messageId) return -1;
  return items.findIndex((item) => item.messageId === messageId);
}
