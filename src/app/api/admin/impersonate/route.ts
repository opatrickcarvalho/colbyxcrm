import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { generateInviteToken } from '@/lib/auth/invitations';

/** How long the "return to admin" capability stays valid. */
const RETURN_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Non-httpOnly — the impersonation banner reads this client-side. */
const FLAG_COOKIE = 'wacrm_impersonating';
/** httpOnly — the only way `/impersonate/end` can restore the admin. */
const RETURN_COOKIE = 'wacrm_impersonate_return';

/**
 * POST /api/admin/impersonate
 *
 * Body: { target_user_id: <uuid> }
 *
 * "Enter as" a customer's user for support. Mechanism: Supabase's
 * admin `generateLink({ type: 'magiclink' })` mints a one-time link
 * that, when the browser navigates to it, establishes a REAL session
 * for that email — this literally becomes the target user's session
 * in the browser's cookie jar (Supabase cookies aren't tab-scoped, so
 * this replaces the admin's own session, not just this tab's).
 *
 * To get back, we don't try to hold two sessions at once — we instead
 * mint a single-use, hashed "return token" now (same token/hash
 * primitive as account_invitations) and stash it in an httpOnly
 * cookie. `/impersonate/end` redeems it — deliberately *not* gated on
 * `requirePlatformAdmin()`, since by the time it's called the caller's
 * session IS the target user, not the admin.
 */
export async function POST(request: Request) {
  try {
    const { userId: adminUserId, supabase } = await requirePlatformAdmin();
    const db = supabaseAdmin();

    const body = await request.json().catch(() => ({}));
    const targetUserId =
      typeof body?.target_user_id === 'string' ? body.target_user_id : null;
    if (!targetUserId) {
      return NextResponse.json(
        { error: 'target_user_id is required' },
        { status: 400 }
      );
    }

    const { data: target, error: targetErr } = await db
      .from('profiles')
      .select('user_id, email, account_id, is_platform_admin')
      .eq('user_id', targetUserId)
      .maybeSingle();
    if (targetErr || !target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    // Never impersonate another platform admin — this is a support
    // tool for customer accounts, not a way to escalate between
    // operators.
    if (target.is_platform_admin) {
      return NextResponse.json(
        { error: 'Cannot impersonate a platform admin' },
        { status: 403 }
      );
    }

    // The admin's own email, for the return link — a self-row read via
    // the RLS client always succeeds regardless of the admin's own
    // tenant account status.
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('email')
      .eq('user_id', adminUserId)
      .maybeSingle();
    if (!adminProfile?.email) {
      return NextResponse.json(
        { error: 'Could not resolve admin email' },
        { status: 500 }
      );
    }

    const origin = new URL(request.url).origin;

    const { data: linkData, error: linkErr } = await db.auth.admin.generateLink({
      type: 'magiclink',
      email: target.email,
      options: { redirectTo: `${origin}/dashboard` },
    });
    if (linkErr || !linkData?.properties?.action_link) {
      console.error('[admin/impersonate] generateLink failed:', linkErr);
      return NextResponse.json(
        { error: 'Failed to create impersonation link' },
        { status: 502 }
      );
    }

    const { token, hash } = generateInviteToken();
    const expiresAt = new Date(Date.now() + RETURN_TOKEN_TTL_MS);

    const { error: sessionErr } = await db
      .from('admin_impersonation_sessions')
      .insert({
        admin_user_id: adminUserId,
        target_user_id: targetUserId,
        target_account_id: target.account_id,
        return_token_hash: hash,
        expires_at: expiresAt.toISOString(),
      });
    if (sessionErr) {
      console.error('[admin/impersonate] session insert failed:', sessionErr);
      return NextResponse.json(
        { error: 'Failed to start impersonation session' },
        { status: 500 }
      );
    }

    await db.from('admin_audit_log').insert({
      admin_user_id: adminUserId,
      action: 'impersonate_start',
      target_account_id: target.account_id,
      target_user_id: targetUserId,
      metadata: { target_email: target.email },
    });

    const cookieStore = await cookies();
    const isProd = process.env.NODE_ENV === 'production';
    cookieStore.set(RETURN_COOKIE, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: RETURN_TOKEN_TTL_MS / 1000,
    });
    cookieStore.set(FLAG_COOKIE, target.email, {
      httpOnly: false,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: RETURN_TOKEN_TTL_MS / 1000,
    });

    return NextResponse.json({ redirectUrl: linkData.properties.action_link });
  } catch (err) {
    return toErrorResponse(err);
  }
}
