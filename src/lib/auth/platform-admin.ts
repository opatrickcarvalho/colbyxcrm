// ============================================================
// Platform-admin context — for the operator's `/admin/*` control
// plane, not a customer's account. Distinct from `account.ts`'s
// `requireRole()`: that resolves a user's role *within their own
// account*; this checks a flag that has nothing to do with any
// account membership at all.
//
// `is_platform_admin` (migration 040) is never settable from the app
// — only a one-off manual `UPDATE profiles SET is_platform_admin =
// true WHERE user_id = ...` run by hand. No route here or anywhere
// else grants it, on yourself or anyone else.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { UnauthorizedError, ForbiddenError } from "./account";

export interface PlatformAdminContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. */
  userId: string;
}

/**
 * Resolve the caller and verify they're a platform admin.
 *
 * Throws `UnauthorizedError` if there's no session, `ForbiddenError`
 * if the session is valid but the caller isn't a platform admin.
 *
 * The `is_platform_admin` read is a self-row lookup (`user_id =
 * auth.uid()`), which `profiles_select`'s RLS policy always allows
 * regardless of account status — so this works even if the admin's
 * own tenant account happens to be suspended.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("is_platform_admin")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[requirePlatformAdmin] profile fetch error:", error);
    throw new ForbiddenError("Could not verify platform admin status");
  }
  if (!data?.is_platform_admin) {
    throw new ForbiddenError("Platform admin access required");
  }

  return { supabase, userId: user.id };
}
