// ============================================================
// Asaas HTTP client.
//
// One platform-operator key, held in an env var — NOT in the
// database and NOT encrypted. That's the same posture the repo
// already documents for UAZAPI_ADMIN_TOKEN. `encrypt()` exists for
// PER-TENANT secrets (each customer's WhatsApp token, their BYO AI
// key) where the database is the only place they can live; using it
// for a single global key would add a decrypt step and a rotation
// problem in exchange for nothing.
//
// Env is read LAZILY, inside functions. Reading it at module load
// would mean importing anything in this folder from a unit test
// throws unless vitest.config.ts is taught about ASAAS_* — and the
// pure modules next door must stay trivially importable.
// ============================================================

const PROD_BASE = 'https://api.asaas.com/v3';
const SANDBOX_BASE = 'https://api-sandbox.asaas.com/v3';

/** 20s: Asaas is occasionally slow, but a route must never hang. */
const TIMEOUT_MS = 20_000;

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

function asaasKey(): string | null {
  const key = process.env.ASAAS_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

/**
 * Sandbox unless ASAAS_ENV is exactly "production".
 *
 * Defaulting to sandbox is the safe direction: a misconfigured
 * deploy creates fake charges nobody pays, rather than real charges
 * against real customers.
 */
export function asaasBaseUrl(): string {
  return process.env.ASAAS_ENV === 'production' ? PROD_BASE : SANDBOX_BASE;
}

/**
 * Is self-serve billing available at all?
 *
 * When false, /api/billing/subscribe answers 503 and the UI hides
 * the subscribe CTA — the exact mirror of the "UAZAPI not
 * configured" path. Admin plan grants keep working regardless:
 * they are pure database writes and need no gateway.
 */
export function isAsaasConfigured(): boolean {
  return asaasKey() !== null;
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
  const key = asaasKey();
  if (!key) {
    throw new AsaasError('Asaas is not configured', 503, 'not_configured');
  }

  const { method = 'GET', body, query } = options;

  let url = `${asaasBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
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
        access_token: key,
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
