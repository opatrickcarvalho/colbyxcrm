'use client';

import { useEffect, useState } from 'react';

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
}: {
  avatarUrl: string | null | undefined;
  name: string;
  wrapperClassName: string;
  imgClassName: string;
}) {
  const [broken, setBroken] = useState(false);

  // A previously-broken URL may later resolve (e.g. the backfill job
  // re-hosts a real photo) — reset so it gets a fresh chance to load
  // instead of being stuck on initials forever.
  useEffect(() => setBroken(false), [avatarUrl]);

  const initials = (name.trim().charAt(0) || '?').toUpperCase();
  const showImage = !!avatarUrl && !broken;

  return (
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
}
