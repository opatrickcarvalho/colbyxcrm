// ============================================================
// Inline embed resolution for type='embed' bio-page links.
//
// v1 supports YouTube and Spotify only — the two platforms explicitly
// scoped for launch. Anything else returns null so the public page
// (src/app/b/[slug]/page.tsx) falls back to rendering a plain link
// card instead of a broken iframe.
// ============================================================

const YOUTUBE_WATCH = /(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/)([\w-]{11})/;
const YOUTUBE_SHORT = /youtu\.be\/([\w-]{11})/;
const SPOTIFY = /open\.spotify\.com\/(track|album|playlist|episode|show|artist)\/([\w]+)/;

/** Turn a YouTube/Spotify URL into an iframe `src`, or null if unrecognized. */
export function resolveEmbedUrl(url: string): string | null {
  const youtubeId = YOUTUBE_WATCH.exec(url)?.[1] ?? YOUTUBE_SHORT.exec(url)?.[1];
  if (youtubeId) return `https://www.youtube.com/embed/${youtubeId}`;

  const spotifyMatch = SPOTIFY.exec(url);
  if (spotifyMatch) return `https://open.spotify.com/embed/${spotifyMatch[1]}/${spotifyMatch[2]}`;

  return null;
}
