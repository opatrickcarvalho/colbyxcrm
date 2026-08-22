import { describe, it, expect } from "vitest";
import type { ContentType, Message, SenderType } from "@/types";
import { collectMediaGallery, galleryIndexOf } from "./gallery";

function msg(
  id: string,
  content_type: ContentType,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    conversation_id: "conv-1",
    sender_type: (overrides.sender_type ?? "customer") as SenderType,
    content_type,
    status: "delivered",
    created_at: "2026-08-04T10:00:00.000Z",
    ...overrides,
  };
}

/** Same resolver every 1:1-thread call site uses in practice. */
function authorLabel(message: Message): string {
  return message.sender_type === "customer" ? "Customer" : "You";
}

describe("collectMediaGallery", () => {
  it("keeps images and videos in thread order and nothing else", () => {
    const items = collectMediaGallery(
      [
        msg("t1", "text", { content_text: "hi" }),
        msg("i1", "image", { media_url: "/api/whatsapp/media/1" }),
        msg("a1", "audio", { media_url: "/api/whatsapp/media/2" }),
        msg("v1", "video", { media_url: "/api/whatsapp/media/3" }),
        msg("d1", "document", { media_url: "/api/whatsapp/media/4" }),
        msg("i2", "image", { media_url: "https://x.supabase.co/photo.png" }),
      ],
      authorLabel,
    );

    expect(items.map((i) => i.messageId)).toEqual(["i1", "v1", "i2"]);
    expect(items.map((i) => i.kind)).toEqual(["image", "video", "image"]);
  });

  it("includes gifs but not stickers", () => {
    const items = collectMediaGallery(
      [
        msg("g1", "gif", { media_url: "https://x.supabase.co/loop.mp4" }),
        msg("s1", "sticker", { media_url: "https://x.supabase.co/sticker.webp" }),
      ],
      authorLabel,
    );
    expect(items.map((i) => i.messageId)).toEqual(["g1"]);
    expect(items[0].kind).toBe("gif");
  });

  it("skips media whose bytes we have no URL for", () => {
    // Meta refusing to verify the id (webhook's verifyAndBuildUrl → null) or
    // expiring it later both land here — the bubble shows "unavailable", so
    // the viewer must not offer a blank frame to page onto.
    const items = collectMediaGallery(
      [
        msg("i1", "image"),
        msg("i2", "image", { media_url: "" }),
        msg("i3", "image", { media_url: "/api/whatsapp/media/9" }),
      ],
      authorLabel,
    );
    expect(items.map((i) => i.messageId)).toEqual(["i3"]);
  });

  it("carries the caption, author label and the row itself", () => {
    const [item] = collectMediaGallery(
      [
        msg("i1", "image", {
          media_url: "/api/whatsapp/media/1",
          content_text: "the receipt",
          sender_type: "agent",
        }),
      ],
      authorLabel,
    );

    expect(item.caption).toBe("the receipt");
    expect(item.authorLabel).toBe("You");
    expect(item.message).toEqual(
      expect.objectContaining({ media_url: "/api/whatsapp/media/1" }),
    );
  });

  it("treats an empty caption as no caption", () => {
    const [item] = collectMediaGallery(
      [msg("i1", "image", { media_url: "/api/whatsapp/media/1", content_text: "" })],
      authorLabel,
    );
    expect(item.caption).toBeUndefined();
  });

  it("lets the caller resolve a group sender's name instead of you/customer", () => {
    const [item] = collectMediaGallery(
      [
        msg("i1", "image", {
          media_url: "/api/whatsapp/media/1",
          sender_type: "customer",
        }),
      ],
      () => "Maria",
    );
    expect(item.authorLabel).toBe("Maria");
  });

  it("returns nothing for a thread with no media", () => {
    expect(collectMediaGallery([msg("t1", "text")], authorLabel)).toEqual([]);
    expect(collectMediaGallery([], authorLabel)).toEqual([]);
  });
});

describe("galleryIndexOf", () => {
  const items = collectMediaGallery(
    [
      msg("i1", "image", { media_url: "/api/whatsapp/media/1" }),
      msg("i2", "image", { media_url: "/api/whatsapp/media/2" }),
    ],
    authorLabel,
  );

  it("finds the open item", () => {
    expect(galleryIndexOf(items, "i2")).toBe(1);
  });

  it("reports -1 for null, so a closed viewer stays closed", () => {
    expect(galleryIndexOf(items, null)).toBe(-1);
  });

  it("reports -1 once the message is gone from the thread", () => {
    // Happens when an optimistic `temp-…` bubble is swapped for its real row
    // while the viewer is open — the viewer closes rather than mis-pointing.
    expect(galleryIndexOf(items, "temp-123")).toBe(-1);
  });
});
