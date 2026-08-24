import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie);
    });
    return response;
  };

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (
    user &&
    (request.nextUrl.pathname === '/login' ||
      request.nextUrl.pathname === '/signup' ||
      request.nextUrl.pathname === '/forgot-password')
  ) {
    const url = request.nextUrl.clone();
    const inviteToken = request.nextUrl.searchParams.get('invite');
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`;
      url.search = '';
    } else {
      url.pathname = '/dashboard';
      url.search = '';
    }
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = [
    '/dashboard',
    '/inbox',
    '/contacts',
    '/pipelines',
    '/broadcasts',
    '/automations',
    '/settings',
    '/admin',
    '/scheduled-messages',
    '/groups',
    // Admin CRUD for ad-campaign tracking links (068_ad_campaigns.sql).
    // The public redirect itself, /l/[code], deliberately stays OUTSIDE
    // this list — it's the whole point of that route.
    '/ad-links',
    // The billing page needs a session like any other dashboard
    // route. Note this is the ONLY thing middleware knows about
    // billing: it checks authentication, never entitlement.
    //
    // Entitlement is deliberately NOT checked here. It would need
    // profiles -> accounts on every request the matcher catches
    // (including RSC payloads and prefetches) for zero security —
    // RLS (migration 054) and getCurrentAccount() are the real
    // boundary — and every extra response branch in this file is a
    // withRefreshedCookies() landmine (issue #288). The client shell
    // does the redirect instead, gated on !profileLoading.
    '/billing',
  ];
  if (
    !user &&
    protectedPaths.some((path) => request.nextUrl.pathname.startsWith(path))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // API routes that need auth (not webhooks, not the cron drains — those
  // are hit by an external scheduler with no session and guard themselves
  // with the x-cron-secret header, same as /api/automations/cron and
  // /api/flows/cron outside this prefix).
  //
  // The cron test is a suffix match on purpose. It used to be an
  // `includes('/scheduled-messages/cron')` naming one route, and when
  // group-broadcasts got its own drain the list was not extended — so
  // that endpoint 401'd here before its own secret check could run, and
  // the campaigns never drained. Matching the shape rather than the name
  // means the next drain works the day it is added.
  //
  // The corollary: anything under /api/whatsapp/ ending in /cron is
  // publicly reachable and MUST verify x-cron-secret itself.
  const isCronDrain = /\/cron\/?$/.test(request.nextUrl.pathname);
  if (
    !user &&
    request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
    !request.nextUrl.pathname.includes('/webhook') &&
    !isCronDrain
  ) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
