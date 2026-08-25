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
// ============================================================

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
            >
              {badge}
              {link.label}
            </a>
          ) : (
            <div key={link.id} className={buttonClass} style={buttonStyle}>
              {badge}
              {link.label}
            </div>
          );
        })}
        {links.length === 0 && (
          <p className="py-6 text-center text-sm text-neutral-500">
            Nenhum botão ainda.
          </p>
        )}
      </div>
    </div>
  );
}
