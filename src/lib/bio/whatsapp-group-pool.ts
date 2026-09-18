// ============================================================
// Resolves a whatsapp_group-type bio button's destination at click
// time. The pool (bio_page_link_groups) is walked in position order
// and the first group with room wins — recomputed from scratch on
// every call, with no "current group" pointer persisted anywhere.
// That statelessness is deliberate: it's what makes a group that
// drops back below max_participants become eligible again on its own
// the next time someone clicks, with no extra logic required.
//
// When every candidate is full, the pool auto-expands: a new group is
// created on WhatsApp, cloned from the pool's first entry (same
// description, picture and admins, same max_participants/campaign
// tag), named "<template name> #<next sequence>", joined onto the
// pool, and returned as the destination. This is the one place the
// pool actually mutates instead of just reading live state.
//
// Called only from the public /b/{slug}/go/{linkId} route, so `db`
// must always be a service-role client (supabaseAdmin()) — there is
// no session on a public page view.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchChatAvatar } from '@/lib/whatsapp/providers/uazapi';
import {
  createGroup,
  getGroupInfo,
  resolveGroupCredentials,
  updateGroupAnnounce,
  updateGroupDescription,
  updateGroupImage,
  updateGroupLocked,
  updateGroupParticipants,
} from '@/lib/whatsapp/providers/uazapi-groups';

interface PoolGroupRow {
  id: string;
  account_id: string;
  whatsapp_config_id: string;
  group_jid: string;
  name: string;
  description: string | null;
  invite_link: string | null;
  participant_count: number;
  max_participants: number | null;
  campaign_slug: string | null;
  is_announce: boolean;
  is_locked: boolean;
}

// Matches "<base> #<n>" (the shape this module itself generates) so a
// clone's own clone continues the same sequence instead of restarting
// it or nesting suffixes ("Grupo #2 #3").
const SEQUENCE_SUFFIX = /^(.*?)\s*#(\d+)$/;

/** Next "<base> #<n>" name given the template's name and every name
 *  currently in the pool (so the sequence never reuses a number, even
 *  if the pool isn't in strict creation order). */
function nextSequentialName(templateName: string, poolNames: string[]): string {
  const templateMatch = templateName.match(SEQUENCE_SUFFIX);
  const base = templateMatch ? templateMatch[1] : templateName;

  let maxSeq = 1;
  for (const name of poolNames) {
    const match = name.match(SEQUENCE_SUFFIX);
    if (match && match[1] === base) {
      maxSeq = Math.max(maxSeq, parseInt(match[2], 10));
    } else if (name === base) {
      maxSeq = Math.max(maxSeq, 1);
    }
  }
  return `${base} #${maxSeq + 1}`;
}

/**
 * Clones `template` into a brand-new WhatsApp group and joins it onto
 * the pool at the end. Best-effort throughout — any failure logs and
 * returns null so the caller falls back to "pool exhausted" instead
 * of breaking the redirect.
 *
 * No locking: two clicks landing at the same instant on a fully-
 * exhausted pool can both decide to clone and both succeed, producing
 * two new groups (possibly with the same generated name, since both
 * compute the sequence from the same pre-expansion snapshot). That
 * mirrors the rest of this module's stateless posture — an extra
 * group is harmless and the pool self-heals on the next read — so it
 * isn't worth a distributed lock for what should be a rare event
 * (every group in the pool full at the same moment).
 */
async function cloneIntoPool(
  db: SupabaseClient,
  linkId: string,
  host: string,
  token: string,
  template: PoolGroupRow,
  currentPoolNames: string[],
  nextPosition: number
): Promise<{ inviteLink: string } | null> {
  try {
    const [live, imageUrl] = await Promise.all([
      getGroupInfo(host, token, template.group_jid),
      fetchChatAvatar(host, token, template.group_jid),
    ]);

    const adminPhones = Array.from(
      new Set(
        live.participants
          .filter((p) => p.isAdmin || p.isSuperAdmin)
          .map((p) => p.phone)
          .filter(Boolean)
      )
    ).slice(0, 50); // /group/create caps initial participants at 50

    if (adminPhones.length === 0) {
      console.error(
        `[whatsapp-group-pool] template group ${template.id} has no resolvable admins — cannot clone`
      );
      return null;
    }

    const newName = nextSequentialName(template.name, currentPoolNames);

    const created = await createGroup(host, token, {
      name: newName,
      participants: adminPhones,
    });
    if (!created.jid) {
      console.error('[whatsapp-group-pool] clone createGroup returned no jid');
      return null;
    }

    // Mirror the rest of the template's settings + promote the same
    // admins onto the clone. Each step is independent and best-effort
    // — a clone that's missing its description because this call
    // failed is still a usable destination, so none of these block
    // the redirect below.
    const steps = [
      'description',
      'image',
      'announce',
      'locked',
      'promote-admins',
    ] as const;
    const results = await Promise.allSettled([
      template.description
        ? updateGroupDescription(host, token, created.jid, template.description)
        : Promise.resolve(null),
      imageUrl ? updateGroupImage(host, token, created.jid, imageUrl) : Promise.resolve(null),
      template.is_announce
        ? updateGroupAnnounce(host, token, created.jid, true)
        : Promise.resolve(null),
      template.is_locked
        ? updateGroupLocked(host, token, created.jid, true)
        : Promise.resolve(null),
      updateGroupParticipants(host, token, {
        groupjid: created.jid,
        participants: adminPhones,
        action: 'promote',
      }),
    ]);
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(
          `[whatsapp-group-pool] clone step "${steps[i]}" failed for ${created.jid}:`,
          result.reason
        );
      }
    });

    // Re-read after the mirror steps so what we save locally (and
    // hand back as the destination) reflects the clone's real,
    // settled state rather than the pre-mirror creation response.
    const final = await getGroupInfo(host, token, created.jid);

    const { data: newGroupRow, error: insertGroupError } = await db
      .from('whatsapp_groups')
      .insert({
        account_id: template.account_id,
        whatsapp_config_id: template.whatsapp_config_id,
        group_jid: created.jid,
        name: final.name || newName,
        description: template.description,
        image_url: imageUrl,
        invite_link: final.inviteLink || null,
        participant_count: final.participantCount,
        max_participants: template.max_participants,
        campaign_slug: template.campaign_slug,
        is_announce: final.isAnnounce,
        is_locked: final.isLocked,
      })
      .select('id, invite_link')
      .single();

    if (insertGroupError || !newGroupRow) {
      console.error(
        '[whatsapp-group-pool] clone created on WhatsApp but failed to save locally:',
        insertGroupError
      );
      // The group is real on WhatsApp even though we couldn't record
      // it — still hand back its invite link so this click isn't
      // wasted. It stays outside the pool (invisible to future
      // rotation) until someone reconciles it, e.g. via Grupos do
      // WhatsApp's own import flow.
      return final.inviteLink ? { inviteLink: final.inviteLink } : null;
    }

    const { error: insertPoolError } = await db.from('bio_page_link_groups').insert({
      link_id: linkId,
      whatsapp_group_id: newGroupRow.id,
      account_id: template.account_id,
      position: nextPosition,
    });
    if (insertPoolError) {
      console.error(
        '[whatsapp-group-pool] clone saved but failed to join the pool:',
        insertPoolError
      );
    }

    return newGroupRow.invite_link ? { inviteLink: newGroupRow.invite_link } : null;
  } catch (err) {
    console.error('[whatsapp-group-pool] auto-clone failed:', err);
    return null;
  }
}

export async function resolveGroupPoolDestination(
  db: SupabaseClient,
  linkId: string
): Promise<{ inviteLink: string } | null> {
  const { data: pool } = await db
    .from('bio_page_link_groups')
    .select(
      'position, group:whatsapp_groups(id, account_id, whatsapp_config_id, group_jid, name, description, invite_link, participant_count, max_participants, campaign_slug, is_announce, is_locked)'
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

  // Every candidate is full (or unusable). Auto-expand the pool by
  // cloning the template (the pool's first entry — the one an
  // operator actually configured) rather than leaving visitors with
  // nowhere to go.
  if (creds) {
    const clone = await cloneIntoPool(
      db,
      linkId,
      creds.host,
      creds.token,
      candidates[0],
      candidates.map((c) => c.name),
      pool.length
    );
    if (clone) return clone;
  }

  console.error('[whatsapp-group-pool] pool exhausted for link', linkId);
  return null;
}
