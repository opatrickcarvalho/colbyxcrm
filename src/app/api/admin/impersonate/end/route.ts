import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { hashInviteToken } from '@/lib/auth/invitations';

const FLAG_COOKIE = 'wacrm_impersonating';
const RETURN_COOKIE = 'wacrm_impersonate_return';

/**
 * POST /api/admin/impersonate/end
 *
 * Deliberately NOT gated on `requirePlatformAdmin()` — by the time
 * this is called, the caller's Supabase session IS the impersonated
 * target user, not the admin. The httpOnly return-token cookie is the
 * only credential this route trusts: possession of it proves an
 * impersonation was legitimately started from this browser, within
 * its TTL, and not already redeemed.
 *
 * If the cookie is missing/expired/already used, there is no way back
 * through this route — the operator has to log in again as
 * themselves, same as anyone else. That degraded path is acceptable
 * for a support tool; it's not a security hole (nothing here regrants
 * access to someone who lost the token).
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(RETURN_COOKIE)?.value;

  // Clear cookies unconditionally — even on failure, an unusable
  // impersonation cookie shouldn't linger.
  cookieStore.delete(RETURN_COOKIE);
  cookieStore.delete(FLAG_COOKIE);

  if (!rawToken) {
    return NextResponse.json(
      { error: 'No active impersonation session found' },
      { status: 400 }
    );
  }

  const db = supabaseAdmin();
  const hash = hashInviteToken(rawToken);

  const { data: session, error: sessionErr } = await db
    .from('admin_impersonation_sessions')
    .select('id, admin_user_id, target_account_id, target_user_id, status, expires_at')
    .eq('return_token_hash', hash)
    .maybeSingle();

  if (sessionErr || !session || session.status !== 'active') {
    return NextResponse.json(
      { error: 'Impersonation session not found or already ended' },
      { status: 400 }
    );
  }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await db
      .from('admin_impersonation_sessions')
      .update({ status: 'expired' })
      .eq('id', session.id);
    return NextResponse.json(
      { error: 'Impersonation session expired — please log in again' },
      { status: 410 }
    );
  }

  const { data: adminProfile } = await db
    .from('profiles')
    .select('email')
    .eq('user_id', session.admin_user_id)
    .maybeSingle();
  if (!adminProfile?.email) {
    return NextResponse.json(
      { error: 'Could not resolve admin account' },
      { status: 500 }
    );
  }

  const origin = new URL(request.url).origin;

  const { data: linkData, error: linkErr } = await db.auth.admin.generateLink({
    type: 'magiclink',
    email: adminProfile.email,
    options: { redirectTo: `${origin}/admin` },
  });
  if (linkErr || !linkData?.properties?.action_link) {
    console.error('[admin/impersonate/end] generateLink failed:', linkErr);
    return NextResponse.json(
      { error: 'Failed to restore admin session' },
      { status: 502 }
    );
  }

  await db
    .from('admin_impersonation_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', session.id);

  await db.from('admin_audit_log').insert({
    admin_user_id: session.admin_user_id,
    action: 'impersonate_end',
    target_account_id: session.target_account_id,
    target_user_id: session.target_user_id,
    metadata: {},
  });

  return NextResponse.json({ redirectUrl: linkData.properties.action_link });
}
