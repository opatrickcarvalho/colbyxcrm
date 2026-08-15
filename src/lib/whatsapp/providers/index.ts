// ============================================================
// Provider factory — the one place that turns a `whatsapp_config` row
// into a bound `WhatsAppProvider`.
//
// Two entry points, because the call sites differ:
//
//   getProvider(db, accountId)  — loads the row itself. Use it when
//                                 you only need to send.
//   createProvider(config)      — for callers that already hold the
//                                 row (broadcast needs `config.id`,
//                                 send-message self-heals a legacy
//                                 ciphertext). Avoids a second query.
//
// Decryption lives here so no call site has to remember that the
// stored token is ciphertext.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { createMetaProvider } from './meta';
import { createUazapiProvider } from './uazapi';
import {
  isProviderId,
  type ProviderConfigRow,
  type ProviderId,
  type WhatsAppProvider,
} from './types';

export * from './types';
export { META_CAPABILITIES } from './meta';
export {
  UAZAPI_CAPABILITIES,
  UazapiError,
  UazapiNotEnabledError,
  isUazapiEnabled,
  uazapiHost,
  createInstance,
  connectInstance,
  instanceStatus,
  disconnectInstance,
  registerWebhook,
  readWebhooks,
  missingWebhookEvents,
  getWebhookErrors,
  type UazapiWebhookError,
  webhookRegistrationFingerprint,
  WEBHOOK_EVENTS,
  type UazapiWebhookRegistration,
  setInstancePresence,
  getInstancePrivacy,
  setInstancePrivacy,
  checkNumber,
  markMessagesRead,
  markChatRead,
  type UazapiPrivacy,
  type UazapiNumberCheck,
  listLabels,
  editLabel,
  setChatLabels,
  type UazapiInstance,
  type UazapiStatus,
  type UazapiLabel,
} from './uazapi';

/**
 * Raised when an account has no usable WhatsApp connection — either no
 * config row at all, or a row missing the credentials its provider
 * needs. Callers map it to their own error shape (a 400
 * `whatsapp_not_configured` on the dashboard, the v1 envelope on the
 * public API).
 */
export class ProviderNotConfiguredError extends Error {
  constructor(
    message = 'WhatsApp not configured. Please set up your WhatsApp integration first.'
  ) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

/**
 * Which backend a config row belongs to.
 *
 * Rows written before the UAZAPI work have no `provider` column value;
 * the migration defaults them to 'meta', and this fallback covers the
 * gap for any caller that selected a narrow column list without it.
 */
export function providerIdOf(config: ProviderConfigRow): ProviderId {
  return isProviderId(config.provider) ? config.provider : 'meta';
}

/**
 * Build a bound provider from an already-loaded config row.
 * Throws `ProviderNotConfiguredError` if the row lacks the credentials
 * its own provider requires.
 */
export function createProvider(config: ProviderConfigRow): WhatsAppProvider {
  const id = providerIdOf(config);

  if (id === 'meta') {
    if (!config.phone_number_id || !config.access_token) {
      throw new ProviderNotConfiguredError(
        'WhatsApp (Meta) is missing its phone number id or access token.'
      );
    }
    return createMetaProvider({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
    });
  }

  if (!config.uazapi_host || !config.uazapi_instance_token) {
    throw new ProviderNotConfiguredError(
      'WhatsApp (UAZAPI) is missing its host or instance token. Reconnect by scanning the QR code.'
    );
  }
  return createUazapiProvider({
    host: config.uazapi_host,
    token: decrypt(config.uazapi_instance_token),
  });
}

/**
 * Load an account's WhatsApp config and return its bound provider.
 *
 * `db` may be an RLS-scoped user client or the service-role client —
 * the query is filtered by `accountId` either way, so tenancy holds
 * regardless of which one the caller passes.
 */
export async function getProvider(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppProvider> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (error || !config) throw new ProviderNotConfiguredError();

  return createProvider(config as ProviderConfigRow);
}
