import { ImageResponse } from "next/og";
import { getBrandingIconBytes } from "@/lib/branding/get-branding";

// Replaces the default Next.js favicon with the brand mark — Hostinger
// violet rounded square + white chat-square glyph — matching the
// sidebar logo in `src/components/layout/sidebar.tsx`. Next.js renders
// this at build time and auto-injects <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).
//
// `dynamic = "force-dynamic"` opts this out of Next's default static
// caching for icon route handlers, so a superadmin-uploaded favicon
// (see src/lib/branding/get-branding.ts) is picked up without a
// redeploy — bounded by that helper's own 60s in-process cache, so
// this doesn't add a DB/Storage round trip to every favicon request.

export const runtime = "edge";
export const dynamic = "force-dynamic";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default async function Icon() {
  const custom = await getBrandingIconBytes();
  if (custom) {
    return new Response(custom.bytes, {
      headers: { "Content-Type": custom.contentType },
    });
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#7c3aed", // primary (Hostinger-aligned purple)
          borderRadius: 6,
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
