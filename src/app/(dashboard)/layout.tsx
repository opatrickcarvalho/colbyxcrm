import type { Metadata } from "next";
import { DashboardShell } from "./dashboard-shell";
import { BrandingProvider } from "@/components/branding/branding-context";
import { getBrandingSettings } from "@/lib/branding/get-branding";

// Server layout whose only job is to declare "do not index" metadata
// for the authed app. robots.ts already disallows these paths at the
// crawler-level and middleware redirects unauthenticated visitors, so
// this is belt-and-suspenders — but SEO-critical if a URL ever leaks
// via a link shared externally.
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

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const branding = await getBrandingSettings();
  return (
    <BrandingProvider
      value={{ siteName: branding.siteName, logoUrl: branding.logoUrl }}
    >
      <DashboardShell>{children}</DashboardShell>
    </BrandingProvider>
  );
}
