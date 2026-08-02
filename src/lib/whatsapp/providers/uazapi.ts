// ============================================================
// UAZAPI adapter — the unofficial, QR-code-paired backend.
//
// Two very different audiences share this file:
//
//   * the instance lifecycle (create / connect / status / disconnect /
//     webhook registration), which the settings UI drives, and
//   * the `WhatsAppProvider` implementation, which the shared send
//     paths drive without knowing which backend they are on.
//
// They live together because they share one HTTP convention and one
// set of credentials rules, and splitting them would mean exporting
// that convention just to re-import it next door.
//
// Credentials, in order of danger:
//
//   UAZAPI_ADMIN_TOKEN  Account-wide. Creates and resets instances for
//                       *every* customer we host. Used by exactly one
//                       function here (`createInstance`) and never
//                       written to the database. Treat like the
//                       service-role key.
//   instance token      Per-customer, returned by createInstance and
//                       stored AES-256-GCM encrypted in
//                       whatsapp_config.uazapi_instance_token. Every
//                       other call authenticates with this.
//
// What UAZAPI cannot do, and why we do not pretend otherwise: there
// are no pre-approved templates and no 24-hour session window.
// `UAZAPI_CAPABILITIES` says so, and `sendTemplate` throws rather than
// quietly sending the template's text as a plain message — that would
// look like it worked while dropping the approval guarantee the caller
// asked for.
// ============================================================

import type { InteractiveListSection } from '@/lib/whatsapp/meta-api';
import { UAZAPI_CAPABILITIES } from './capabilities';
import {
  ProviderUnsupportedError,
  type ProviderSendResult,
  type SendInteractiveButtonsArgs,
  type SendInteractiveListArgs,
  type SendMediaArgs,
  type SendReactionArgs,
  type SendTextArgs,
  type WhatsAppProvider,
} from './types';

export { UAZAPI_CAPABILITIES };

/** uazapi's own connection states, mirrored by whatsapp_config.status. */
export type UazapiStatus =
  'disconnected' | 'connecting' | 'connected' | 'hibernated';

export class UazapiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'UazapiError';
    this.status = status;
  }
}

/**
 * Raised when the deployment has no uazapi credentials configured.
 * Routes map it to 503 — the provider is simply not on offer here,
 * which is different from the customer having mis-configured theirs.
 */
export class UazapiNotEnabledError extends Error {
  constructor() {
    super(
      'UAZAPI is not enabled on this deployment. Set UAZAPI_HOST and UAZAPI_ADMIN_TOKEN.'
    );
    this.name = 'UazapiNotEnabledError';
  }
}

/** Host with any trailing slash removed, or null when unset. */
export function uazapiHost(): string | null {
  const raw = process.env.UAZAPI_HOST?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

function adminToken(): string | null {
  return process.env.UAZAPI_ADMIN_TOKEN?.trim() || null;
}

/** True when this deployment can offer UAZAPI at all. */
export function isUazapiEnabled(): boolean {
  return Boolean(uazapiHost() && adminToken());
}

interface RequestOptions {
  host: string;
  path: string;
  /** `token` (per-instance) or `admintoken` (account-wide). */
  auth: { kind: 'token' | 'admintoken'; value: string };
  body?: unknown;
  method?: 'GET' | 'POST';
}

async function uazapiFetch<T>(options: RequestOptions): Promise<T> {
  const { host, path, auth, body, method = 'POST' } = options;

  const response = await fetch(`${host}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [auth.kind]: auth.value,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body — keep the raw text for the error message below.
  }

  if (!response.ok) {
    const asRecord = parsed as { error?: string; message?: string } | null;
    const detail = asRecord?.error ?? asRecord?.message ?? text.slice(0, 300);
    throw new UazapiError(
      `uazapi ${path} failed: ${response.status}${detail ? ` — ${detail}` : ''}`,
      response.status
    );
  }

  return parsed as T;
}

// ------------------------------------------------------------
// Instance lifecycle (settings UI)
// ------------------------------------------------------------

export interface UazapiInstance {
  id: string;
  token: string;
  status: UazapiStatus;
  /** Base64 PNG, present while status is 'connecting'. */
  qrcode?: string;
  paircode?: string;
  name?: string;
  profileName?: string;
  number?: string;
}

/**
 * Unwrap the instance object from a uazapi response.
 *
 * The endpoints are inconsistent: some return the instance at the top
 * level, others nest it under `instance`. Normalising here keeps that
 * quirk out of four call sites.
 */
function readInstance(payload: unknown): UazapiInstance {
  const root = (payload ?? {}) as Record<string, unknown>;
  const nested = (root.instance ?? root) as Record<string, unknown>;
  return {
    id: String(nested.id ?? ''),
    token: String(nested.token ?? root.token ?? ''),
    status: (nested.status as UazapiStatus) ?? 'disconnected',
    qrcode: (nested.qrcode as string) || (root.qrcode as string) || undefined,
    paircode:
      (nested.paircode as string) || (root.paircode as string) || undefined,
    name: nested.name as string | undefined,
    profileName: nested.profileName as string | undefined,
  };
}

/**
 * Provision a new instance under our uazapi account.
 *
 * The account id goes into `adminField01` — uazapi keeps those fields
 * admin-editable only, and it is the sole way to reconcile a stray
 * instance back to the customer it belongs to. Without it, an instance
 * orphaned by a failed disconnect is unattributable and quietly bills
 * forever.
 */
export async function createInstance(
  accountId: string,
  name: string
): Promise<UazapiInstance> {
  const host = uazapiHost();
  const admin = adminToken();
  if (!host || !admin) throw new UazapiNotEnabledError();

  const payload = await uazapiFetch<unknown>({
    host,
    path: '/instance/create',
    auth: { kind: 'admintoken', value: admin },
    body: { name, adminField01: accountId },
  });

  const instance = readInstance(payload);
  if (!instance.token) {
    throw new UazapiError(
      'uazapi created the instance but returned no token.',
      502
    );
  }
  return instance;
}

/**
 * Start pairing. With no `phone` uazapi returns a QR code, which is the
 * flow we want — the operator scans it from the settings screen.
 *
 * The code is valid for two minutes, so the UI has to refresh rather
 * than render it once.
 */
export async function connectInstance(
  host: string,
  token: string
): Promise<UazapiInstance> {
  return readInstance(
    await uazapiFetch<unknown>({
      host,
      path: '/instance/connect',
      auth: { kind: 'token', value: token },
      body: {},
    })
  );
}

export async function instanceStatus(
  host: string,
  token: string
): Promise<UazapiInstance> {
  return readInstance(
    await uazapiFetch<unknown>({
      host,
      path: '/instance/status',
      auth: { kind: 'token', value: token },
      method: 'GET',
    })
  );
}

export async function disconnectInstance(
  host: string,
  token: string
): Promise<void> {
  await uazapiFetch<unknown>({
    host,
    path: '/instance/disconnect',
    auth: { kind: 'token', value: token },
    body: {},
  });
}

/**
 * Point the instance's webhook at our callback URL.
 *
 * `excludeMessages: ['wasSentByApi']` is not optional bookkeeping.
 * uazapi echoes messages *we* sent back through the same `messages`
 * event; without the filter every outbound message would arrive as
 * inbound moments later and duplicate itself in the conversation.
 *
 * `history` is deliberately absent from `events`: pairing replays up to
 * seven days of chat, and importing that would create hundreds of
 * contacts and conversations — and fire flows, automations and AI
 * auto-replies against all of them — the instant someone scans a code.
 */
export async function registerWebhook(
  host: string,
  token: string,
  url: string
): Promise<void> {
  await uazapiFetch<unknown>({
    host,
    path: '/webhook',
    auth: { kind: 'token', value: token },
    body: {
      enabled: true,
      url,
      events: ['messages', 'messages_update', 'connection'],
      excludeMessages: ['wasSentByApi'],
      addUrlEvents: false,
      addUrlTypesMessages: false,
    },
  });
}

// ------------------------------------------------------------
// The provider
// ------------------------------------------------------------

/** uazapi returns the sent message under a couple of different keys. */
function readSentMessageId(payload: unknown): string {
  const root = (payload ?? {}) as Record<string, unknown>;
  const message = (root.message ?? root) as Record<string, unknown>;
  return String(
    message.messageid ?? message.id ?? root.messageid ?? root.id ?? ''
  );
}

/**
 * Encode one selectable option as uazapi's pipe-delimited `choices`
 * string: `Title|id|description`. The id is what comes back on the
 * webhook when the customer taps, so it must survive the round trip —
 * which is why a title containing a `|` is rejected rather than
 * silently truncated at the wrong field boundary.
 */
function encodeChoice(title: string, id: string, description?: string): string {
  if (title.includes('|') || id.includes('|')) {
    throw new UazapiError(
      `Interactive option "${title}" contains a "|", which uazapi uses as its field separator.`,
      400
    );
  }
  const base = `${title}|${id}`;
  return description ? `${base}|${description.replace(/\|/g, '/')}` : base;
}

function encodeSections(sections: InteractiveListSection[]): string[] {
  const choices: string[] = [];
  for (const section of sections) {
    // `[Title]` marks a section break in uazapi's flat choices array.
    if (section.title) choices.push(`[${section.title}]`);
    for (const row of section.rows) {
      choices.push(encodeChoice(row.title, row.id, row.description));
    }
  }
  return choices;
}

/**
 * UAZAPI's menu has body + footer but no header field. Meta's does.
 * Rather than drop a header the caller supplied, fold it into the top
 * of the body so the customer still reads it.
 */
function foldHeader(bodyText: string, headerText?: string): string {
  return headerText ? `*${headerText}*\n\n${bodyText}` : bodyText;
}

export interface UazapiProviderCredentials {
  host: string;
  /** Per-instance token, already decrypted. */
  token: string;
}

export function createUazapiProvider(
  credentials: UazapiProviderCredentials
): WhatsAppProvider {
  const { host, token } = credentials;
  const auth = { kind: 'token', value: token } as const;

  const send = async (
    path: string,
    body: Record<string, unknown>,
    to: string
  ): Promise<ProviderSendResult> => {
    const payload = await uazapiFetch<unknown>({ host, path, auth, body });
    return { messageId: readSentMessageId(payload), deliveredTo: to };
  };

  return {
    id: 'uazapi',
    capabilities: UAZAPI_CAPABILITIES,

    sendText(args: SendTextArgs) {
      return send(
        '/send/text',
        {
          number: args.to,
          text: args.text,
          replyid: args.contextMessageId,
        },
        args.to
      );
    },

    sendMedia(args: SendMediaArgs) {
      return send(
        '/send/media',
        {
          number: args.to,
          // MediaKind's four values (image/video/document/audio) are
          // all present in uazapi's enum, so the kinds map unchanged.
          type: args.kind,
          file: args.link,
          text: args.kind === 'audio' ? undefined : args.caption,
          docName: args.kind === 'document' ? args.filename : undefined,
          replyid: args.contextMessageId,
        },
        args.to
      );
    },

    // No approval flow exists here, so there is nothing honest to send.
    // Callers are expected to check `capabilities.templates` first; this
    // is the backstop for the ones that forget.
    async sendTemplate(): Promise<ProviderSendResult> {
      throw new ProviderUnsupportedError('uazapi', 'templates');
    },

    sendInteractiveButtons(args: SendInteractiveButtonsArgs) {
      return send(
        '/send/menu',
        {
          number: args.to,
          type: 'button',
          text: foldHeader(args.bodyText, args.headerText),
          footerText: args.footerText,
          choices: args.buttons.map((b) => encodeChoice(b.title, b.id)),
          replyid: args.contextMessageId,
        },
        args.to
      );
    },

    sendInteractiveList(args: SendInteractiveListArgs) {
      return send(
        '/send/menu',
        {
          number: args.to,
          type: 'list',
          text: foldHeader(args.bodyText, args.headerText),
          footerText: args.footerText,
          listButton: args.buttonLabel,
          choices: encodeSections(args.sections),
          replyid: args.contextMessageId,
        },
        args.to
      );
    },

    async sendReaction(args: SendReactionArgs) {
      const payload = await uazapiFetch<unknown>({
        host,
        path: '/message/react',
        auth,
        body: { number: args.to, id: args.targetMessageId, text: args.emoji },
      });
      return { messageId: readSentMessageId(payload), deliveredTo: args.to };
    },

    async fetchInboundMedia(ref: string) {
      // Ask for a link rather than base64: the payload stays small and
      // we stream the bytes ourselves, matching how the Meta adapter
      // looks from the media-proxy route's point of view.
      const payload = await uazapiFetch<{
        fileURL?: string;
        url?: string;
        mimetype?: string;
      }>({
        host,
        path: '/message/download',
        auth,
        body: { id: ref, return_link: true },
      });

      const url = payload?.fileURL || payload?.url;
      if (!url) {
        throw new UazapiError(
          'uazapi returned no download URL for this media.',
          502
        );
      }

      const file = await fetch(url);
      if (!file.ok) {
        throw new UazapiError(
          `uazapi media download failed: ${file.status}`,
          file.status
        );
      }

      return {
        buffer: Buffer.from(await file.arrayBuffer()),
        contentType:
          payload?.mimetype ||
          file.headers.get('content-type') ||
          'application/octet-stream',
      };
    },
  };
}
