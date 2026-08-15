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

import { createHash } from 'node:crypto';

import type { InteractiveListSection } from '@/lib/whatsapp/meta-api';
import { UAZAPI_CAPABILITIES } from './capabilities';
import {
  ProviderUnsupportedError,
  type ProviderSendResult,
  type SendInteractiveButtonsArgs,
  type SendInteractiveListArgs,
  type SendMediaArgs,
  type SendPresenceArgs,
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

export async function uazapiFetch<T>(options: RequestOptions): Promise<T> {
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
 * Events we subscribe the instance to.
 *
 * `history` is deliberately absent: pairing replays up to seven days of
 * chat, and importing that would create hundreds of contacts and
 * conversations — and fire flows, automations and AI auto-replies
 * against all of them — the instant someone scans a code.
 *
 * This list is versioned by {@link webhookRegistrationFingerprint}, so
 * growing it is enough to make every already-paired instance re-register
 * on its next status poll. That matters: this list has grown, and
 * nothing re-sent it. Instances paired before the change kept the old
 * subscription, and delivery ticks and presence silently never arrived.
 */
export const WEBHOOK_EVENTS = [
  'messages',
  'messages_update',
  'connection',
  'groups',
  // presence: contact online/last-seen (best-effort — payload is
  // undocumented and most numbers hide this from a non-contact
  // anyway). labels/chat_labels: WhatsApp Business label sync.
  'presence',
  'labels',
  'chat_labels',
] as const;

/**
 * Deliberately EMPTY, and that is the whole fix for the missing
 * delivery ticks.
 *
 * This used to be `['wasSentByApi']`, to stop uazapi echoing our own API
 * sends back on the `messages` event and duplicating them in the thread.
 * The filter does that job — but it also drops `messages_update` for the
 * very same messages, which is every message the inbox sends. That is
 * why outbound messages never advanced past `sent`.
 *
 * The evidence, since a comment here once asserted the opposite without
 * it: after the subscription drift was repaired (fingerprint written
 * 21:20:07), a message sent at 21:22:45 — under the corrected, complete
 * event list — still had `delivered_at` null. The subscription was no
 * longer the variable; this filter was.
 *
 * Removing it is safe now in a way it was not before, because the echo
 * is stopped twice over further down the pipe:
 *
 *   1. The `messages` handler skips any `fromMe` event whose provider
 *      message id already exists on the conversation.
 *   2. Failing that, the unique index on (conversation_id, message_id)
 *      from migration 037 refuses the duplicate insert outright.
 *
 * Do not reintroduce a filter here to solve an echo problem. Echoes are
 * a de-duplication concern and are handled as one; a subscription filter
 * cannot tell "echo of our send" from "delivery receipt for our send",
 * so using one to suppress the first always costs you the second.
 */
export const WEBHOOK_EXCLUDE_MESSAGES = [] as const;

/**
 * Stable fingerprint of the registration we intend uazapi to hold:
 * callback URL plus event list plus message filters.
 *
 * Stored on `whatsapp_config.uazapi_webhook_registration` after a
 * successful push. Comparing the stored value to this one is what tells
 * us an instance is running an out-of-date subscription without paying
 * for a `GET /webhook` round trip on every status poll.
 */
export function webhookRegistrationFingerprint(url: string): string {
  const canonical = JSON.stringify({
    url,
    events: [...WEBHOOK_EVENTS].sort(),
    excludeMessages: [...WEBHOOK_EXCLUDE_MESSAGES].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** One webhook registration as uazapi reports it back. */
export interface UazapiWebhookRegistration {
  id?: string;
  enabled?: boolean;
  url?: string;
  events?: string[];
  excludeMessages?: string[];
}

/**
 * `GET /webhook` — what uazapi actually holds for this instance, as
 * opposed to what we believe we pushed. Always an array, even for a
 * single registration (per the OpenAPI spec).
 *
 * Used for operator-facing diagnosis, not for the reconcile decision:
 * re-registering is idempotent and cheap, so the fingerprint check
 * drives that. This is here so "why am I not getting ticks?" has a
 * first-class answer instead of a guess.
 */
export async function readWebhooks(
  host: string,
  token: string
): Promise<UazapiWebhookRegistration[]> {
  const payload = await uazapiFetch<unknown>({
    host,
    path: '/webhook',
    auth: { kind: 'token', value: token },
    method: 'GET',
  });
  if (Array.isArray(payload)) return payload as UazapiWebhookRegistration[];
  if (payload && typeof payload === 'object') {
    return [payload as UazapiWebhookRegistration];
  }
  return [];
}

/** Events in {@link WEBHOOK_EVENTS} that `remote` is NOT subscribed to. */
export function missingWebhookEvents(
  remote: UazapiWebhookRegistration[],
  url: string
): string[] {
  const match = remote.find((w) => w.url === url && w.enabled !== false);
  if (!match) return [...WEBHOOK_EVENTS];
  const subscribed = new Set(match.events ?? []);
  return WEBHOOK_EVENTS.filter((e) => !subscribed.has(e));
}

/** One entry from {@link getWebhookErrors} — uazapi's own record of a
 *  failed delivery attempt to our callback URL. */
export interface UazapiWebhookError {
  created?: string;
  url?: string;
  type?: string;
  event?: string;
  message_type?: string;
  status_code?: number;
  attempts?: number;
  error?: string;
  payload?: unknown;
}

/**
 * `GET /webhook/errors` — uazapi's in-memory log of the last 20 failed
 * webhook deliveries for THIS instance (per its OpenAPI spec's
 * `getWebhookErrors` operation). This is the one place that can prove
 * or disprove "uazapi is trying to send messages_update and our
 * endpoint is rejecting it" versus "uazapi never attempts the send at
 * all" — readWebhooks()/missingWebhookEvents() above only confirm the
 * *subscription* is correct, not that deliveries are actually
 * happening or succeeding. The history is memory-only and resets on
 * uazapi's own process restart, so an empty array is not proof nothing
 * ever failed — only that nothing has failed recently.
 */
export async function getWebhookErrors(
  host: string,
  token: string
): Promise<UazapiWebhookError[]> {
  const payload = await uazapiFetch<unknown>({
    host,
    path: '/webhook/errors',
    auth: { kind: 'token', value: token },
    method: 'GET',
  });
  return Array.isArray(payload) ? (payload as UazapiWebhookError[]) : [];
}

/**
 * Point the instance's webhook at our callback URL. Idempotent — uazapi
 * replaces the registration for the instance wholesale, so calling this
 * on an already-correct instance costs a round trip and changes nothing.
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
      events: [...WEBHOOK_EVENTS],
      excludeMessages: [...WEBHOOK_EXCLUDE_MESSAGES],
      addUrlEvents: false,
      addUrlTypesMessages: false,
    },
  });
}

/**
 * Set the connected account's own online/available state.
 *
 * Not cosmetic: per uazapi's docs, when the instance is the only
 * active device and its presence is "unavailable", delivery/read
 * ticks (`messages_update` webhooks) stop being sent or received
 * entirely — the whole point of the read-receipt feature silently
 * breaks. Called once right after a successful `connectInstance()` so
 * a fresh pairing starts in the state the tick feature depends on.
 */
export async function setInstancePresence(
  host: string,
  token: string,
  presence: 'available' | 'unavailable'
): Promise<void> {
  await uazapiFetch<unknown>({
    host,
    path: '/instance/presence',
    auth: { kind: 'token', value: token },
    body: { presence },
  });
}

/**
 * The connected account's own WhatsApp privacy settings.
 *
 * `readreceipts` is the one that matters for the inbox: WhatsApp's
 * read receipts are RECIPROCAL. With it set to `none` the account
 * neither sends blue ticks nor RECEIVES them, so every outbound
 * message stalls at `delivered` forever no matter how healthy the
 * webhook pipeline is. It is a setting on the paired WhatsApp
 * account, not something the CRM can infer from message traffic —
 * hence reading it explicitly.
 */
export interface UazapiPrivacy {
  readreceipts?: string;
  online?: string;
  last?: string;
  profile?: string;
  status?: string;
  groupadd?: string;
  calladd?: string;
}

export async function getInstancePrivacy(
  host: string,
  token: string
): Promise<UazapiPrivacy> {
  const raw = await uazapiFetch<unknown>({
    host,
    path: '/instance/privacy',
    auth: { kind: 'token', value: token },
    method: 'GET',
  });
  const root = (raw ?? {}) as Record<string, unknown>;
  // uazapi returns the settings either at the root or nested under
  // `privacy`/`response`, depending on the build — same envelope
  // inconsistency readInstance/readGroup already normalise for.
  const src = (root.privacy ?? root.response ?? root) as Record<
    string,
    unknown
  >;
  const pick = (k: string) =>
    typeof src[k] === 'string' ? (src[k] as string) : undefined;
  return {
    readreceipts: pick('readreceipts'),
    online: pick('online'),
    last: pick('last'),
    profile: pick('profile'),
    status: pick('status'),
    groupadd: pick('groupadd'),
    calladd: pick('calladd'),
  };
}

/**
 * Patch one or more privacy settings. Only ever called with an
 * explicit user action behind it — this changes how the operator's
 * WhatsApp account behaves towards everyone they talk to, not just
 * the CRM, so it must never be applied silently.
 */
export async function setInstancePrivacy(
  host: string,
  token: string,
  patch: UazapiPrivacy
): Promise<void> {
  await uazapiFetch<unknown>({
    host,
    path: '/instance/privacy',
    auth: { kind: 'token', value: token },
    body: patch,
  });
}

// ------------------------------------------------------------
// WhatsApp Business labels — the CRM's "conversation label" feature
// IS this, not a parallel CRM-only tag (see migration 048's doc
// comment). All three calls hit the instance the same way the rest of
// this file does: token auth, JSON body.
// ------------------------------------------------------------

export interface UazapiLabel {
  labelid: string;
  name: string;
  color: number;
}

/** GET /labels — every label defined on this WhatsApp Business instance. */
export async function listLabels(
  host: string,
  token: string
): Promise<UazapiLabel[]> {
  const raw = await uazapiFetch<unknown>({
    host,
    path: '/labels',
    auth: { kind: 'token', value: token },
    method: 'GET',
  });
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => {
    const row = (l ?? {}) as Record<string, unknown>;
    return {
      labelid: String(row.labelid ?? row.id ?? ''),
      name: String(row.name ?? ''),
      color: Number(row.color ?? 0),
    };
  });
}

/**
 * POST /label/edit — create (`labelid: "new"`), rename/recolor, or
 * delete a label. Returns the label id uazapi assigned/used, when the
 * response includes it — callers that create a label still need a
 * follow-up `listLabels()` if it doesn't (per uazapi's own docs).
 */
export async function editLabel(
  host: string,
  token: string,
  args: { labelid: string; name?: string; color?: number; delete?: boolean }
): Promise<void> {
  await uazapiFetch<unknown>({
    host,
    path: '/label/edit',
    auth: { kind: 'token', value: token },
    body: args,
  });
}

/** POST /chat/labels — apply/remove/replace a chat's label set. */
export async function setChatLabels(
  host: string,
  token: string,
  args:
    | { number: string; add_labelid: string }
    | { number: string; remove_labelid: string }
    | { number: string; labelids: string[] }
): Promise<void> {
  await uazapiFetch<unknown>({
    host,
    path: '/chat/labels',
    auth: { kind: 'token', value: token },
    body: args,
  });
}

/**
 * `POST /message/markread` — tell WhatsApp the operator has actually
 * READ these inbound messages, which is what turns the customer's
 * ticks blue on their phone.
 *
 * This is a real network action, not bookkeeping: nothing else in the
 * app performs it. Zeroing `conversations.unread_count` when a thread
 * is opened only clears the CRM's own badge — WhatsApp never learns
 * anything from that, so without this call the CRM can never send a
 * read receipt no matter what the privacy settings say.
 *
 * Takes provider message ids (`messages.message_id`), not local uuids.
 */
export async function markMessagesRead(
  host: string,
  token: string,
  messageIds: string[]
): Promise<void> {
  if (messageIds.length === 0) return;
  await uazapiFetch<unknown>({
    host,
    path: '/message/markread',
    auth: { kind: 'token', value: token },
    body: { id: messageIds },
  });
}

/**
 * `POST /chat/read` — flip a whole chat's read/unread state on
 * WhatsApp itself, so "mark as unread" in the inbox is mirrored onto
 * the operator's phone instead of being CRM-only.
 */
export async function markChatRead(
  host: string,
  token: string,
  number: string,
  read: boolean
): Promise<void> {
  await uazapiFetch<unknown>({
    host,
    path: '/chat/read',
    auth: { kind: 'token', value: token },
    body: { number, read },
  });
}

export interface UazapiNumberCheck {
  query: string;
  jid?: string;
  lid?: string;
  isInWhatsapp: boolean;
  verifiedName?: string;
}

/**
 * `POST /chat/check` — ask WhatsApp for the CANONICAL address of a
 * number before sending to it.
 *
 * Why this matters beyond "is this number on WhatsApp": WhatsApp keys
 * a chat by exact JID, and several countries have two writings of the
 * same subscriber. Brazil is the notorious one — mobile numbers gained
 * a leading `9` (`+55 11 9xxxx-xxxx` vs the older `+55 11 xxxx-xxxx`)
 * and both forms reach the same person, but they are DIFFERENT JIDs.
 * Sending to the form the CRM happens to have stored, when the phone's
 * existing thread uses the other one, makes WhatsApp open a SECOND
 * conversation with the same person — the "same number appears twice
 * on the phone" symptom. uazapi's check normalises the number and
 * hands back the JID WhatsApp itself considers canonical.
 */
export async function checkNumber(
  host: string,
  token: string,
  number: string
): Promise<UazapiNumberCheck | null> {
  const raw = await uazapiFetch<unknown>({
    host,
    path: '/chat/check',
    auth: { kind: 'token', value: token },
    body: { numbers: [number] },
  });
  const first = Array.isArray(raw) ? raw[0] : null;
  if (!first || typeof first !== 'object') return null;
  const row = first as Record<string, unknown>;
  return {
    query: String(row.query ?? number),
    jid: typeof row.jid === 'string' ? row.jid : undefined,
    lid: typeof row.lid === 'string' ? row.lid : undefined,
    isInWhatsapp: row.isInWhatsapp === true,
    verifiedName:
      typeof row.verifiedName === 'string' ? row.verifiedName : undefined,
  };
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

/**
 * Full-resolution profile-picture URL for a contact/chat.
 *
 * uazapi never rides this along on an inbound message payload — the
 * `Message` webhook schema has no image field — the only place it
 * shows up is `Chat.image` from a dedicated `/chat/details` call (or
 * the `chats`/`contacts` webhook events, which this deployment doesn't
 * subscribe to). Returns null rather than throwing on any failure (no
 * photo set, contact not found, transient error) so a missing avatar
 * never blocks inbound message processing — callers already treat null
 * as "nothing to update".
 */
export async function fetchChatAvatar(
  host: string,
  token: string,
  phone: string
): Promise<string | null> {
  try {
    const payload = await uazapiFetch<{ image?: string }>({
      host,
      path: '/chat/details',
      auth: { kind: 'token', value: token },
      body: { number: phone },
    });
    return payload?.image || null;
  } catch (err) {
    console.error(
      '[uazapi] failed to fetch chat avatar:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export function createUazapiProvider(
  credentials: UazapiProviderCredentials
): WhatsAppProvider {
  const { host, token } = credentials;
  const auth = { kind: 'token', value: token } as const;

  // Canonical-address cache for this provider instance. `/chat/check`
  // is one extra round trip per distinct recipient; paying it is what
  // keeps a send from opening a duplicate WhatsApp thread when the
  // stored number is a valid-but-non-canonical writing of the same
  // subscriber (see checkNumber's doc comment).
  const canonical = new Map<string, string>();

  const resolveNumber = async (to: string): Promise<string> => {
    const cached = canonical.get(to);
    if (cached) return cached;
    try {
      const checked = await checkNumber(host, token, to);
      // Only trust the result when WhatsApp actually knows the number.
      // A `jid` here can legitimately be a `@lid` address; uazapi
      // accepts either as `number`, and the LID is by definition the
      // thread the recipient already has open.
      const resolved = checked?.isInWhatsapp && checked.jid ? checked.jid : to;
      canonical.set(to, resolved);
      return resolved;
    } catch (err) {
      // Never let a failed lookup block a send — fall back to the
      // number as given, which is exactly the previous behaviour.
      console.error(
        '[uazapi] number check failed, sending to the raw number:',
        err instanceof Error ? err.message : err
      );
      canonical.set(to, to);
      return to;
    }
  };

  const send = async (
    path: string,
    body: Record<string, unknown>,
    to: string
  ): Promise<ProviderSendResult> => {
    const number = await resolveNumber(to);
    const payload = await uazapiFetch<unknown>({
      host,
      path,
      auth,
      body: { ...body, number },
    });
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
          // image/video/document map straight onto uazapi's enum, but
          // `type: "audio"` sends a plain audio-file attachment — no
          // waveform, no mic bubble, and it renders on the recipient's
          // phone looking like a forwarded/generic file rather than a
          // voice note. uazapi's own docs send audio as `type: "ptt"`
          // (Push-To-Talk) specifically to get the native voice-message
          // bubble a real phone produces; `myaudio` is the documented
          // alternative. Every other kind is unaffected.
          type: args.kind === 'audio' ? 'ptt' : args.kind,
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
        body: {
          number: await resolveNumber(args.to),
          id: args.targetMessageId,
          text: args.emoji,
        },
      });
      return { messageId: readSentMessageId(payload), deliveredTo: args.to };
    },

    // uazapi manages the indicator asynchronously on its side (re-ticks
    // WhatsApp every 10s for up to 5 minutes, or until we actually send
    // a message to the same chat, which cancels it automatically) — one
    // call per typing/recording burst is enough, no polling needed here.
    async sendPresence(args: SendPresenceArgs): Promise<void> {
      await uazapiFetch<unknown>({
        host,
        path: '/message/presence',
        auth,
        // Canonicalised like every other send: a typing indicator
        // addressed to a non-canonical writing of the number animates
        // in a thread the customer may not have open.
        body: { number: await resolveNumber(args.to), presence: args.presence },
      });
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
