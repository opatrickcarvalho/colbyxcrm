// ============================================================
// Shared visual for a bio page — the actual public page
// (src/app/b/[slug]/page.tsx) and the live preview in the dashboard
// editor (src/app/(dashboard)/bio-link/page.tsx) both render through
// this one component, so the preview can never drift from what
// visitors actually see.
//
// Every link type renders as a full-width button (social included —
// a bare icon read as "not a button" in practice); `embed` renders
// inline instead when its URL resolves to a known platform.
//
// buttonColor/textColor are set PER BUTTON (bio_page_links), not for
// the page — the profile header (avatar/name/bio) is a separate
// scheme with a fixed color, deliberately not part of this theming.
//
// `nsfw` is also per-button — clicking one (only when `hrefFor` makes
// this the real public page, not the dashboard's non-interactive
// preview) is intercepted client-side and swaps in a darkened
// full-screen 18+ confirmation before the real navigation happens.
// ============================================================

'use client';

import { useState } from 'react';
import { Link as LinkIcon, MessageCircle } from 'lucide-react';

import { resolveEmbedUrl } from '@/lib/bio/embed';
import { SocialIcon } from '@/lib/bio/social-icons';
import { isSocialPlatform, type BioLinkType } from '@/lib/bio/link-types';
import { DEFAULT_BUTTON_COLOR, DEFAULT_TEXT_COLOR } from '@/lib/bio/theme';

export interface BioPagePreviewLink {
  id: string;
  type: BioLinkType;
  label: string;
  url?: string | null;
  icon?: string | null;
  buttonColor?: string;
  textColor?: string;
  nsfw?: boolean;
}

/** Small "+18" badge shown on a button flagged as sensitive content. */
function Nsfw18Badge() {
  return (
    <span
      className="inline-flex h-4 shrink-0 items-center justify-center rounded bg-red-600 px-1 text-[10px] leading-none font-bold text-white"
      aria-hidden
      title="Conteúdo sensível — +18"
    >
      +18
    </span>
  );
}

export interface BioPagePreviewProps {
  displayName: string;
  bio?: string | null;
  avatarUrl?: string | null;
  links: BioPagePreviewLink[];
  /** Real destination href for a link click. Omitted -> non-interactive preview (dashboard). */
  hrefFor?: (link: BioPagePreviewLink) => string;
  className?: string;
}

export function BioPagePreview({
  displayName,
  bio,
  avatarUrl,
  links,
  hrefFor,
  className,
}: BioPagePreviewProps) {
  // Set only on the real public page (hrefFor present) when a visitor
  // clicks an nsfw button — holds the click until they confirm, then
  // navigation resumes to this same href.
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  return (
    <div
      className={`flex flex-col items-center gap-6 bg-neutral-950 px-6 py-10 text-neutral-100 ${className ?? ''}`}
    >
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={displayName}
            className="size-24 rounded-full object-cover"
          />
        ) : (
          <div className="flex size-24 items-center justify-center rounded-full bg-neutral-800 text-2xl font-semibold">
            {displayName.charAt(0).toUpperCase() || '?'}
          </div>
        )}
        <h1 className="text-lg font-semibold">{displayName || 'Sua página'}</h1>
        {bio && <p className="text-sm text-neutral-400">{bio}</p>}
      </div>

      <div className="flex w-full max-w-md flex-col gap-3">
        {links.map((link) => {
          if (link.type === 'embed' && link.url) {
            const embedSrc = resolveEmbedUrl(link.url);
            if (embedSrc) {
              return (
                <div
                  key={link.id}
                  className="overflow-hidden rounded-xl border border-neutral-800"
                >
                  <iframe
                    src={embedSrc}
                    title={link.label}
                    className="aspect-video w-full"
                    allow="autoplay; encrypted-media; picture-in-picture"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
                  />
                </div>
              );
            }
            // Unrecognized embed URL — falls through to a plain button below.
          }

          const badge =
            link.type === 'social' ? (
              <SocialIcon
                platform={isSocialPlatform(link.icon) ? link.icon : 'email'}
              />
            ) : link.type === 'whatsapp' ? (
              <MessageCircle className="size-4 shrink-0 opacity-60" />
            ) : (
              <LinkIcon className="size-4 shrink-0 opacity-60" />
            );

          const buttonClass =
            'flex items-center justify-center gap-2 rounded-xl border border-neutral-800 px-4 py-3.5 text-sm font-medium transition-[filter] hover:brightness-90';
          const buttonStyle = {
            backgroundColor: link.buttonColor ?? DEFAULT_BUTTON_COLOR,
            color: link.textColor ?? DEFAULT_TEXT_COLOR,
          };

          return hrefFor ? (
            <a
              key={link.id}
              href={hrefFor(link)}
              className={buttonClass}
              style={buttonStyle}
              onClick={(e) => {
                if (!link.nsfw) return;
                e.preventDefault();
                setPendingHref(hrefFor(link));
              }}
            >
              {badge}
              {link.label}
              {link.nsfw && <Nsfw18Badge />}
            </a>
          ) : (
            <div key={link.id} className={buttonClass} style={buttonStyle}>
              {badge}
              {link.label}
              {link.nsfw && <Nsfw18Badge />}
            </div>
          );
        })}
        {links.length === 0 && (
          <p className="py-6 text-center text-sm text-neutral-500">
            Nenhum botão ainda.
          </p>
        )}
      </div>

      {pendingHref && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-black/90 px-6 text-center backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <span className="flex size-12 items-center justify-center rounded-full bg-red-600 text-base font-bold text-white">
            +18
          </span>
          <p className="max-w-xs text-base font-medium text-neutral-100">
            Este conteúdo é para maiores de 18 anos. Você tem 18 anos ou mais?
          </p>
          <div className="flex w-full max-w-xs flex-col gap-3">
            <a
              href={pendingHref}
              className="rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-[filter] hover:brightness-90"
            >
              Sim, tenho 18 anos ou mais
            </a>
            <button
              type="button"
              onClick={() => setPendingHref(null)}
              className="rounded-xl border border-neutral-700 px-4 py-3 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-900"
            >
              Não, sair
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
