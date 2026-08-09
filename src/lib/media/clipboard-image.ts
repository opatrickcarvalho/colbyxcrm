import { extensionForMime } from './filename';

/**
 * Helpers for turning a pasted clipboard image (a screenshot, usually)
 * into a file the `chat-media` bucket and WhatsApp will both accept.
 *
 * Two things make a raw clipboard image awkward to upload as-is:
 *
 *   1. It has no useful name — browsers hand it over as `image.png`, so
 *      every paste in a thread would carry the same name.
 *   2. Print-screen captures are full-desktop PNGs and routinely blow
 *      past Meta's 5 MB image cap, even though the same picture is a few
 *      hundred KB as JPEG.
 */

/**
 * Image MIME types the `chat-media` bucket accepts (migration 023) —
 * mirrors the composer's image picker `accept` list. Anything else has to
 * be rejected before upload, or Storage fails with an opaque error.
 */
export const PASTEABLE_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export function isPasteableImage(type: string): boolean {
  return (PASTEABLE_IMAGE_TYPES as readonly string[]).includes(type);
}

/**
 * Timestamped name for a pasted capture, e.g. `screenshot-1738958400000.png`.
 * The stamp is what keeps two pastes in one thread apart once they're
 * saved by the recipient (`buildMediaPath` adds its own for the storage key).
 */
export function clipboardImageName(
  type: string,
  now: number = Date.now()
): string {
  return `screenshot-${now}.${extensionForMime(type)}`;
}

/**
 * Re-encode passes tried in order when a capture is over the limit:
 * quality first (a screenshot stays perfectly readable as a high-quality
 * JPEG), and only then downscaling, which blurs small UI text and is the
 * last thing you want to do to a screenshot.
 */
const SHRINK_ATTEMPTS: ReadonlyArray<{ scale: number; quality: number }> = [
  { scale: 1, quality: 0.85 },
  { scale: 1, quality: 0.6 },
  { scale: 0.7, quality: 0.7 },
  { scale: 0.5, quality: 0.7 },
];

function encodeJpeg(
  bitmap: ImageBitmap,
  scale: number,
  quality: number
): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality)
  );
}

/**
 * Bring an oversized image under `maxBytes` by re-encoding it as JPEG.
 * Browser-only (uses canvas). Returns the original file when it already
 * fits, when the browser can't decode it, or when even the last pass is
 * still too big — the caller's own size check then rejects it with a
 * message the user can act on.
 */
export async function shrinkImageToFit(
  file: File,
  maxBytes: number
): Promise<File> {
  if (file.size <= maxBytes) return file;
  if (typeof createImageBitmap !== 'function') return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    for (const { scale, quality } of SHRINK_ATTEMPTS) {
      const blob = await encodeJpeg(bitmap, scale, quality);
      if (blob && blob.size <= maxBytes) {
        return new File([blob], clipboardImageName('image/jpeg'), {
          type: 'image/jpeg',
        });
      }
    }
  } catch {
    // Fall through — the original file is still a valid (if oversized)
    // result, and the caller reports the size problem.
  } finally {
    bitmap.close();
  }

  return file;
}
