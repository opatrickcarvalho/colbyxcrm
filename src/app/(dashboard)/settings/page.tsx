'use client';

import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { getCapabilities } from '@/lib/whatsapp/providers/capabilities';
import { isProviderId } from '@/lib/whatsapp/providers/types';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
import { TemplateManager } from '@/components/settings/template-manager';
import { QuickRepliesManager } from '@/components/settings/quick-replies-manager';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { DealsSettings } from '@/components/settings/deals-settings';
import { GroupBroadcastSettings } from '@/components/settings/group-broadcast-settings';
import { MembersTab } from '@/components/settings/members-tab';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import {
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

// `useSearchParams` opts this page out of static prerendering unless it
// sits under a Suspense boundary. Without one, the production build hits
// the "missing Suspense with CSR bailout" error and the whole page bails
// to client-side rendering — shipping a settings screen whose rail never
// wires up its click handlers. You land on the section the URL carried
// (the account-menu Settings link points at `?tab=whatsapp`) and can't
// navigate away. Mirror the login/signup split: a thin wrapper supplies
// the boundary; the inner component reads the query string.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency } = useAuth();
  const { mode } = useTheme();
  const t = useTranslations('Settings');

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const section = resolveSection(searchParams.get('tab'));

  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // `null` until the account's provider config resolves. Templates is a
  // Meta-only concept (pre-approved message templates for the 24h
  // customer-service window) — UAZAPI has no such feature, so the tab
  // is hidden rather than shown-but-broken for those accounts.
  const [templatesEnabled, setTemplatesEnabled] = useState<boolean | null>(
    null,
  );
  // Group broadcasts are UAZAPI-only (Meta has no group support at
  // all — see src/lib/whatsapp/providers/capabilities.ts). Same
  // "hide rather than show-but-broken" treatment as `templatesEnabled`.
  const [groupsEnabled, setGroupsEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadCapabilities = async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data: profile } = await supabase
        .from('profiles')
        .select('account_id')
        .eq('user_id', user.id)
        .maybeSingle();
      const accountId = profile?.account_id as string | undefined;
      if (!accountId) return;

      const { data: config } = await supabase
        .from('whatsapp_config')
        .select('provider')
        .eq('account_id', accountId)
        .maybeSingle();

      if (cancelled) return;
      const capabilities = getCapabilities(
        isProviderId(config?.provider) ? config.provider : 'meta',
      );
      setTemplatesEnabled(capabilities.templates);
      setGroupsEnabled(capabilities.groups);
    };
    loadCapabilities();
    return () => {
      cancelled = true;
    };
  }, []);

  // Defend against a stale/bookmarked `?tab=templates` (or
  // `?tab=group-broadcasts`) link on an account whose provider doesn't
  // support that capability.
  useEffect(() => {
    if (templatesEnabled === false && section === 'templates') {
      go('overview');
    }
    if (groupsEnabled === false && section === 'group-broadcasts') {
      go('overview');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templatesEnabled, groupsEnabled, section]);

  const hiddenSections = useMemo(() => {
    const hidden: SettingsSection[] = [];
    if (templatesEnabled === false) hidden.push('templates');
    if (groupsEnabled === false) hidden.push('group-broadcasts');
    return hidden;
  }, [templatesEnabled, groupsEnabled]);

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    whatsapp: <WhatsAppConfig />,
    templates: <TemplateManager />,
    'quick-replies': <QuickRepliesManager />,
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    'group-broadcasts': <GroupBroadcastSettings />,
    members: <MembersTab />,
    api: <ApiKeysSettings />,
  };

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('pageTitle')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('pageDesc')}
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail
          active={section}
          onSelect={go}
          hints={hints}
          hiddenSections={hiddenSections}
        />
        <div className="min-w-0">{panel[section]}</div>
      </div>
    </div>
  );
}
