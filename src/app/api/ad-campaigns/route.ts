import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { generateCampaignCode, slugifyCampaignCode } from '@/lib/attribution/code';

// Dashboard CRUD for ad_campaigns — inbound lead-attribution links (see
// 068_ad_campaigns.sql). Separate from /api/whatsapp/group-broadcasts,
// which is the unrelated OUTBOUND bulk-send "Campaigns" feature.
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const { data: campaigns, error } = await supabase
      .from('ad_campaigns')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/ad-campaigns] error:', error);
      return NextResponse.json({ error: 'Failed to load ad campaigns' }, { status: 500 });
    }

    // Small, per-account admin list — one lightweight count query per
    // campaign is simpler and clearer here than a hand-rolled
    // aggregate join, and the row counts involved are tiny.
    const withCounts = await Promise.all(
      (campaigns ?? []).map(async (c) => {
        const [{ count: clicks }, { count: conversations }, { count: won }] =
          await Promise.all([
            supabase
              .from('ad_campaign_clicks')
              .select('id', { count: 'exact', head: true })
              .eq('campaign_id', c.id),
            supabase
              .from('contacts')
              .select('id', { count: 'exact', head: true })
              .eq('lead_source_campaign_id', c.id),
            supabase
              .from('deals')
              .select('id, contacts!inner(lead_source_campaign_id)', {
                count: 'exact',
                head: true,
              })
              .eq('status', 'won')
              .eq('contacts.lead_source_campaign_id', c.id),
          ]);
        return {
          ...c,
          click_count: clicks ?? 0,
          conversation_count: conversations ?? 0,
          won_count: won ?? 0,
        };
      })
    );

    return NextResponse.json({ data: withCounts });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { name, message_template, code: requestedCode } = body as {
      name?: string;
      message_template?: string;
      code?: string;
    };

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const template = message_template?.trim() || 'Olá! Vim pelo anúncio @{code}';
    if (!template.includes('{code}')) {
      return NextResponse.json(
        { error: 'message_template must contain the {code} placeholder' },
        { status: 400 }
      );
    }

    // A code the operator typed themselves is authoritative — if it's
    // taken, that's a real conflict to report (409), not something to
    // silently paper over with a random suffix. An auto-derived code
    // (from the campaign name, or fully random when even that yields
    // nothing usable) is negotiable: on collision, retry with a random
    // suffix appended rather than failing the whole request.
    if (requestedCode !== undefined && !slugifyCampaignCode(requestedCode)) {
      return NextResponse.json(
        { error: 'code must contain at least one letter, digit, or underscore' },
        { status: 400 }
      );
    }
    const explicitCode = requestedCode ? slugifyCampaignCode(requestedCode) : '';
    const baseCode = explicitCode || slugifyCampaignCode(name) || generateCampaignCode();

    // code_key (lower(code), see 070_ad_campaigns_readable_code.sql) is
    // globally unique — not per-account, since the /l/{code} redirect
    // and the webhook's code-only lookup both start from just the code,
    // before they know which account it belongs to.
    let lastError: unknown = null;
    const maxAttempts = explicitCode ? 1 : 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code =
        attempt === 0 ? baseCode : `${baseCode}${generateCampaignCode().slice(0, 4)}`.slice(0, 30);

      const { data: campaign, error } = await supabase
        .from('ad_campaigns')
        .insert({
          account_id: accountId,
          user_id: userId,
          name: name.trim(),
          message_template: template,
          code,
        })
        .select()
        .single();

      if (!error && campaign) {
        return NextResponse.json({ data: campaign }, { status: 201 });
      }
      lastError = error;
      if (!isUniqueViolation(error)) break;
    }

    if (explicitCode && isUniqueViolation(lastError)) {
      return NextResponse.json(
        { error: 'Esse código já está em uso. Escolha outro.' },
        { status: 409 }
      );
    }

    console.error('[POST /api/ad-campaigns] insert error:', lastError);
    return NextResponse.json({ error: 'Failed to create ad campaign' }, { status: 500 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
