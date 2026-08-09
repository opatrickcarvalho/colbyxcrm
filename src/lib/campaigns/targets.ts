/**
 * Shared recipient resolution for campaigns and audiences.
 *
 * A campaign target and an audience member are the same shape — one of
 * group_id / contact_id / phone, exactly one non-null (the XOR check in
 * 052_campaigns.sql) — so `POST /api/whatsapp/group-broadcasts` and
 * `POST /api/campaign-audiences` both validate/normalise recipients
 * through this one path instead of re-deriving "does this id belong to
 * this account" twice and drifting apart.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  sanitizePhoneForMeta,
  isValidE164,
  normalizePhone,
} from '@/lib/whatsapp/phone-utils';

export interface RawTargets {
  group_ids?: string[];
  contact_ids?: string[];
  phones?: string[];
}

export interface ResolvedContact {
  id: string;
  name: string | null;
  phone: string;
}

export interface ResolvedTargets {
  groupIds: string[];
  contacts: ResolvedContact[];
  /** Sanitized (digits-only-ish E.164), deduped against each other AND
   *  against `contacts` phones — see the dedupe note below. */
  phones: string[];
}

/** Thrown on any bad/unowned id — routes map this straight to a 400. */
export class TargetValidationError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = 'TargetValidationError';
  }
}

/**
 * Validate every group_id / contact_id belongs to `accountId` (never
 * trust client-supplied ids), normalise `phones`, and de-duplicate a
 * hand-typed phone against a contact already targeted by id so the same
 * person never receives the message twice under two different keys.
 */
export async function resolveTargets(
  supabase: SupabaseClient,
  accountId: string,
  raw: RawTargets
): Promise<ResolvedTargets> {
  const groupIds = Array.from(new Set(raw.group_ids ?? []));
  const contactIds = Array.from(new Set(raw.contact_ids ?? []));
  const rawPhones = raw.phones ?? [];

  // ---- groups ----
  if (groupIds.length > 0) {
    const { data: groups, error } = await supabase
      .from('whatsapp_groups')
      .select('id, status')
      .eq('account_id', accountId)
      .in('id', groupIds);

    if (error) {
      console.error('[campaigns/targets] groups lookup error:', error);
      throw new TargetValidationError('Failed to validate groups');
    }

    const found = new Set((groups ?? []).map((g) => g.id as string));
    const missing = groupIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new TargetValidationError(
        `Groups not found in this account: ${missing.join(', ')}`
      );
    }
    const inactive = (groups ?? [])
      .filter((g) => g.status !== 'active')
      .map((g) => g.id as string);
    if (inactive.length > 0) {
      throw new TargetValidationError(
        `Groups are archived and cannot receive a broadcast: ${inactive.join(', ')}`
      );
    }
  }

  // ---- contacts ----
  let contacts: ResolvedContact[] = [];
  if (contactIds.length > 0) {
    const { data: rows, error } = await supabase
      .from('contacts')
      .select('id, name, phone')
      .eq('account_id', accountId)
      .in('id', contactIds);

    if (error) {
      console.error('[campaigns/targets] contacts lookup error:', error);
      throw new TargetValidationError('Failed to validate contacts');
    }

    const found = new Map(
      (rows ?? []).map((c) => [c.id as string, c as Record<string, unknown>])
    );
    const missing = contactIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new TargetValidationError(
        `Contacts not found in this account: ${missing.join(', ')}`
      );
    }

    contacts = contactIds.map((id) => {
      const row = found.get(id)!;
      return {
        id,
        name: (row.name as string | null) ?? null,
        phone: row.phone as string,
      };
    });
  }

  // ---- phones ----
  // De-duped against each other and against the resolved contacts' own
  // phone numbers — a hand-typed number that happens to match a saved
  // contact must not create a second target for the same person.
  const contactPhoneKeys = new Set(
    contacts.map((c) => normalizePhone(c.phone))
  );
  const seenPhoneKeys = new Set<string>();
  const phones: string[] = [];
  const invalid: string[] = [];

  for (const rawPhone of rawPhones) {
    const sanitized = sanitizePhoneForMeta(rawPhone);
    if (!isValidE164(sanitized)) {
      invalid.push(rawPhone);
      continue;
    }
    const key = normalizePhone(sanitized);
    if (contactPhoneKeys.has(key) || seenPhoneKeys.has(key)) continue;
    seenPhoneKeys.add(key);
    phones.push(sanitized);
  }

  if (invalid.length > 0) {
    throw new TargetValidationError(
      `Invalid phone numbers: ${invalid.join(', ')}`
    );
  }

  return { groupIds, contacts, phones };
}

export function countTargets(t: ResolvedTargets): number {
  return t.groupIds.length + t.contacts.length + t.phones.length;
}

/** First whitespace-delimited token of a name, or '' when there is none. */
export function firstName(name: string | null | undefined): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}
