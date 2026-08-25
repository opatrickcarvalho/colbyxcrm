// ============================================================
// GET /b/[slug] — public bio page.
//
// Server Component (sibling to l/, join/, admin/ — outside the
// (dashboard) route group, so it renders with zero dashboard chrome).
// Unlike /l/[code] this DOES render — there's no single wa.me
// destination to bounce to, the whole point is showing the button
// list — but it follows the same posture otherwise: public/no-auth
// via supabaseAdmin(), best-effort view logging that never blocks the
// render, and no rendered error page distinct from "page not found"
// (a missing/inactive slug just renders that state instead of 404ing,
// since a mistyped bio link is a much more likely visitor path than a
// broken app route).
// ============================================================

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Link as LinkIcon } from 'lucide-react';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveEmbedUrl } from '@/lib/bio/embed';
import { SocialIcon } from '@/lib/bio/social-icons';
import { isSocialPlatform } from '@/lib/bio/link-types';

interface BioPageLink {
  id: string;
  type: 'link' | 'whatsapp' | 'social' | 'embed';
  label: string;
  url: string | null;
  icon: string | null;
}

function getClientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return headers.get('x-real-ip')?.trim() || 'unknown';
}

async function loadPage(slug: string) {
  const db = supabaseAdmin();
  const { data: page } = await db
    .from('bio_pages')
    .select('id, display_name, bio, avatar_url, active')
    .eq('slug_key', slug.toLowerCase())
    .maybeSingle();

  if (!page || !page.active) return null;

  const { data: links } = await db
    .from('bio_page_links')
    .select('id, type, label, url, icon')
    .eq('bio_page_id', page.id)
    .eq('active', true)
    .order('position', { ascending: true });

  return { page, links: (links ?? []) as BioPageLink[] };
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await params;
  const data = await loadPage(slug);
  return { title: data?.page.display_name ?? 'Página não encontrada' };
}

export default async function BioPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const data = await loadPage(slug);

  if (!data) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-neutral-950 px-6 text-center text-neutral-400">
        <p className="text-lg font-medium text-neutral-200">Página não encontrada</p>
        <p className="text-sm">Confira se o link está certo.</p>
      </main>
    );
  }

  const { page, links } = data;

  // Best-effort — a logging failure must never break the page render.
  try {
    const h = await headers();
    await supabaseAdmin()
      .from('bio_page_views')
      .insert({ bio_page_id: page.id, ip: getClientIp(h), user_agent: h.get('user-agent') });
  } catch (err) {
    console.error('[b/[slug]] view-log insert failed:', err);
  }

  // Forwarded onto every /go/{linkId} click so its own click-log row
  // carries the same UTM attribution as the page visit that led to it.
  const utmQuery = new URLSearchParams();
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) {
    const value = sp[key];
    if (typeof value === 'string') utmQuery.set(key, value);
  }
  const utmSuffix = utmQuery.toString() ? `?${utmQuery.toString()}` : '';

  const socialLinks = links.filter((l) => l.type === 'social');
  const mainLinks = links.filter((l) => l.type !== 'social');

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 bg-neutral-950 px-6 py-12 text-neutral-100">
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
        {page.avatar_url ? (
          // Plain <img>, not next/image — user-uploaded Supabase Storage
          // URLs, same convention as the rest of the app (branding
          // logo, profile avatar) to avoid next.config remotePatterns.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={page.avatar_url}
            alt={page.display_name}
            className="size-24 rounded-full object-cover"
          />
        ) : (
          <div className="flex size-24 items-center justify-center rounded-full bg-neutral-800 text-2xl font-semibold">
            {page.display_name.charAt(0).toUpperCase()}
          </div>
        )}
        <h1 className="text-lg font-semibold">{page.display_name}</h1>
        {page.bio && <p className="text-sm text-neutral-400">{page.bio}</p>}
      </div>

      <div className="flex w-full max-w-md flex-col gap-3">
        {mainLinks.map((link) => {
          if (link.type === 'embed' && link.url) {
            const embedSrc = resolveEmbedUrl(link.url);
            if (embedSrc) {
              return (
                <div key={link.id} className="overflow-hidden rounded-xl border border-neutral-800">
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
            // Unrecognized embed URL — falls through to a plain link card.
          }
          return (
            <a
              key={link.id}
              href={`/b/${slug}/go/${link.id}${utmSuffix}`}
              className="flex items-center justify-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3.5 text-sm font-medium text-neutral-100 transition-colors hover:bg-neutral-800"
            >
              <LinkIcon className="size-4 shrink-0 text-neutral-400" />
              {link.label}
            </a>
          );
        })}
      </div>

      {socialLinks.length > 0 && (
        <div className="flex flex-wrap justify-center gap-3">
          {socialLinks.map((link) => (
            <a
              key={link.id}
              href={`/b/${slug}/go/${link.id}${utmSuffix}`}
              aria-label={link.label}
              title={link.label}
            >
              <SocialIcon platform={isSocialPlatform(link.icon) ? link.icon : 'email'} />
            </a>
          ))}
        </div>
      )}
    </main>
  );
}
