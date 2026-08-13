// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// IMPORTANT: this module is server-only. It imports the Supabase
// SSR client (`@/lib/supabase/server`), which reads `next/headers`
// cookies. Importing it from a client component will fail at
// build time with the standard Next.js "You're importing a
// component that needs `next/headers`" error — that's the
// boundary check; we don't need the `server-only` package.
//
// Calling convention
// ------------------
// API routes don't need to redo `supabase.auth.getUser()` — they
// receive a fully-loaded context from `requireRole`:
//
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.supabase — the SSR client (RLS scoped to this user)
//     // ctx.userId  — auth.uid()
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return errorResponse(err); // see toErrorResponse() below
//   }
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { isEntitled, type BillingSnapshot } from '@/lib/billing/entitlement';
import { getBillingSettings } from '@/lib/billing/platform-settings';
import { hasMinRole, isAccountRole, type AccountRole } from './roles';

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Thrown by `getCurrentAccount()` when the caller's account has been
 * suspended by a platform admin (migration 040, `accounts.status`).
 * Kept distinct from `ForbiddenError` so `toErrorResponse()` can put a
 * machine-readable `code` on the response — the composer already
 * reads a code field this way for `ai_not_configured`, same pattern.
 */
export class AccountSuspendedError extends Error {
  readonly status = 403 as const;
  constructor(message = 'This account has been suspended') {
    super(message);
    this.name = 'AccountSuspendedError';
  }
}

/**
 * Thrown by `getCurrentAccount()` when the caller's account has no
 * active plan (migration 053, `accounts.plan_expires_at`).
 *
 * 402 rather than 403 on purpose: a client can branch on the status
 * alone without parsing `code`, and — more importantly — the blocked
 * state is unmistakable in logs. The RLS gate that backs this up
 * (migration 054) denies by returning EMPTY RESULT SETS, not errors,
 * so a distinctive status is the only thing that lets support tell
 * "unpaid" apart from "data loss".
 *
 * Kept distinct from `AccountSuspendedError`: suspension is an
 * operator action against abuse, non-payment is a billing state. The
 * two must never collapse into one check — see the comment in the
 * inbound WhatsApp webhooks for why that distinction protects
 * customer data.
 */
export class AccountNotEntitledError extends Error {
  readonly status = 402 as const;
  constructor(message = 'This account has no active plan') {
    super(message);
    this.name = 'AccountNotEntitledError';
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Routes can do:
 *
 *   } catch (err) {
 *     return toErrorResponse(err);
 *   }
 *
 * Unknown errors collapse to 500 with the generic message — we
 * never leak `err.message` for non-classified errors to keep
 * server internals out of the wire.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AccountNotEntitledError) {
    return NextResponse.json(
      { error: err.message, code: 'account_not_entitled' },
      { status: err.status }
    );
  }
  if (err instanceof AccountSuspendedError) {
    return NextResponse.json(
      { error: err.message, code: 'account_suspended' },
      { status: err.status }
    );
  }
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error('[toErrorResponse] uncategorized error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
  /**
   * Billing snapshot from the same `accounts` row (migration 053).
   * `entitled` is the computed answer; the rest is for the /billing
   * page and the admin panel. On a deployment that has not run 053
   * the columns come back undefined and `entitled` is true — see the
   * fail-open note in src/lib/billing/entitlement.ts.
   */
  billing: {
    status: string | null;
    planId: string | null;
    planExpiresAt: string | null;
    trialEndsAt: string | null;
    exempt: boolean;
    entitled: boolean;
  };
}

export interface AccountContextOptions {
  /**
   * Resolve the context even when the account has no active plan,
   * instead of throwing `AccountNotEntitledError`.
   *
   * ONLY `/api/billing/*` may pass this: a customer who is locked
   * out still has to read their own billing state, pick a plan and
   * pay. Everything else must stay gated, or the block is cosmetic.
   */
  allowUnentitled?: boolean;
}

/**
 * Resolve the caller's user + account + role in one round trip.
 *
 * Throws `UnauthorizedError` if there's no Supabase session.
 * Throws `ForbiddenError` if the profile is missing account
 * fields (shouldn't happen post-017 migration; defensive guard
 * against profile rows that pre-date the backfill or were
 * inserted by hand).
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(
  opts: AccountContextOptions = {}
): Promise<AccountContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[getCurrentAccount] profile fetch error:', error);
    throw new ForbiddenError('Could not load account context');
  }
  if (!data || !data.account_id || !data.account_role) {
    // Pre-migration profile, or a manual insert that skipped the
    // signup trigger. The user is authenticated but the app has
    // no way to scope their queries — treat as forbidden.
    throw new ForbiddenError('Profile is not linked to an account');
  }
  if (!isAccountRole(data.account_role)) {
    // The DB enum should make this impossible, but a future
    // migration that broadens the enum without updating TS would
    // hit this — surface it rather than silently widening.
    throw new ForbiddenError(`Unknown account role: ${data.account_role}`);
  }

  // Load the account with a plain point lookup by id rather than an
  // embedded FK join (`account:accounts!inner(...)`). The embed forces
  // PostgREST to resolve the profiles.account_id → accounts.id
  // relationship from its schema cache; when that cache is stale — a
  // common Supabase state right after a migration adds the FK, or when
  // migrations are applied out of band — the embed fails hard with
  // PGRST200 ("could not find a relationship … in the schema cache")
  // and takes down the entire account context (issue #294). A lookup by
  // id needs no relationship inference and is gated by the same accounts
  // RLS, so it stays robust against cache staleness and older schemas.
  //
  // The billing columns (migration 053) ride along on this SAME
  // lookup — no second round trip, and still no embed, so the
  // PGRST200 reasoning above keeps holding.
  const { data: account, error: accountErr } = await supabase
    .from('accounts')
    .select(
      'id, name, status, billing_status, plan_id, plan_expires_at, trial_ends_at, billing_exempt'
    )
    .eq('id', data.account_id)
    .maybeSingle();

  if (accountErr) {
    console.error('[getCurrentAccount] account fetch error:', accountErr);
    throw new ForbiddenError('Could not load account context');
  }
  if (!account) {
    // account_id points at no readable account row — orphaned profile
    // or an RLS gap. Same "can't scope this user" outcome as above.
    throw new ForbiddenError('Profile is not linked to an account');
  }
  if (account.status === 'suspended') {
    throw new AccountSuspendedError();
  }

  // Suspension is checked first and separately: an operator-suspended
  // account should read as suspended even if it also happens to be
  // unpaid, because that's the actionable fact for support.
  const snapshot: BillingSnapshot = {
    billing_status: account.billing_status,
    plan_id: account.plan_id,
    plan_expires_at: account.plan_expires_at,
    trial_ends_at: account.trial_ends_at,
    billing_exempt: account.billing_exempt,
  };
  const entitled = isEntitled(snapshot, await getBillingSettings());
  if (!entitled && !opts.allowUnentitled) {
    throw new AccountNotEntitledError();
  }

  return {
    supabase,
    userId: user.id,
    accountId: data.account_id,
    role: data.account_role,
    account: { id: account.id, name: account.name },
    billing: {
      status: account.billing_status ?? null,
      planId: account.plan_id ?? null,
      planExpiresAt: account.plan_expires_at ?? null,
      trialEndsAt: account.trial_ends_at ?? null,
      // `=== true`, not truthiness: a pre-053 schema returns
      // undefined and must not read as a definite "not exempt".
      exempt: account.billing_exempt === true,
      entitled,
    },
  };
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(
  min: AccountRole,
  opts: AccountContextOptions = {}
): Promise<AccountContext> {
  const ctx = await getCurrentAccount(opts);
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`
    );
  }
  return ctx;
}
