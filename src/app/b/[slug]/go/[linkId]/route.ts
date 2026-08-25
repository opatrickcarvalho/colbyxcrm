// ============================================================
// GET /b/[slug]/go/[linkId]
//
// Public click-through redirect for one bio-page link. Same posture
// as /l/[code]: no auth, no rate limit (bursty public marketing
// traffic, shared/NAT'd IPs), best-effort click-log insert that never
// blocks the redirect, and every failure path still redirects — back
// to the bio page itself here, since (unlike /l/[code]) there's no
// single fallback destination otherwise.
//
// type='whatsapp' links deliberately don't build a wa.me URL here —
// they 302 through the existing /l/{code} route, which owns that
// logic, its own click log, and the inbound-webhook attribution.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolvePublicBaseUrl } from '@/lib/http/public-base-url';

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; linkId: string }> }
) {
  const { slug, linkId } = await params;
  const base = resolvePublicBaseUrl(request, 'b/[slug]/go');
  const fallback = () => NextResponse.redirect(`${base}/b/${slug}`);

  if (!slug || !linkId) return fallback();

  const db = supabaseAdmin();

  const { data: page } = await db
    .from('bio_pages')
    .select('id, active')
    .eq('slug_key', slug.toLowerCase())
    .maybeSingle();
  if (!page || !page.active) return fallback();

  const { data: link } = await db
    .from('bio_page_links')
    .select('id, type, url, ad_campaign_id, active')
    .eq('id', linkId)
    .eq('bio_page_id', page.id)
    .maybeSingle();
  if (!link || !link.active) return fallback();

  const url = new URL(request.url);

  try {
    await db.from('bio_page_link_clicks').insert({
      link_id: link.id,
      ip: getClientIp(request),
      user_agent: request.headers.get('user-agent'),
      utm_source: url.searchParams.get('utm_source'),
      utm_medium: url.searchParams.get('utm_medium'),
      utm_campaign: url.searchParams.get('utm_campaign'),
      utm_content: url.searchParams.get('utm_content'),
    });
  } catch (err) {
    console.error('[b/[slug]/go] click-log insert failed:', err);
  }

  if (link.type === 'whatsapp') {
    if (!link.ad_campaign_id) return fallback();
    const { data: campaign } = await db
      .from('ad_campaigns')
      .select('code')
      .eq('id', link.ad_campaign_id)
      .maybeSingle();
    if (!campaign) return fallback();
    return NextResponse.redirect(`${base}/l/${campaign.code}`);
  }

  if (!link.url) return fallback();
  return NextResponse.redirect(link.url);
}
