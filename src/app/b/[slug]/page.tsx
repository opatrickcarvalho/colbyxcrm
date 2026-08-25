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
//
// The actual visual is BioPagePreview (src/components/bio/bio-page-preview.tsx),
// shared with the dashboard editor's live preview so the two can never
// drift apart.
// ============================================================

import type { Metadata } from 'next';
import { headers } from 'next/headers';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  BioPagePreview,
  type BioPagePreviewLink,
} from '@/components/bio/bio-page-preview';

function getClientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return headers.get('x-real-ip')?.trim() || 'unknown';
}

async function loadPage(slug: string) {
  const db = supabaseAdmin();
  const { data: page } = await db
    .from('bio_pages')
    .select(
      'id, display_name, bio, avatar_url, active, button_color, text_color'
    )
    .eq('slug_key', slug.toLowerCase())
    .maybeSingle();

  if (!page || !page.active) return null;

  const { data: links } = await db
    .from('bio_page_links')
    .select('id, type, label, url, icon')
    .eq('bio_page_id', page.id)
    .eq('active', true)
    .order('position', { ascending: true });

  return { page, links: (links ?? []) as BioPagePreviewLink[] };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
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
        <p className="text-lg font-medium text-neutral-200">
          Página não encontrada
        </p>
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
      .insert({
        bio_page_id: page.id,
        ip: getClientIp(h),
        user_agent: h.get('user-agent'),
      });
  } catch (err) {
    console.error('[b/[slug]] view-log insert failed:', err);
  }

  // Forwarded onto every /go/{linkId} click so its own click-log row
  // carries the same UTM attribution as the page visit that led to it.
  const utmQuery = new URLSearchParams();
  for (const key of [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
  ]) {
    const value = sp[key];
    if (typeof value === 'string') utmQuery.set(key, value);
  }
  const utmSuffix = utmQuery.toString() ? `?${utmQuery.toString()}` : '';

  return (
    <main className="min-h-screen">
      <BioPagePreview
        displayName={page.display_name}
        bio={page.bio}
        avatarUrl={page.avatar_url}
        links={links}
        buttonColor={page.button_color}
        textColor={page.text_color}
        hrefFor={(link) => `/b/${slug}/go/${link.id}${utmSuffix}`}
        className="min-h-screen"
      />
    </main>
  );
}
