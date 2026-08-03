import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/admin/impersonate/confirm?token_hash=...&redirect=/dashboard
 *
 * Completes a session swap started by `/api/admin/impersonate` or
 * `/api/admin/impersonate/end`.
 *
 * Why this route exists instead of navigating straight to Supabase's
 * own `action_link`: that link delivers the new session as a URL
 * *fragment* (`#access_token=...`), which the browser never sends to
 * the server — Next.js middleware runs on every navigation and only
 * ever sees cookies, so it kept reading the OLD session and the swap
 * never actually took effect server-side (the bug the operator hit —
 * the UI kept showing the admin's own account after "Entrar como").
 *
 * The fix is the pattern Supabase's own docs recommend for
 * `@supabase/ssr` apps: pass just the `token_hash` around, and
 * exchange it with `verifyOtp()` on a request bound to the SSR
 * server client (`@/lib/supabase/server`) — its cookie adapter writes
 * real `Set-Cookie` headers on this response, which middleware and
 * every subsequent request can actually see.
 *
 * Deliberately not gated on `requirePlatformAdmin()` — a `token_hash`
 * is itself the credential (single-use, short-lived, minted only by
 * the already-gated POST routes), same trust model as any emailed
 * magic link.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get('token_hash');
  const redirectPath = searchParams.get('redirect') || '/dashboard';

  if (!tokenHash) {
    return NextResponse.redirect(new URL('/login', origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    type: 'magiclink',
    token_hash: tokenHash,
  });

  if (error) {
    console.error('[admin/impersonate/confirm] verifyOtp failed:', error.message);
    return NextResponse.redirect(new URL('/login', origin));
  }

  return NextResponse.redirect(new URL(redirectPath, origin));
}
