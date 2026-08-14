import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  LabelsNotAvailableError,
  resolveLabelCredentials,
} from '@/lib/whatsapp/label-write';
import { editLabel, listLabels } from '@/lib/whatsapp/providers';

type RequireRoleSupabase = Awaited<ReturnType<typeof requireRole>>['supabase'];

/**
 * Pulls uazapi's current label list into `whatsapp_labels`, then
 * returns this account's rows in OUR shape (`id` uuid, `color_code`) —
 * not uazapi's raw `{labelid, name, color}` shape. The two are easy to
 * conflate (only `name` matches) but the client (LabelsDropdown) keys
 * and colors every row off `id`/`color_code`; handing back the raw
 * remote shape made `label.id` and `label.color_code` `undefined` for
 * every row, which is why every label rendered as the same fallback
 * color and one checkbox toggling `appliedIds` by `undefined` checked
 * ALL of them at once (fixed by issue: labels-same-color-until-reopen).
 */
async function syncLabels(
  supabase: RequireRoleSupabase,
  accountId: string,
  host: string,
  token: string
) {
  const remote = await listLabels(host, token);
  if (remote.length > 0) {
    const { error } = await supabase.from('whatsapp_labels').upsert(
      remote.map((l) => ({
        account_id: accountId,
        uazapi_label_id: l.labelid,
        name: l.name,
        color_code: l.color,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'account_id,uazapi_label_id' }
    );
    if (error) {
      console.error('[whatsapp labels] sync upsert failed:', error.message);
    }
  }

  const { data, error: selectErr } = await supabase
    .from('whatsapp_labels')
    .select('*')
    .eq('account_id', accountId)
    .order('name');
  if (selectErr) {
    console.error('[whatsapp labels] reload after sync failed:', selectErr.message);
    return [];
  }
  return data ?? [];
}

/**
 * GET /api/whatsapp/labels
 *
 * Live-syncs from uazapi's `GET /labels` on every call (cheap, single
 * request) rather than trusting the local cache alone — the
 * `labels`/`chat_labels` webhooks keep it current going forward, but
 * a first load (or a label created straight from the phone before any
 * webhook fired) needs this to not show stale/empty state.
 */
export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const { host, token } = await resolveLabelCredentials(
      ctx.supabase,
      ctx.accountId
    );
    const labels = await syncLabels(ctx.supabase, ctx.accountId, host, token);
    return NextResponse.json({ labels });
  } catch (error) {
    if (error instanceof LabelsNotAvailableError) {
      return NextResponse.json({ labels: [], unavailable: true });
    }
    return toErrorResponse(error);
  }
}

/**
 * POST /api/whatsapp/labels
 *
 * Creates a label directly on the WhatsApp Business instance
 * (`labelid: "new"` when the body omits one) — this is the CRM's only
 * label-creation path, so there is never a CRM-only label without a
 * WhatsApp counterpart. `color` is uazapi's fixed 0-19 palette index.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      name?: string;
      color?: number;
      labelid?: string;
    } | null;

    const name = body?.name?.trim();
    const color = Number(body?.color);
    if (!name || !Number.isInteger(color) || color < 0 || color > 19) {
      return NextResponse.json(
        { error: 'name and color (0-19) are required' },
        { status: 400 }
      );
    }

    const { host, token } = await resolveLabelCredentials(
      ctx.supabase,
      ctx.accountId
    );
    await editLabel(host, token, {
      labelid: body?.labelid || 'new',
      name,
      color,
      delete: false,
    });

    const labels = await syncLabels(ctx.supabase, ctx.accountId, host, token);
    return NextResponse.json({ ok: true, labels });
  } catch (error) {
    if (error instanceof LabelsNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return toErrorResponse(error);
  }
}
