import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { invalidateAsaasCredentialsCache } from '@/lib/billing/asaas/client';

const KEYS = [
  'asaas_api_key_encrypted',
  'asaas_env',
  'asaas_webhook_token_encrypted',
] as const;

interface AsaasSettingsView {
  /** Never the plaintext key — write-only from the client's point of view. */
  apiKeyConfigured: boolean;
  /** Where the active key currently comes from, for the admin's own clarity. */
  apiKeySource: 'database' | 'env' | 'none';
  env: 'sandbox' | 'production';
  /**
   * Shown in full, unlike the API key: the operator has to copy this
   * into the Asaas dashboard's webhook config every time they view
   * this page, not just once at creation. A leaked webhook token lets
   * someone POST fake payment events at us — annoying, but it can't
   * move money or read anything, since every effect it triggers keys
   * off Asaas object ids and account_subscriptions rows that already
   * exist. That asymmetry is why the API key stays write-only and this
   * doesn't.
   */
  webhookToken: string | null;
}

async function readView(): Promise<AsaasSettingsView> {
  const db = supabaseAdmin();
  const { data } = await db
    .from('platform_settings')
    .select('key, value')
    .in('key', KEYS);

  const byKey = new Map<string, unknown>(
    (data ?? []).map((row) => [row.key as string, row.value])
  );

  const encryptedKey = byKey.get('asaas_api_key_encrypted');
  const hasDbKey = typeof encryptedKey === 'string' && encryptedKey.length > 0;
  const hasEnvKey = !!process.env.ASAAS_API_KEY?.trim();

  const dbEnv = byKey.get('asaas_env');
  const env: 'sandbox' | 'production' =
    dbEnv === 'production' || dbEnv === 'sandbox'
      ? dbEnv
      : process.env.ASAAS_ENV === 'production'
        ? 'production'
        : 'sandbox';

  const encryptedToken = byKey.get('asaas_webhook_token_encrypted');
  let webhookToken: string | null = null;
  if (typeof encryptedToken === 'string' && encryptedToken) {
    try {
      webhookToken = decrypt(encryptedToken);
    } catch {
      webhookToken = null;
    }
  } else if (process.env.ASAAS_WEBHOOK_TOKEN?.trim()) {
    webhookToken = process.env.ASAAS_WEBHOOK_TOKEN.trim();
  }

  return {
    apiKeyConfigured: hasDbKey || hasEnvKey,
    apiKeySource: hasDbKey ? 'database' : hasEnvKey ? 'env' : 'none',
    env,
    webhookToken,
  };
}

/**
 * GET /api/admin/asaas-settings
 *
 * Platform-admin only. Read side of the credentials
 * src/lib/billing/asaas/client.ts resolves at request time — see that
 * file's header comment for the DB-first / env-fallback design.
 */
export async function GET() {
  try {
    await requirePlatformAdmin();
    return NextResponse.json(await readView());
  } catch (err) {
    return toErrorResponse(err);
  }
}

interface UpdateBody {
  /** New plaintext key to encrypt and store. Omit/empty = leave unchanged. */
  apiKey?: unknown;
  env?: unknown;
  /** True = mint a fresh random token and store it, overwriting any existing one. */
  regenerateWebhookToken?: unknown;
}

/**
 * PATCH /api/admin/asaas-settings
 *
 * Three independent fields, each optional:
 *   - `apiKey`   — encrypted and written to `asaas_api_key_encrypted`.
 *     Write-only by design: GET never returns it, so there is no
 *     masked-placeholder dance to get wrong (contrast with the
 *     per-tenant WhatsApp token field in settings, which DOES need
 *     that dance because it round-trips a masked value for editing).
 *   - `env`      — 'sandbox' | 'production', stored as plain text.
 *   - `regenerateWebhookToken` — mints `randomBytes(32)` hex (256 bits,
 *     well above what a shared-secret HMAC-style comparison needs) and
 *     encrypts it. The operator must re-paste the new value into the
 *     Asaas dashboard's webhook config after this — there is no API on
 *     Asaas's side for us to push it there automatically.
 */
export async function PATCH(request: Request) {
  try {
    await requirePlatformAdmin();

    const body = (await request.json().catch(() => ({}))) as UpdateBody;
    const { apiKey, env, regenerateWebhookToken } = body;

    const rows: { key: string; value: unknown }[] = [];

    if (typeof apiKey === 'string' && apiKey.trim()) {
      rows.push({
        key: 'asaas_api_key_encrypted',
        value: encrypt(apiKey.trim()),
      });
    }

    if (env !== undefined) {
      if (env !== 'sandbox' && env !== 'production') {
        return NextResponse.json(
          { error: 'env must be "sandbox" or "production"' },
          { status: 400 }
        );
      }
      rows.push({ key: 'asaas_env', value: env });
    }

    if (regenerateWebhookToken === true) {
      const token = randomBytes(32).toString('hex');
      rows.push({
        key: 'asaas_webhook_token_encrypted',
        value: encrypt(token),
      });
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'No fields to update' },
        { status: 400 }
      );
    }

    const db = supabaseAdmin();
    const { error } = await db
      .from('platform_settings')
      .upsert(rows, { onConflict: 'key' });

    if (error) {
      console.error(
        '[PATCH /api/admin/asaas-settings] upsert error:',
        error.message
      );
      return NextResponse.json(
        { error: 'Failed to update Asaas settings' },
        { status: 500 }
      );
    }

    invalidateAsaasCredentialsCache();
    return NextResponse.json(await readView());
  } catch (err) {
    return toErrorResponse(err);
  }
}
