'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * A contact's avatar, falling back to their initials whenever
 * `avatarUrl` is unset OR fails to load. The `onError` fallback
 * matters specifically for WhatsApp-sourced photos: even after
 * src/lib/whatsapp/rehost-avatar.ts started re-hosting them, older
 * rows saved before that fix (or any other broken URL) would
 * otherwise render as a literal broken-image icon instead of the
 * initials placeholder every other "no photo" state already shows.
 */
export function ContactAvatar({
  avatarUrl,
  name,
  wrapperClassName,
  imgClassName,
  expandable = false,
  expandLabel,
}: {
  avatarUrl: string | null | undefined;
  name: string;
  wrapperClassName: string;
  imgClassName: string;
  /** Clicking a real photo opens it full-size. No-op when there's no
   *  photo (initials aren't worth a full-screen dialog), so callers can
   *  pass this unconditionally without checking `avatarUrl` first. */
  expandable?: boolean;
  /** Accessible label for the expand button; required when `expandable`. */
  expandLabel?: string;
}) {
  const [broken, setBroken] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // A previously-broken URL may later resolve (e.g. the backfill job
  // re-hosts a real photo) — reset so it gets a fresh chance to load
  // instead of being stuck on initials forever. Adjusting state during
  // render (React's documented pattern for "reset when a prop changes")
  // rather than in an effect, so the reset lands in the same render
  // instead of flashing initials for one frame first.
  const [prevAvatarUrl, setPrevAvatarUrl] = useState(avatarUrl);
  if (avatarUrl !== prevAvatarUrl) {
    setPrevAvatarUrl(avatarUrl);
    setBroken(false);
  }

  const initials = (name.trim().charAt(0) || '?').toUpperCase();
  const showImage = !!avatarUrl && !broken;

  const avatar = (
    <div className={wrapperClassName}>
      {showImage ? (
        <img
          src={avatarUrl}
          alt={name}
          className={imgClassName}
          onError={() => setBroken(true)}
        />
      ) : (
        initials
      )}
    </div>
  );

  if (!expandable || !showImage) return avatar;

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={expandLabel ?? name}
        title={expandLabel ?? name}
        className="cursor-zoom-in rounded-full outline-none ring-offset-2 ring-offset-transparent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {avatar}
      </button>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="w-auto max-w-[90vw] gap-3 p-3 sm:max-w-md">
          <DialogHeader className="pr-6">
            <DialogTitle className="truncate">{name}</DialogTitle>
          </DialogHeader>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={avatarUrl}
            alt={name}
            className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
