// ============================================================
// GET /l/[code]
//
// Public ad-attribution redirect. A campaign's short link — pasted into
// an Instagram bio, a QR code, a Google Ads landing page, or anywhere
// else a URL can go — lands here and bounces straight to a wa.me chat
// with the connected WhatsApp number, prefilled with a message
// containing the campaign's tracking code.
//
// This MUST be a Route Handler, not a page: no render, no client JS,
// no layout — a redirect landing on a rendered page is exactly the
// friction a prospect abandons over. Everything below is one lookup,
// a best-effort click-log insert, and a 302.
//
// No auth (this is a public marketing link) and no session — uses the
// service-role client, same as the inbound webhook and
// resolveConversationByPhone. Deliberately no tight rate limit either:
// real ad traffic arrives in bursts, and mobile leads routinely share
// one IP behind carrier-grade NAT — a strict per-IP limit here would
// silently break attribution for legitimate clicks.
//
// Every failure path (campaign not found/inactive, account has no
// WhatsApp connected, click-log insert error) still redirects — never
// a rendered error page.
// ============================================================

import { NextResponse } from 'next/server';

import { renderPrefilledMessage } from '@/lib/attribution/code';
import { buildWaMeUrl } from '@/lib/attribution/wa-link';
import { resolvePublicBaseUrl } from '@/lib/http/public-base-url';
import { supabaseAdmin } from '@/lib/flows/admin-client';

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const fallback = () =>
    NextResponse.redirect(resolvePublicBaseUrl(request, 'l/[code]'));

  if (!code) return fallback();

  const db = supabaseAdmin();

  // code_key (lower(code), see 070_ad_campaigns_readable_code.sql) is
  // what's matched on — case-insensitive, and immune to the ILIKE
  // wildcard-injection risk a raw `code.toLowerCase()` compared with
  // ILIKE would carry, since this is a plain equality filter.
  const { data: campaign } = await db
    .from('ad_campaigns')
    .select('id, account_id, code, message_template, active')
    .eq('code_key', code.toLowerCase())
    .maybeSingle();

  if (!campaign || !campaign.active) return fallback();

  const { data: config } = await db
    .from('whatsapp_config')
    .select('connected_number')
    .eq('account_id', campaign.account_id)
    .maybeSingle();

  if (!config?.connected_number) return fallback();

  const url = new URL(request.url);

  // Best-effort — a logging failure must never turn a live ad click
  // into a broken redirect.
  try {
    await db.from('ad_campaign_clicks').insert({
      campaign_id: campaign.id,
      ip: getClientIp(request),
      user_agent: request.headers.get('user-agent'),
      utm_source: url.searchParams.get('utm_source'),
      utm_medium: url.searchParams.get('utm_medium'),
      utm_campaign: url.searchParams.get('utm_campaign'),
      utm_content: url.searchParams.get('utm_content'),
    });
  } catch (err) {
    console.error('[l/code] click-log insert failed:', err);
  }

  // The campaign's own stored code (operator's original casing), not
  // the URL param — so "SalvadosCardoso" renders as typed regardless
  // of how the link happens to be cased when someone clicks it.
  const text = renderPrefilledMessage(campaign.message_template, campaign.code);
  return NextResponse.redirect(buildWaMeUrl(config.connected_number, text));
}
