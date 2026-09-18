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
//
// `whatsapp_group` buttons get a third interception: resolving their
// destination can mean cloning a brand-new WhatsApp group
// (src/lib/bio/whatsapp-group-pool.ts), which is slow enough that a
// plain `<a href>` navigation looked stalled to visitors — see
// `activate` below. Every other link type stays a plain anchor with
// no JS in the way, so opening in a new tab / copying the link still
// works for them.
// ============================================================

'use client';

import { useRef, useState } from 'react';
import { Link as LinkIcon, Loader2, MessageCircle, Users } from 'lucide-react';

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
  /**
   * Bio-page slug for building the real /b/{slug}/go/{linkId} click
   * href. Omitted -> non-interactive preview (dashboard).
   *
   * Plain data, not a callback: this component is a Client Component
   * ('use client', for the nsfw click-gate state below) rendered from
   * a Server Component (src/app/b/[slug]/page.tsx) — a function prop
   * can't cross that boundary, only serializable data can.
   */
  goSlug?: string;
  /** Appended verbatim to each go href, e.g. "?utm_source=...". */
  goQuery?: string;
  className?: string;
}

export function BioPagePreview({
  displayName,
  bio,
  avatarUrl,
  links,
  goSlug,
  goQuery,
  className,
}: BioPagePreviewProps) {
  const hrefFor = goSlug
    ? (link: BioPagePreviewLink) => `/b/${goSlug}/go/${link.id}${goQuery ?? ''}`
    : undefined;
  // Set only on the real public page (hrefFor present) when a visitor
  // clicks an nsfw button — holds the click until they confirm, then
  // navigation resumes (straight through for most types, through
  // `activate` below for whatsapp_group).
  const [pendingLink, setPendingLink] = useState<BioPagePreviewLink | null>(null);
  // Which whatsapp_group link is currently being resolved, and what
  // count its countdown is showing. Only one at a time — a click on
  // any button while this is set is ignored (see `activate`).
  const [resolving, setResolving] = useState<{ id: string; count: number } | null>(
    null
  );
  const resolveInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetches the real destination for a whatsapp_group link (possibly
  // cloning a brand-new group server-side — see
  // src/lib/bio/whatsapp-group-pool.ts) and navigates once it's
  // ready. A plain `<a href>` to this same URL still works (that's
  // what every other link type uses) but resolving a whatsapp_group
  // destination can take several seconds, and a static link with no
  // feedback during that wait reads as broken — visitors were
  // double-clicking it. This intercepts the click instead: it shows a
  // looping "Encontrando grupo... 5 4 3 2 1" countdown for as long as
  // the fetch takes, with a short floor (~1.8s, a couple of ticks) so
  // even the instant case — an existing group with room — doesn't
  // just flash and vanish.
  function activate(link: BioPagePreviewLink) {
    if (!hrefFor || resolving) return;

    setResolving({ id: link.id, count: 5 });
    resolveInterval.current = setInterval(() => {
      setResolving((prev) =>
        prev && prev.id === link.id
          ? { id: link.id, count: prev.count > 1 ? prev.count - 1 : 5 }
          : prev
      );
    }, 600);

    const goHref = hrefFor(link);
    const jsonUrl = `${goHref}${goHref.includes('?') ? '&' : '?'}format=json`;
    const floor = new Promise((resolve) => setTimeout(resolve, 1800));
    const destination = fetch(jsonUrl)
      .then((res) => res.json())
      .then((data: { url?: string }) => data.url || goHref)
      .catch(() => goHref); // network hiccup — fall back to the plain redirect

    Promise.all([destination, floor]).then(([url]) => {
      if (resolveInterval.current) clearInterval(resolveInterval.current);
      window.location.href = url;
    });
  }

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

          const customIcon =
            link.type !== 'social' && link.icon && /^https?:\/\//.test(link.icon)
              ? link.icon
              : null;

          const badge =
            link.type === 'social' ? (
              <SocialIcon
                platform={isSocialPlatform(link.icon) ? link.icon : 'email'}
              />
            ) : customIcon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={customIcon}
                alt=""
                className="size-5 shrink-0 rounded object-contain"
              />
            ) : link.type === 'whatsapp' ? (
              <MessageCircle className="size-4 shrink-0 opacity-60" />
            ) : link.type === 'whatsapp_group' ? (
              <Users className="size-4 shrink-0 opacity-60" />
            ) : (
              <LinkIcon className="size-4 shrink-0 opacity-60" />
            );

          const buttonClass =
            'flex items-center justify-center gap-2 rounded-xl border border-neutral-800 px-4 py-3.5 text-sm font-medium transition-[filter] hover:brightness-90';
          const buttonStyle = {
            backgroundColor: link.buttonColor ?? DEFAULT_BUTTON_COLOR,
            color: link.textColor ?? DEFAULT_TEXT_COLOR,
          };

          const isResolving = resolving?.id === link.id;

          return hrefFor ? (
            <a
              key={link.id}
              href={hrefFor(link)}
              className={buttonClass}
              style={buttonStyle}
              onClick={(e) => {
                if (link.nsfw) {
                  e.preventDefault();
                  setPendingLink(link);
                  return;
                }
                if (link.type === 'whatsapp_group') {
                  e.preventDefault();
                  activate(link);
                }
              }}
            >
              {isResolving ? (
                <>
                  <Loader2 className="size-4 shrink-0 animate-spin opacity-60" />
                  Encontrando grupo... {resolving.count}
                </>
              ) : (
                <>
                  {badge}
                  {link.label}
                  {link.nsfw && <Nsfw18Badge />}
                </>
              )}
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

      {pendingLink && (
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
            {resolving?.id === pendingLink.id ? (
              <div className="flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white">
                <Loader2 className="size-4 shrink-0 animate-spin" />
                Encontrando grupo... {resolving.count}
              </div>
            ) : (
              <>
                <a
                  href={hrefFor ? hrefFor(pendingLink) : undefined}
                  className="rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-[filter] hover:brightness-90"
                  onClick={(e) => {
                    if (pendingLink.type === 'whatsapp_group') {
                      e.preventDefault();
                      activate(pendingLink);
                    }
                  }}
                >
                  Sim, tenho 18 anos ou mais
                </a>
                <button
                  type="button"
                  onClick={() => setPendingLink(null)}
                  className="rounded-xl border border-neutral-700 px-4 py-3 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-900"
                >
                  Não, sair
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
