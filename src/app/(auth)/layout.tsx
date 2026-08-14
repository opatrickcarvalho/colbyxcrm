import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BrandingProvider } from "@/components/branding/branding-context";
import { getBrandingSettings } from "@/lib/branding/get-branding";

// Shared metadata for auth pages (login / signup / forgot-password).
// None of these should be indexed — they'd compete with the marketing
// landing in SERPs and offer nothing to a searcher who hasn't already
// signed up. Each page still gets its own <title> via its own
// metadata.title override below the route group layout.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default async function AuthLayout({ children }: { children: ReactNode }) {
  // Skips the 60s in-process cache — login/signup/forgot-password are
  // low-traffic, logged-out surfaces, so a fresh DB read here is cheap
  // and guarantees a just-saved branding change never shows stale.
  const branding = await getBrandingSettings({ skipCache: true });
  return (
    <BrandingProvider
      value={{ siteName: branding.siteName, logoUrl: branding.logoUrl }}
    >
      {children}
    </BrandingProvider>
  );
}
