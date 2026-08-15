import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  GroupsNotAvailableError,
  listGroups,
  resolveGroupCredentials,
} from '@/lib/whatsapp/providers/uazapi-groups';

/**
 * GET /api/whatsapp/groups/available
 *
 * Every WhatsApp group the connected number already participates in —
 * including ones created from the phone, never through this CRM — so
 * the agent can pick which ones should actually show up in the Groups
 * tab, instead of every group syncing in automatically. Cross-referenced
 * against the locally tracked `whatsapp_groups` rows so the picker can
 * show each one's current state (not tracked / hidden / shown).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent');

    let creds;
    try {
      creds = await resolveGroupCredentials(supabase, accountId);
    } catch (err) {
      if (err instanceof GroupsNotAvailableError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    const [remoteGroups, { data: localGroups, error: localError }] =
      await Promise.all([
        // noparticipants: the picker only needs name + count, and skipping
        // the participant list keeps this fast even with dozens of groups.
        listGroups(creds.host, creds.token, { noparticipants: true }),
        supabase
          .from('whatsapp_groups')
          .select('id, group_jid, status')
          .eq('account_id', accountId),
      ]);

    if (localError) {
      console.error(
        '[GET /api/whatsapp/groups/available] local fetch failed:',
        localError.message
      );
      return NextResponse.json({ error: 'Failed to load groups' }, { status: 500 });
    }

    const trackedByJid = new Map(
      (localGroups ?? []).map((g) => [g.group_jid, g])
    );

    const data = remoteGroups
      .filter((g) => g.jid)
      .map((g) => {
        const tracked = trackedByJid.get(g.jid);
        return {
          jid: g.jid,
          name: g.name || g.jid,
          participantCount: g.participantCount,
          localId: tracked?.id ?? null,
          // 'active' (shown), 'archived' (hidden, but re-addable without
          // re-fetching group info), or null (never picked before).
          status: tracked?.status ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
