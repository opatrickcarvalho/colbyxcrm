import type { Message } from "@/types";

/**
 * The minimal message shape the media renderers/downloader/filename
 * helper actually need. Both the 1:1 inbox's `Message` and a WhatsApp
 * group's `GroupMessage` (`components/inbox/group-thread.tsx`) satisfy
 * it once a caller normalises the group row's nullable DB columns to
 * `undefined` at the boundary — which is what lets `<MediaImageBubble>`,
 * `<MediaAudioBubble>` etc. and the lightbox/download code be used by
 * both threads instead of being hand-rolled twice and drifting apart
 * (exactly what had happened: the group thread's own plain
 * `<img>`/`<audio controls>` never got the caption fix, the WhatsApp-style
 * audio player, or the lightbox the 1:1 inbox has).
 */
export type MediaMessageLike = Pick<
  Message,
  "content_type" | "content_text" | "media_url" | "created_at"
>;
