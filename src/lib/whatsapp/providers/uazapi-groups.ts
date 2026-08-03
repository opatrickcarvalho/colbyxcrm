// ============================================================
// UAZAPI group management — the `/group/*` slice of the vendored
// OpenAPI spec (`uazapi-openapi-spec.yaml`, tag "Grupos e
// Comunidades"). Meta's Cloud API has no group surface at all, so
// these functions are called directly (never through the shared
// `WhatsAppProvider` interface in `types.ts`, which both backends
// implement) — same pattern as `fetchChatAvatar` in `uazapi.ts`.
//
// Response envelopes are inconsistent across endpoints (some return
// the Group object directly, some nest it under `group`, one nests
// it under a capitalised `InviteLink`) — `readGroup` normalises that
// the same way `readInstance` does for the instance-lifecycle calls.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { uazapiFetch } from './uazapi';

/** Thrown when the account has no live UAZAPI connection — group
 *  management has no Meta equivalent, so there's nothing to fall back to. */
export class GroupsNotAvailableError extends Error {
  constructor() {
    super('Group management requires a UAZAPI-connected WhatsApp number.');
    this.name = 'GroupsNotAvailableError';
  }
}

/**
 * Load + decrypt the account's UAZAPI credentials for a group action.
 * Every `/api/whatsapp/groups/**` route calls this first so the same
 * "not on UAZAPI" / "not connected yet" check doesn't get re-derived
 * four different ways across the route files.
 */
export async function resolveGroupCredentials(
  supabase: SupabaseClient,
  accountId: string
): Promise<{ host: string; token: string; configId: string }> {
  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('id, provider, uazapi_host, uazapi_instance_token')
    .eq('account_id', accountId)
    .maybeSingle();

  if (
    !config ||
    config.provider !== 'uazapi' ||
    !config.uazapi_host ||
    !config.uazapi_instance_token
  ) {
    throw new GroupsNotAvailableError();
  }

  return {
    host: config.uazapi_host as string,
    token: decrypt(config.uazapi_instance_token as string),
    configId: config.id as string,
  };
}

export interface UazapiGroupParticipant {
  jid: string;
  phone: string;
  displayName?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface UazapiGroup {
  jid: string;
  name: string;
  description?: string;
  inviteLink?: string;
  isAnnounce: boolean;
  isLocked: boolean;
  participants: UazapiGroupParticipant[];
  participantCount: number;
}

function readGroup(payload: unknown): UazapiGroup {
  const root = (payload ?? {}) as Record<string, unknown>;
  const nested = (root.group ?? root) as Record<string, unknown>;
  const participantsRaw = (nested.Participants ??
    nested.participants ??
    []) as Array<Record<string, unknown>>;

  const participants: UazapiGroupParticipant[] = participantsRaw.map((p) => ({
    jid: String(p.JID ?? p.jid ?? ''),
    phone: String(p.PhoneNumber ?? p.phone ?? ''),
    displayName: (p.DisplayName as string) || undefined,
    isAdmin: Boolean(p.IsAdmin ?? p.isAdmin ?? false),
    isSuperAdmin: Boolean(p.IsSuperAdmin ?? p.isSuperAdmin ?? false),
  }));

  return {
    jid: String(nested.JID ?? nested.jid ?? ''),
    name: String(nested.Name ?? nested.name ?? ''),
    description: (nested.Topic as string) || (nested.description as string) || undefined,
    inviteLink:
      (root.InviteLink as string) ||
      (nested.invite_link as string) ||
      (nested.inviteLink as string) ||
      undefined,
    isAnnounce: Boolean(nested.IsAnnounce ?? nested.isAnnounce ?? false),
    isLocked: Boolean(nested.IsLocked ?? nested.isLocked ?? false),
    participants,
    participantCount: participants.length,
  };
}

export interface CreateGroupParams {
  name: string;
  /** Phone numbers without formatting (digits only), 1-50 entries. */
  participants: string[];
}

export async function createGroup(
  host: string,
  token: string,
  params: CreateGroupParams
): Promise<UazapiGroup> {
  const payload = await uazapiFetch<unknown>({
    host,
    path: '/group/create',
    auth: { kind: 'token', value: token },
    body: params,
  });
  return readGroup(payload);
}

export async function listGroups(
  host: string,
  token: string,
  opts?: { force?: boolean; noparticipants?: boolean }
): Promise<UazapiGroup[]> {
  const params = new URLSearchParams();
  if (opts?.force) params.set('force', 'true');
  if (opts?.noparticipants) params.set('noparticipants', 'true');
  const qs = params.toString();

  const payload = await uazapiFetch<{ groups?: unknown[] }>({
    host,
    path: `/group/list${qs ? `?${qs}` : ''}`,
    auth: { kind: 'token', value: token },
    method: 'GET',
  });
  return (payload?.groups ?? []).map((g) => readGroup(g));
}

export async function getGroupInfo(
  host: string,
  token: string,
  groupjid: string
): Promise<UazapiGroup> {
  const payload = await uazapiFetch<unknown>({
    host,
    path: '/group/info',
    auth: { kind: 'token', value: token },
    body: { groupjid, getInviteLink: true },
  });
  return readGroup(payload);
}

/** Returns the new invite link plus the group's refreshed state. */
export async function resetGroupInviteCode(
  host: string,
  token: string,
  groupjid: string
): Promise<{ inviteLink: string; group: UazapiGroup }> {
  const payload = await uazapiFetch<{ InviteLink?: string }>({
    host,
    path: '/group/resetInviteCode',
    auth: { kind: 'token', value: token },
    body: { groupjid },
  });
  return { inviteLink: payload?.InviteLink ?? '', group: readGroup(payload) };
}

export async function updateGroupName(
  host: string,
  token: string,
  groupjid: string,
  name: string
): Promise<UazapiGroup> {
  const payload = await uazapiFetch<unknown>({
    host,
    path: '/group/updateName',
    auth: { kind: 'token', value: token },
    body: { groupjid, name },
  });
  return readGroup(payload);
}

export async function updateGroupDescription(
  host: string,
  token: string,
  groupjid: string,
  description: string
): Promise<UazapiGroup> {
  const payload = await uazapiFetch<unknown>({
    host,
    path: '/group/updateDescription',
    auth: { kind: 'token', value: token },
    body: { groupjid, description },
  });
  return readGroup(payload);
}

/** `image` is a URL, a base64 data URI, or "remove"/"delete" to clear it. */
export async function updateGroupImage(
  host: string,
  token: string,
  groupjid: string,
  image: string
): Promise<UazapiGroup> {
  const payload = await uazapiFetch<unknown>({
    host,
    path: '/group/updateImage',
    auth: { kind: 'token', value: token },
    body: { groupjid, image },
  });
  return readGroup(payload);
}

export async function updateGroupAnnounce(
  host: string,
  token: string,
  groupjid: string,
  announce: boolean
): Promise<UazapiGroup> {
  const payload = await uazapiFetch<unknown>({
    host,
    path: '/group/updateAnnounce',
    auth: { kind: 'token', value: token },
    body: { groupjid, announce },
  });
  return readGroup(payload);
}

export async function updateGroupLocked(
  host: string,
  token: string,
  groupjid: string,
  locked: boolean
): Promise<UazapiGroup> {
  const payload = await uazapiFetch<unknown>({
    host,
    path: '/group/updateLocked',
    auth: { kind: 'token', value: token },
    body: { groupjid, locked },
  });
  return readGroup(payload);
}

export type GroupParticipantAction = 'add' | 'remove' | 'promote' | 'demote';

export interface UpdateGroupParticipantsParams {
  groupjid: string;
  /** Phone numbers (international format, no "+") or JIDs. */
  participants: string[];
  action: GroupParticipantAction;
}

export interface UpdateGroupParticipantsResult {
  group: UazapiGroup;
  /** Per-participant outcome — `error === 0` means success. */
  results: Array<{ jid: string; error: number }>;
}

export async function updateGroupParticipants(
  host: string,
  token: string,
  params: UpdateGroupParticipantsParams
): Promise<UpdateGroupParticipantsResult> {
  const payload = await uazapiFetch<{
    groupUpdated?: Array<{ JID?: string; Error?: number }>;
  }>({
    host,
    path: '/group/updateParticipants',
    auth: { kind: 'token', value: token },
    body: params,
  });
  return {
    group: readGroup(payload),
    results: (payload?.groupUpdated ?? []).map((r) => ({
      jid: String(r.JID ?? ''),
      error: r.Error ?? 0,
    })),
  };
}

export async function leaveGroup(
  host: string,
  token: string,
  groupjid: string
): Promise<void> {
  await uazapiFetch<unknown>({
    host,
    path: '/group/leave',
    auth: { kind: 'token', value: token },
    body: { groupjid },
  });
}
