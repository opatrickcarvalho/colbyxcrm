import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

// Locales a user can actually pick in Settings → Appearance. Keep this
// in sync with the CHECK constraint on profiles.locale (migration 039)
// and with the options in src/components/settings/appearance-panel.tsx.
const SUPPORTED_LOCALES = ['en', 'pt-BR'] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function isSupportedLocale(
  value: string | undefined
): value is SupportedLocale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export default getRequestConfig(async () => {
  // Priority: the NEXT_LOCALE cookie (set when a signed-in user picks a
  // language, and synced from their saved profile preference by
  // useAuth on login) → the NEXT_PUBLIC_APP_LOCALE env var (kept for
  // deployment-level overrides) → 'pt-BR', since that's the primary
  // audience for this CRM.
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get('NEXT_LOCALE')?.value;
  const envLocale = process.env.NEXT_PUBLIC_APP_LOCALE;

  const locale = isSupportedLocale(cookieLocale)
    ? cookieLocale
    : isSupportedLocale(envLocale)
      ? envLocale
      : 'pt-BR';

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch (error) {
    // Fallback to Portuguese if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/pt-BR.json`)).default;
  }

  return {
    locale,
    messages,
  };
});
