// ============================================================
// Resolves a whatsapp_group-type bio button's destination at click
// time. The pool (bio_page_link_groups) is walked in position order
// and the first group with room wins — recomputed from scratch on
// every call, with no "current group" pointer persisted anywhere.
// That statelessness is deliberate: it's what makes a group that
// drops back below max_participants become eligible again on its own
// the next time someone clicks, with no extra logic required.
//
// Called only from the public /b/{slug}/go/{linkId} route, so `db`
// must always be a service-role client (supabaseAdmin()) — there is
// no session on a public page view.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { getGroupInfo, resolveGroupCredentials } from '@/lib/whatsapp/providers/uazapi-groups';

interface PoolGroupRow {
  id: string;
  account_id: string;
  group_jid: string;
  invite_link: string | null;
  participant_count: number;
  max_participants: number | null;
}

export async function resolveGroupPoolDestination(
  db: SupabaseClient,
  linkId: string
): Promise<{ inviteLink: string } | null> {
  const { data: pool } = await db
    .from('bio_page_link_groups')
    .select(
      'position, group:whatsapp_groups(id, account_id, group_jid, invite_link, participant_count, max_participants)'
    )
    .eq('link_id', linkId)
    .order('position', { ascending: true });

  if (!pool || pool.length === 0) return null;

  const candidates = pool
    .map((row) => row.group as unknown as PoolGroupRow | null)
    .filter((g): g is PoolGroupRow => g !== null);
  if (candidates.length === 0) return null;

  // Credentials are per-account, not per-group — every group in one
  // pool belongs to the same account as the link (enforced at write
  // time), so resolving once up front is enough.
  let creds: { host: string; token: string } | null = null;
  try {
    creds = await resolveGroupCredentials(db, candidates[0].account_id);
  } catch (err) {
    console.error('[whatsapp-group-pool] resolveGroupCredentials failed:', err);
    creds = null; // degrade to cached-count-only mode below
  }

  for (const group of candidates) {
    let participantCount = group.participant_count;
    let inviteLink = group.invite_link;

    if (creds) {
      try {
        const live = await getGroupInfo(creds.host, creds.token, group.group_jid);
        participantCount = live.participantCount;
        if (live.inviteLink) inviteLink = live.inviteLink;

        // Best-effort mirror — never blocks the redirect. This is a
        // public, high-traffic route, so this write is intentionally
        // fire-and-forget rather than awaited.
        db.from('whatsapp_groups')
          .update({
            participant_count: live.participantCount,
            ...(live.inviteLink ? { invite_link: live.inviteLink } : {}),
          })
          .eq('id', group.id)
          .then(({ error }) => {
            if (error) {
              console.error('[whatsapp-group-pool] mirror failed:', error.message);
            }
          });
      } catch (err) {
        // Live check failed for this one candidate — fall back to its
        // cached DB columns rather than skipping it outright, so a
        // transient UAZAPI blip doesn't wrongly exclude an available
        // group.
        console.error(
          `[whatsapp-group-pool] getGroupInfo failed for group ${group.id}:`,
          err
        );
      }
    }

    const hasRoom = group.max_participants == null || participantCount < group.max_participants;
    if (!hasRoom) continue;
    if (!inviteLink) continue; // no usable destination for this candidate, try next

    return { inviteLink };
  }

  console.error('[whatsapp-group-pool] pool exhausted for link', linkId);
  return null;
}
