"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  FileText,
  ImageOff,
  Loader2,
  Maximize2,
  Pause,
  Play,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { downloadMediaMessage } from "@/lib/media/download";
import type { MediaMessageLike } from "@/lib/media/message-like";
import { useMediaBlobUrl } from "@/hooks/use-media-blob-url";

/**
 * The media renderers behind `<MessageBubble>`'s image / video / audio /
 * document cases. Split out of message-bubble.tsx so that file stays a
 * thin content switch — everything here is about the two affordances
 * issue #373 asked for: open it full-size, and save it.
 *
 * Both are less trivial than they look, because the two flavours of
 * `media_url` behave differently in the browser. See
 * `@/lib/media/blob-cache` for the proxy-vs-bucket split and
 * `@/lib/media/download` for why `<a download>` alone isn't enough.
 */

type Translator = ReturnType<typeof useTranslations>;

/** Inline media size cap, shared so the four bubbles can't drift apart. */
const MEDIA_BOX = "max-h-64 max-w-60";

export function MediaUnavailable({
  label,
  t,
}: {
  label: string;
  t: Translator;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{t("unavailable", { label })}</span>
    </div>
  );
}

/**
 * Kicks off a download and reports failure as a toast. Kept as a hook so
 * each bubble owns its own in-flight state — a slow 16 MB video shouldn't
 * put a spinner on every other attachment in the thread.
 */
function useMediaDownload(message: MediaMessageLike, t: Translator) {
  const [downloading, setDownloading] = useState(false);

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadMediaMessage(message);
    } catch {
      toast.error(t("downloadFailed"));
    } finally {
      setDownloading(false);
    }
  }, [downloading, message, t]);

  return { downloading, download };
}

function MediaActionButton({
  icon: Icon,
  label,
  onClick,
  busy = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      // Own surface rather than inheriting the bubble's, so the same button
      // reads on the muted inbound fill, the primary outbound fill, and on
      // top of an arbitrary photo.
      className="flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-background/85 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function MediaPlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
      {children}
    </div>
  );
}

export function MediaImageBubble({
  message,
  onOpen,
  t,
}: {
  message: MediaMessageLike;
  /** Opens the thread's lightbox on this message. Omitted ⇒ not clickable. */
  onOpen?: () => void;
  t: Translator;
}) {
  const { src, status } = useMediaBlobUrl(message.media_url);
  // The fetch can succeed and the bytes still not be a decodable image.
  const [broken, setBroken] = useState(false);
  const { downloading, download } = useMediaDownload(message, t);

  if (status === "error" || broken) {
    return (
      <MediaPlaceholder>
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </MediaPlaceholder>
    );
  }

  if (status !== "ready" || !src) {
    return (
      <MediaPlaceholder>
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </MediaPlaceholder>
    );
  }

  const image = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={t("imageAlt")}
      className={cn(MEDIA_BOX, "rounded-lg object-contain")}
      onError={() => setBroken(true)}
    />
  );

  return (
    <div className="group/media relative w-fit">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("viewImage")}
          className="block cursor-zoom-in rounded-lg outline-none ring-offset-2 ring-offset-transparent focus-visible:ring-2 focus-visible:ring-ring"
        >
          {image}
        </button>
      ) : (
        image
      )}
      {/* Hover-only: on touch there is no hover, but tapping the image opens
          the viewer, which carries a full-size Download button. */}
      <div className="absolute bottom-2 right-2 opacity-0 transition-opacity group-hover/media:opacity-100 group-focus-within/media:opacity-100">
        <MediaActionButton
          icon={Download}
          label={t("download")}
          onClick={download}
          busy={downloading}
        />
      </div>
    </div>
  );
}

export function MediaVideoBubble({
  message,
  onOpen,
  t,
}: {
  message: MediaMessageLike;
  onOpen?: () => void;
  t: Translator;
}) {
  const { downloading, download } = useMediaDownload(message, t);

  return (
    <div className="relative w-fit">
      {/* Plain URL, not a blob: the element should stream rather than wait
          for up to 16 MB to land. */}
      <video
        src={message.media_url}
        controls
        preload="metadata"
        className={cn(MEDIA_BOX, "rounded-lg")}
      />
      {/* Top-right, clear of the native controls — and always visible, since
          expanding is the only way to watch a clip capped at 15rem wide and
          a touch device gets no hover. */}
      <div className="absolute right-2 top-2 flex gap-1">
        {onOpen && (
          <MediaActionButton
            icon={Maximize2}
            label={t("expandVideo")}
            onClick={onOpen}
          />
        )}
        <MediaActionButton
          icon={Download}
          label={t("download")}
          onClick={download}
          busy={downloading}
        />
      </div>
    </div>
  );
}

/** Bar count for the waveform — enough resolution to look like a real
 *  recording without turning into a solid smear at the bubble's width. */
const AUDIO_BAR_COUNT = 40;

/**
 * A small, deterministic (url-seeded) bar pattern so the player never
 * shows a flat line — while `useAudioPeaks` is still decoding, or for a
 * browser/CORS combination that can never decode at all. Same shape as
 * a real waveform, just not derived from the actual audio.
 */
function fallbackPeaks(url: string | undefined): number[] {
  let seed = 0;
  for (let i = 0; i < (url?.length ?? 0); i++) {
    seed = (seed * 31 + url!.charCodeAt(i)) >>> 0;
  }
  const peaks: number[] = [];
  for (let i = 0; i < AUDIO_BAR_COUNT; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    peaks.push(0.25 + ((seed >>> 8) % 1000) / 1000 * 0.65);
  }
  return peaks;
}

/**
 * Decodes the audio once into real per-bar amplitude peaks, so the
 * waveform reflects the actual recording — the same effect WhatsApp
 * Web's voice-note player has, instead of a generic progress bar.
 * Falls back to {@link fallbackPeaks} on anything that stops decoding
 * (no Web Audio API, an unsupported codec, a network error): the
 * player still looks like a voice note rather than breaking.
 */
function useAudioPeaks(url: string | undefined): number[] {
  const [peaks, setPeaks] = useState<number[]>(() => fallbackPeaks(url));

  useEffect(() => {
    setPeaks(fallbackPeaks(url));
    if (!url) return;

    const AudioCtxCtor =
      typeof window !== "undefined"
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
        : undefined;
    if (!AudioCtxCtor) return;

    let cancelled = false;
    let ctx: AudioContext | undefined;

    (async () => {
      try {
        const res = await fetch(url);
        const arrayBuffer = await res.arrayBuffer();
        ctx = new AudioCtxCtor();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        const channel = audioBuffer.getChannelData(0);
        const blockSize = Math.max(
          1,
          Math.floor(channel.length / AUDIO_BAR_COUNT)
        );
        const computed: number[] = [];
        for (let i = 0; i < AUDIO_BAR_COUNT; i++) {
          const start = i * blockSize;
          let sum = 0;
          for (let j = 0; j < blockSize; j++) {
            sum += Math.abs(channel[start + j] ?? 0);
          }
          computed.push(sum / blockSize);
        }
        const max = Math.max(...computed, 0.0001);
        if (!cancelled) {
          setPeaks(computed.map((v) => Math.max(0.08, v / max)));
        }
      } catch {
        // Fallback pattern set above already stands.
      } finally {
        void ctx?.close();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  return peaks;
}

function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const PLAYBACK_RATES = [1, 1.5, 2] as const;

export function MediaAudioBubble({
  message,
  t,
  onFirstPlay,
}: {
  message: MediaMessageLike;
  t: Translator;
  /** Fires once, the first time this voice note is actually played —
   *  the caller's hook for sending WhatsApp's "played" read receipt at
   *  the real moment it happens, rather than when the chat is opened. */
  onFirstPlay?: () => void;
}) {
  const { downloading, download } = useMediaDownload(message, t);
  const audioRef = useRef<HTMLAudioElement>(null);
  const peaks = useAudioPeaks(message.media_url);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState<(typeof PLAYBACK_RATES)[number]>(1);
  const firedFirstPlay = useRef(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrentTime(el.currentTime);
    const onLoaded = () => setDuration(el.duration || 0);
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("durationchange", onLoaded);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("durationchange", onLoaded);
      el.removeEventListener("ended", onEnded);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (isPlaying) {
      el.pause();
      setIsPlaying(false);
      return;
    }
    el.playbackRate = rate;
    void el.play();
    setIsPlaying(true);
    if (!firedFirstPlay.current) {
      firedFirstPlay.current = true;
      onFirstPlay?.();
    }
  }, [isPlaying, onFirstPlay, rate]);

  const cycleRate = useCallback(() => {
    const next =
      PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }, [rate]);

  const seekTo = useCallback(
    (ratio: number) => {
      const el = audioRef.current;
      if (!el || !duration) return;
      el.currentTime = Math.min(duration, Math.max(0, ratio * duration));
      setCurrentTime(el.currentTime);
    },
    [duration]
  );

  const progress = duration > 0 ? currentTime / duration : 0;
  const playedBars = Math.round(progress * AUDIO_BAR_COUNT);

  return (
    <div className="flex w-64 items-center gap-2">
      <audio
        ref={audioRef}
        src={message.media_url}
        preload="metadata"
        className="hidden"
      />
      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? t("pause") : t("play")}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/90 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background"
      >
        {isPlaying ? (
          <Pause className="h-4 w-4 fill-current" />
        ) : (
          <Play className="ml-0.5 h-4 w-4 fill-current" />
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seekTo((e.clientX - rect.left) / rect.width);
          }}
          aria-label={t("seek")}
          className="flex h-6 w-full items-center gap-[2px]"
        >
          {peaks.map((height, i) => (
            <span
              key={i}
              className={cn(
                "min-w-[2px] flex-1 rounded-full transition-colors",
                i < playedBars ? "bg-current" : "bg-current/30"
              )}
              style={{ height: `${Math.round(height * 100)}%` }}
            />
          ))}
        </button>
        <div className="flex items-center justify-between text-[10px] tabular-nums opacity-70">
          <span>{formatAudioTime(currentTime || duration)}</span>
          <button
            type="button"
            onClick={cycleRate}
            aria-label={t("playbackSpeed")}
            className="rounded px-1 font-semibold hover:bg-current/10"
          >
            {rate}×
          </button>
        </div>
      </div>

      <MediaActionButton
        icon={Download}
        label={t("download")}
        onClick={download}
        busy={downloading}
      />
    </div>
  );
}

export function MediaDocumentBubble({
  message,
  t,
}: {
  message: MediaMessageLike;
  t: Translator;
}) {
  const { downloading, download } = useMediaDownload(message, t);

  return (
    <div className="flex items-center gap-2">
      <a
        href={message.media_url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
      >
        <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
        <span className="truncate">{message.content_text || t("document")}</span>
      </a>
      <MediaActionButton
        icon={Download}
        label={t("download")}
        onClick={download}
        busy={downloading}
      />
    </div>
  );
}
