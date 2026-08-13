// ============================================================
// Asaas HTTP client.
//
// Credentials — DB-first, env-fallback:
//   The API key and webhook token live encrypted in `platform_settings`
//   (same AES-256-GCM helper as per-tenant WhatsApp tokens and CPF/CNPJ,
//   src/lib/whatsapp/encryption.ts), editable from /admin/settings.
//   `ASAAS_API_KEY` / `ASAAS_ENV` / `ASAAS_WEBHOOK_TOKEN` still work as a
//   deploy-time fallback for whichever of the three the DB doesn't have
//   set — this is what makes the DB rows optional rather than a hard
//   migration cutover, and what keeps a self-hosted deployment that
//   prefers env-only config working unchanged.
//
//   This used to be a handful of synchronous `process.env` reads. It
//   is now DB I/O, so every exported function here is async — see the
//   three call sites (subscribe route, cron route, GET /api/billing)
//   that had to move from `isAsaasConfigured()` to
//   `await isAsaasConfigured()` when this changed.
//
// Cached for 60s per process, same TTL and the same reasoning as
// src/lib/billing/platform-settings.ts: this is read on essentially
// every Asaas call, for a value that changes maybe a few times a year.
// `invalidateAsaasCredentialsCache()` is called by the admin PATCH
// route so the operator's own next request reflects a just-saved key
// immediately rather than waiting out the TTL.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';

const PROD_BASE = 'https://api.asaas.com/v3';
const SANDBOX_BASE = 'https://api-sandbox.asaas.com/v3';

/** 20s: Asaas is occasionally slow, but a route must never hang. */
const TIMEOUT_MS = 20_000;

const CREDENTIALS_CACHE_TTL_MS = 60_000;

export class AsaasError extends Error {
  readonly status: number;
  /** Asaas returns `{ errors: [{ code, description }] }` on failure. */
  readonly asaasCode: string | null;

  constructor(
    message: string,
    status: number,
    asaasCode: string | null = null
  ) {
    super(message);
    this.name = 'AsaasError';
    this.status = status;
    this.asaasCode = asaasCode;
  }
}

interface AsaasCredentials {
  apiKey: string | null;
  env: 'sandbox' | 'production';
  webhookToken: string | null;
}

let cached: AsaasCredentials | null = null;
let cachedAt = 0;

function envFallback(): AsaasCredentials {
  return {
    apiKey: process.env.ASAAS_API_KEY?.trim() || null,
    env: process.env.ASAAS_ENV === 'production' ? 'production' : 'sandbox',
    webhookToken: process.env.ASAAS_WEBHOOK_TOKEN?.trim() || null,
  };
}

/**
 * Resolve credentials, DB row wins over env var per-field.
 *
 * Never throws — a database blip must not take down every Asaas call
 * platform-wide. On any read/decrypt failure this silently falls back
 * to whatever the env vars say (which may itself be "not configured",
 * and that's fine: `isAsaasConfigured()` reports it honestly rather
 * than pretending).
 */
async function loadCredentials(): Promise<AsaasCredentials> {
  const now = Date.now();
  if (cached && now - cachedAt < CREDENTIALS_CACHE_TTL_MS) return cached;

  const result = envFallback();

  try {
    const db = supabaseAdmin();
    const { data, error } = await db
      .from('platform_settings')
      .select('key, value')
      .in('key', [
        'asaas_api_key_encrypted',
        'asaas_env',
        'asaas_webhook_token_encrypted',
      ]);

    if (error) {
      // Pre-055 schema (relation exists, new keys just absent) also
      // lands here harmlessly — the env fallback already computed above.
      console.error(
        '[billing/asaas/client] settings read error:',
        error.message
      );
    } else {
      const byKey = new Map<string, unknown>(
        (data ?? []).map((row) => [row.key as string, row.value])
      );

      const encryptedKey = byKey.get('asaas_api_key_encrypted');
      if (typeof encryptedKey === 'string' && encryptedKey) {
        try {
          result.apiKey = decrypt(encryptedKey);
        } catch (err) {
          console.error('[billing/asaas/client] api key decrypt failed:', err);
        }
      }

      const dbEnv = byKey.get('asaas_env');
      if (dbEnv === 'production' || dbEnv === 'sandbox') {
        result.env = dbEnv;
      }

      const encryptedWebhookToken = byKey.get('asaas_webhook_token_encrypted');
      if (typeof encryptedWebhookToken === 'string' && encryptedWebhookToken) {
        try {
          result.webhookToken = decrypt(encryptedWebhookToken);
        } catch (err) {
          console.error(
            '[billing/asaas/client] webhook token decrypt failed:',
            err
          );
        }
      }
    }
  } catch (err) {
    console.error('[billing/asaas/client] unexpected error:', err);
  }

  cached = result;
  cachedAt = now;
  return cached;
}

/** Drop the cache — call after /admin/settings saves new Asaas credentials. */
export function invalidateAsaasCredentialsCache(): void {
  cached = null;
  cachedAt = 0;
}

/**
 * Sandbox unless the resolved env is exactly "production".
 *
 * Defaulting to sandbox is the safe direction: a misconfigured
 * deploy creates fake charges nobody pays, rather than real charges
 * against real customers.
 */
export async function asaasBaseUrl(): Promise<string> {
  const { env } = await loadCredentials();
  return env === 'production' ? PROD_BASE : SANDBOX_BASE;
}

/**
 * Is self-serve billing available at all?
 *
 * When false, /api/billing/subscribe answers 503 and the UI hides
 * the subscribe CTA — the exact mirror of the "UAZAPI not
 * configured" path. Admin plan grants keep working regardless:
 * they are pure database writes and need no gateway.
 */
export async function isAsaasConfigured(): Promise<boolean> {
  const { apiKey } = await loadCredentials();
  return apiKey !== null;
}

/** The shared secret the Asaas webhook route compares against. */
export async function getAsaasWebhookToken(): Promise<string | null> {
  const { webhookToken } = await loadCredentials();
  return webhookToken;
}

export interface AsaasFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Appended as a query string. Values are URL-encoded. */
  query?: Record<string, string | number | undefined>;
}

/**
 * Call the Asaas API and return the parsed JSON.
 *
 * Throws `AsaasError` on a non-2xx or a network failure. Callers
 * decide what that means: the subscribe route surfaces it as a 502
 * with a generic message (never the raw gateway text — it can
 * contain account details), while the cancel path logs and proceeds,
 * because failing to cancel upstream must not block us recording the
 * cancellation locally.
 */
export async function asaasFetch<T>(
  path: string,
  options: AsaasFetchOptions = {}
): Promise<T> {
  const { apiKey, env } = await loadCredentials();
  if (!apiKey) {
    throw new AsaasError('Asaas is not configured', 503, 'not_configured');
  }

  const { method = 'GET', body, query } = options;

  const baseUrl = env === 'production' ? PROD_BASE : SANDBOX_BASE;
  let url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        access_token: apiKey,
        'Content-Type': 'application/json',
        // Asaas asks integrators to identify themselves; some of
        // their edge rules reject a missing User-Agent outright.
        'User-Agent': 'colbyxcrm',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'network error';
    throw new AsaasError(`Asaas request failed: ${reason}`, 502);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Asaas occasionally answers HTML from an edge proxy. Treat it
      // as an opaque failure rather than crashing on JSON.parse.
      if (!response.ok) {
        throw new AsaasError(
          `Asaas returned a non-JSON ${response.status} response`,
          response.status
        );
      }
    }
  }

  if (!response.ok) {
    const errors = (
      parsed as { errors?: { code?: string; description?: string }[] }
    )?.errors;
    const first = Array.isArray(errors) ? errors[0] : undefined;
    throw new AsaasError(
      first?.description ?? `Asaas request failed (${response.status})`,
      response.status,
      first?.code ?? null
    );
  }

  return parsed as T;
}
