import Link from 'next/link';
import {
  ArrowLeft,
  CreditCard,
  Palette,
  Settings,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';

/**
 * Shell for the platform-admin console.
 *
 * `/admin` deliberately sits outside the `(dashboard)` route group — the
 * operator's control plane is not a tenant surface and must not inherit
 * the account-scoped sidebar. The side effect was that it inherited no
 * navigation at all, leaving no way back to the CRM short of editing the
 * URL. This adds the one link that was missing, and nothing else.
 *
 * Not an authorization boundary: `requirePlatformAdmin()` guards every
 * `/api/admin/*` call, and the page bounces on a 401/403 from those.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = await getTranslations('Admin.shell');

  return (
    <div className="bg-background min-h-screen">
      <header className="border-border bg-card/95 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex items-center gap-2">
              <ShieldAlert className="text-primary h-5 w-5 shrink-0" />
              <span className="text-foreground truncate text-sm font-semibold">
                {t('title')}
              </span>
            </div>
            <nav className="flex items-center gap-1">
              <Link
                href="/admin"
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors"
              >
                <Users className="h-4 w-4" />
                {t('navAccounts')}
              </Link>
              <Link
                href="/admin/plans"
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors"
              >
                <CreditCard className="h-4 w-4" />
                {t('navPlans')}
              </Link>
              <Link
                href="/admin/settings"
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors"
              >
                <Settings className="h-4 w-4" />
                {t('navSettings')}
              </Link>
              <Link
                href="/admin/branding"
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors"
              >
                <Palette className="h-4 w-4" />
                {t('navBranding')}
              </Link>
            </nav>
          </div>
          <Link
            href="/dashboard"
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('backToCrm')}
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
