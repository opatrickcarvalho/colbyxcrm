// ============================================================
// Resolve the app's public-facing base URL from an incoming request.
//
// Extracted from the invitations route (the original owner of this
// logic) after a second, simplified copy in the uazapi connect route
// drifted from it, and a third one was about to be added for the
// admin-impersonation confirm route — see that route's history for
// why this matters: behind a reverse proxy, `new URL(request.url)`
// reflects whatever host Next.js's own server sees, which inside this
// project's Docker image is `0.0.0.0:3000` (Dockerfile sets
// `HOSTNAME=0.0.0.0`), not the public domain. Redirecting a real
// browser to that origin produces an unreachable link.
//
// Resolution order, first match wins:
//
//   1. `NEXT_PUBLIC_SITE_URL` — admin's explicit config. Trumps
//      everything; if you set this, that's where links point.
//   2. `X-Forwarded-Host` (+ `X-Forwarded-Proto`) — set by every
//      reverse proxy in front of the app: Hostinger Managed
//      Node.js, Vercel, Cloudflare, nginx. This is what makes
//      generated links Just Work in production without forcing the
//      operator to set an env var.
//   3. `Host` header + the protocol the request arrived on —
//      bare deployments without a proxy.
//   4. Last-resort marketing-site fallback. Only hit if the
//      request has no Host header at all, which is essentially
//      impossible from a real browser. Logs a warning so the
//      operator can spot the misconfig.
//
// Defense-in-depth: `ALLOWED_INVITE_HOSTS`
//
//   The request-header path (#2 and #3 above) trusts whatever
//   hostname the client (or proxy) puts in the header. On a
//   typical proxied deploy (Vercel / Hostinger / Cloudflare) the
//   proxy overwrites these so they're trustworthy. On a bare
//   deployment exposed to the public internet, an attacker could
//   send a request with a crafted `Host: phishing.example` and
//   receive a link pointing at their site.
//
//   When `ALLOWED_INVITE_HOSTS` is set (comma-separated hostnames),
//   we validate the derived host against the list. Anything not on
//   the list falls through to the marketing-site fallback with a
//   loud console.warn. Kept under its original invite-specific env
//   var name (not renamed to something more generic) so an operator
//   who already set it for invite links doesn't silently lose the
//   protection here too — every caller of this module shares the
//   same trust boundary.
// ============================================================

function parseAllowedHosts(): readonly string[] | null {
  const raw = process.env.ALLOWED_INVITE_HOSTS?.trim();
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function isHostAllowed(
  hostname: string,
  allowList: readonly string[] | null,
): boolean {
  if (!allowList) return true; // No allow-list → permissive (legacy behavior).
  return allowList.includes(hostname.toLowerCase());
}

export function resolvePublicBaseUrl(request: Request, callerTag: string): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const allowList = parseAllowedHosts();
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  if (forwardedHost && isHostAllowed(forwardedHost, allowList)) {
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }

  const host = request.headers.get("host")?.trim();
  if (host && isHostAllowed(host, allowList)) {
    // The protocol on `request.url` is whatever the framework saw —
    // reliable for bare deployments where no proxy is rewriting it.
    const reqProto = new URL(request.url).protocol.replace(":", "");
    return `${reqProto}://${host}`;
  }

  // We fall through here when EITHER no Host header was present at
  // all (essentially impossible from a real browser) OR an
  // ALLOWED_INVITE_HOSTS list was set and neither candidate matched
  // it. The warning is the operator's signal that someone is
  // probing the API with a spoofed Host header — or, far more likely
  // in practice, that NEXT_PUBLIC_SITE_URL just isn't set yet.
  if (allowList && (forwardedHost || host)) {
    console.warn(`[${callerTag}] rejected non-allow-listed host:`, {
      forwardedHost,
      host,
      allowList,
    });
  } else {
    console.warn(
      `[${callerTag}] could not derive base URL from request; falling back to marketing domain`,
    );
  }
  return "https://wacrm.tech";
}
