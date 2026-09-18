// ============================================================
// Resolves a whatsapp_group-type bio button's destination at click
// time. The pool (bio_page_link_groups) is walked emptiest-first (see
// sortByAvailability, keyed off each group's cached fill level rather
// than the editor's position order) and the first group with room
// wins — recomputed from scratch on every call, with no "current
// group" pointer persisted anywhere. That statelessness is
// deliberate: it's what makes a group that drops back below
// max_participants become eligible again on its own the next time
// someone clicks, with no extra logic required.
//
// This walk makes NO live UAZAPI calls — it trusts the cached
// participant_count/invite_link columns entirely (see the comment
// inside resolveGroupPoolDestination for why that's safe). An earlier
// version live-checked every candidate it walked, which put a UAZAPI
// round trip on the critical path of every single click; that's gone
// now, on purpose — a redirect should cost one DB read, nothing else.
//
// When every candidate is full, the pool auto-expands: a new group is
// created on WhatsApp, cloned from the pool's first entry (same
// description, picture and admins, same max_participants/campaign
// tag), named "<template name> #<next sequence>", joined onto the
// pool, and returned as the destination. This is the one place the
// pool actually mutates instead of just reading live state.
//
// Expansion is guarded by bio_page_link_group_pool_claims
// (076_bio_page_link_group_pool_claims.sql) — see acquireExpansionClaim
// below for why: cloning takes several sequential UAZAPI round trips,
// and a visitor who doesn't see the page navigate right away tends to
// click again, which without a claim raced a second clone into
// existence for the same exhausted pool.
//
// Called only from the public /b/{slug}/go/{linkId} route, so `db`
// must always be a service-role client (supabaseAdmin()) — there is
// no session on a public page view.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
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
  type UazapiGroup,
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

// A claim older than this is assumed to belong to a process that
// crashed mid-clone (never reached its own release) rather than one
// genuinely still working — cloning normally finishes in well under a
// minute, so this is a generous timeout, not a tight one.
const STALE_CLAIM_MS = 2 * 60 * 1000;

/**
 * Claims the exclusive right to expand `linkId`'s pool. Returns false
 * if another request already holds a fresh claim — the caller should
 * back off rather than also clone.
 *
 * Concurrency safety comes from bio_page_link_group_pool_claims'
 * PRIMARY KEY on link_id: only one of two simultaneous INSERTs for
 * the same link can succeed, so only one request ever proceeds past
 * this point for a given exhausted pool.
 */
async function acquireExpansionClaim(
  db: SupabaseClient,
  linkId: string
): Promise<boolean> {
  const { error } = await db
    .from('bio_page_link_group_pool_claims')
    .insert({ link_id: linkId });
  if (!error) return true;
  if (!isUniqueViolation(error)) {
    console.error(
      '[whatsapp-group-pool] claim insert failed unexpectedly:',
      error
    );
    return false;
  }

  // Someone holds it. If their claim is stale, clear it and take over
  // instead of leaving the pool permanently stuck below capacity.
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const { data: cleared } = await db
    .from('bio_page_link_group_pool_claims')
    .delete()
    .eq('link_id', linkId)
    .lt('claimed_at', staleCutoff)
    .select('link_id');
  if (!cleared || cleared.length === 0) return false; // held, and fresh — back off

  const retry = await db
    .from('bio_page_link_group_pool_claims')
    .insert({ link_id: linkId });
  return !retry.error;
}

async function releaseExpansionClaim(
  db: SupabaseClient,
  linkId: string
): Promise<void> {
  const { error } = await db
    .from('bio_page_link_group_pool_claims')
    .delete()
    .eq('link_id', linkId);
  if (error) {
    console.error('[whatsapp-group-pool] claim release failed:', error.message);
  }
}

/**
 * How full a group is, 0 (empty) to 1 (at capacity) and beyond. A
 * group with no cap is treated as always emptiest (-1) — it can never
 * run out, so it should always be tried before a capped group that
 * might be close to full.
 */
function fillRatio(
  group: Pick<PoolGroupRow, 'participant_count' | 'max_participants'>
): number {
  if (group.max_participants == null) return -1;
  if (group.max_participants <= 0) return Infinity;
  return group.participant_count / group.max_participants;
}

/**
 * Sorts candidates emptiest-first by their last-known (cached) fill
 * level, independent of the pool's display order (bio_page_link_groups
 * .position, which the operator controls in the editor and which
 * cloneIntoPool still uses to pick a template/next name).
 *
 * This is what actually decides which group a visitor lands in —
 * resolveGroupPoolDestination trusts the cache and returns the first
 * candidate with room in THIS order, not the editor's manual position
 * order. The operator no longer controls fill priority by dragging
 * rows; the system picks whichever group currently has the most room,
 * every time, which is also what keeps the redirect itself from ever
 * needing a live UAZAPI call on the common path.
 */
function sortByAvailability<
  T extends Pick<PoolGroupRow, 'participant_count' | 'max_participants'>,
>(groups: T[]): T[] {
  return [...groups].sort((a, b) => fillRatio(a) - fillRatio(b));
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

interface CloneContext {
  db: SupabaseClient;
  linkId: string;
  host: string;
  token: string;
  template: PoolGroupRow;
  created: UazapiGroup;
  adminPhones: string[];
  imageUrl: string | null;
  newName: string;
  nextPosition: number;
}

/** Sends description/picture/announce/locked + admin promotion to the
 *  clone. Best-effort and independent per step — called once right
 *  after creation and again by verifyCloneSetup's retries below, so
 *  every step must be safe to resend (they all are: each just sets a
 *  value or re-promotes a phone number that may already be admin). */
async function applyCloneSettings(
  host: string,
  token: string,
  jid: string,
  template: PoolGroupRow,
  imageUrl: string | null,
  adminPhones: string[]
): Promise<void> {
  const steps = [
    'description',
    'image',
    'announce',
    'locked',
    'promote-admins',
  ] as const;
  const results = await Promise.allSettled([
    template.description
      ? updateGroupDescription(host, token, jid, template.description)
      : Promise.resolve(null),
    imageUrl
      ? updateGroupImage(host, token, jid, imageUrl)
      : Promise.resolve(null),
    template.is_announce
      ? updateGroupAnnounce(host, token, jid, true)
      : Promise.resolve(null),
    template.is_locked
      ? updateGroupLocked(host, token, jid, true)
      : Promise.resolve(null),
    updateGroupParticipants(host, token, {
      groupjid: jid,
      participants: adminPhones,
      action: 'promote',
    }),
  ]);
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(
        `[whatsapp-group-pool] clone step "${steps[i]}" failed for ${jid}:`,
        result.reason
      );
    }
  });
}

/** Re-reads the clone and checks it actually matches the template —
 *  in particular the thing this was built to guarantee: every admin
 *  from the template group is really an admin on the clone. Returns a
 *  human-readable issue per mismatch, empty when everything checks out. */
async function verifyCloneSettings(
  host: string,
  token: string,
  jid: string,
  template: PoolGroupRow,
  adminPhones: string[]
): Promise<string[]> {
  let live: UazapiGroup;
  try {
    live = await getGroupInfo(host, token, jid);
  } catch (err) {
    console.error(
      `[whatsapp-group-pool] verify: getGroupInfo failed for ${jid}:`,
      err
    );
    return [
      'Não foi possível confirmar as configurações do grupo com a UAZAPI.',
    ];
  }

  const issues: string[] = [];
  if (
    template.description &&
    (live.description ?? '') !== template.description
  ) {
    issues.push('A descrição não ficou igual à do grupo modelo.');
  }
  if (template.is_announce && !live.isAnnounce) {
    issues.push(
      'O modo "somente administradores enviam mensagens" não foi ativado.'
    );
  }
  if (template.is_locked && !live.isLocked) {
    issues.push(
      'O bloqueio de edição do grupo (só admin edita) não foi ativado.'
    );
  }
  const liveAdmins = new Set(
    live.participants
      .filter((p) => p.isAdmin || p.isSuperAdmin)
      .map((p) => p.phone)
  );
  const missingAdmins = adminPhones.filter((phone) => !liveAdmins.has(phone));
  if (missingAdmins.length > 0) {
    issues.push(
      `${missingAdmins.length} de ${adminPhones.length} administrador(es) do grupo modelo não ficaram como admin no grupo novo.`
    );
  }
  return issues;
}

/** Broadcasts a 'bio_group_clone_issue' notification to every account
 *  member who can manage groups — same fan-out as notifyAiHandoff's
 *  shared-queue case (src/lib/ai/handoff.ts). Best-effort: a failure
 *  here must not undo anything the clone already accomplished. */
async function notifyCloneIssues(
  db: SupabaseClient,
  accountId: string,
  groupId: string,
  groupName: string,
  issues: string[]
): Promise<void> {
  try {
    const { data: members } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', ['agent', 'admin', 'owner']);
    const recipientIds = (members ?? []).map((m) => m.user_id as string);
    if (recipientIds.length === 0) return;

    const rows = recipientIds.map((userId) => ({
      account_id: accountId,
      user_id: userId,
      type: 'bio_group_clone_issue' as const,
      group_id: groupId,
      title: `Grupo "${groupName}" criado com pendências`,
      body: issues.join(' '),
    }));
    const { error } = await db.from('notifications').insert(rows);
    if (error) {
      console.error(
        '[whatsapp-group-pool] clone-issue notification insert failed:',
        error
      );
    }
  } catch (err) {
    console.error('[whatsapp-group-pool] clone-issue notification threw:', err);
  }
}

// 1 initial apply + up to 2 retries. Each retry re-verifies from
// scratch — WhatsApp's own state can lag a couple of seconds behind a
// mutation, so a "missing admin" on the first check is often just not
// settled yet rather than a real failure.
const MAX_VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_DELAY_MS = 2500;

/**
 * Mirrors the template's settings onto the clone, verifies they
 * actually landed (re-reading the group rather than trusting the
 * mutation calls' own responses), retries whatever didn't, and saves
 * the outcome — all AFTER the visitor already has their invite link
 * (see cloneIntoPool). None of this blocks the redirect.
 *
 * `whatsapp_groups.setup_issues` ends up empty when everything
 * verified clean, or holding whatever's still wrong after the last
 * retry — which also triggers notifyCloneIssues so it doesn't rely on
 * someone happening to open the group to notice.
 */
async function finishCloneInBackground(ctx: CloneContext): Promise<void> {
  const {
    db,
    linkId,
    host,
    token,
    template,
    created,
    adminPhones,
    imageUrl,
    newName,
    nextPosition,
  } = ctx;
  try {
    let issues: string[] = [];
    for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
      await applyCloneSettings(
        host,
        token,
        created.jid,
        template,
        imageUrl,
        adminPhones
      );
      issues = await verifyCloneSettings(
        host,
        token,
        created.jid,
        template,
        adminPhones
      );
      if (issues.length === 0) break;
      if (attempt < MAX_VERIFY_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, VERIFY_RETRY_DELAY_MS)
        );
      }
    }

    const { data: newGroupRow, error: insertGroupError } = await db
      .from('whatsapp_groups')
      .insert({
        account_id: template.account_id,
        whatsapp_config_id: template.whatsapp_config_id,
        group_jid: created.jid,
        name: created.name || newName,
        description: template.description,
        image_url: imageUrl,
        invite_link: created.inviteLink || null,
        participant_count: created.participantCount,
        max_participants: template.max_participants,
        campaign_slug: template.campaign_slug,
        is_announce: template.is_announce,
        is_locked: template.is_locked,
        setup_issues: issues,
        setup_checked_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (insertGroupError || !newGroupRow) {
      console.error(
        '[whatsapp-group-pool] clone created on WhatsApp but failed to save locally:',
        insertGroupError
      );
      return; // nothing to join to the pool — the group still exists on WhatsApp
    }

    const { error: insertPoolError } = await db
      .from('bio_page_link_groups')
      .insert({
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

    if (issues.length > 0) {
      await notifyCloneIssues(
        db,
        template.account_id,
        newGroupRow.id,
        newName,
        issues
      );
    }
  } finally {
    await releaseExpansionClaim(db, linkId);
  }
}

/**
 * Clones `template` into a brand-new WhatsApp group, hands back its
 * invite link as soon as that link exists, and finishes the rest
 * (settings mirror, admin promotion, saving it into the pool) in the
 * background — see finishCloneInBackground.
 *
 * Guarded by acquireExpansionClaim: if another request is already
 * cloning for this exact link, this call returns null immediately
 * (same as "pool exhausted") instead of starting a redundant clone.
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
  if (!(await acquireExpansionClaim(db, linkId))) return null;

  let handedOff = false;
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

    // /group/create's response doesn't reliably carry an invite link
    // (that's opt-in via getInviteLink on /group/info) — fetch it
    // explicitly rather than assume. This is on the critical path: the
    // visitor can't be handed a destination without it.
    const withInvite = await getGroupInfo(host, token, created.jid);
    if (!withInvite.inviteLink) {
      console.error(
        `[whatsapp-group-pool] clone ${created.jid} has no invite link yet`
      );
      return null;
    }

    handedOff = true;
    void finishCloneInBackground({
      db,
      linkId,
      host,
      token,
      template,
      created: withInvite,
      adminPhones,
      imageUrl,
      newName,
      nextPosition,
    });

    return { inviteLink: withInvite.inviteLink };
  } catch (err) {
    console.error('[whatsapp-group-pool] auto-clone failed:', err);
    return null;
  } finally {
    if (!handedOff) await releaseExpansionClaim(db, linkId);
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

  // Trusts the cached DB columns — no live getGroupInfo call per
  // candidate. That used to happen here on every single click (one
  // UAZAPI round trip per candidate walked, worst case one per group
  // in the pool), which is exactly the latency the countdown UI
  // (src/components/bio/bio-page-preview.tsx) exists to paper over.
  // It's safe to trust the cache instead: participant_count is kept
  // current by UAZAPI's own 'groups' webhook on every membership
  // change (src/app/api/whatsapp/uazapi/webhook/[secret]/route.ts,
  // the same value the Grupos do WhatsApp admin screen already
  // displays without polling live), and invite_link only ever changes
  // via an explicit reset action, not on its own. Self-healing (a
  // group that drops back below max_participants becomes eligible
  // again with no extra logic) still holds — it just now runs off the
  // webhook's mirror instead of a live check made at click time.
  //
  // Walked emptiest-first (see sortByAvailability) rather than the
  // editor's display order — `candidates` itself stays in position
  // order below, since cloneIntoPool keys its template/name choice off
  // that, not off current fill level.
  for (const group of sortByAvailability(candidates)) {
    const hasRoom =
      group.max_participants == null ||
      group.participant_count < group.max_participants;
    if (!hasRoom) continue;
    if (!group.invite_link) continue; // no usable destination for this candidate, try next

    return { inviteLink: group.invite_link };
  }

  // Every candidate is full per cached data. Auto-expand the pool by
  // cloning the template (the pool's first entry — the one an
  // operator actually configured) rather than leaving visitors with
  // nowhere to go. Credentials are only resolved down here, on the
  // slow/rare path — the fast path above never needs them.
  let creds: { host: string; token: string } | null = null;
  try {
    creds = await resolveGroupCredentials(db, candidates[0].account_id);
  } catch (err) {
    console.error('[whatsapp-group-pool] resolveGroupCredentials failed:', err);
  }
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
