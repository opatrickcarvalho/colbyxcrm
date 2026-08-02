// ============================================================
// The provider port.
//
// The CRM speaks two WhatsApp backends: Meta's official Cloud API and
// UAZAPI, an unofficial bridge that connects by scanning a QR code.
// This file is the seam between them — the only vocabulary the rest of
// the app is allowed to know.
//
// Two rules keep the seam honest:
//
//   1. A provider instance is already bound to one account's
//      credentials. Nothing here takes a `phoneNumberId`, an
//      `accessToken`, or an instance token — that is exactly the
//      Meta-shaped detail we are hiding. Callers pass `to` and the
//      message; the adapter owns the transport.
//
//   2. Anything only one backend can do is declared in
//      `capabilities`, never faked by the other. Templates are the
//      motivating case: UAZAPI can put the same words on the wire, but
//      there is no Meta-style approval flow behind them, so pretending
//      would be lying about what the feature guarantees. Callers check
//      the capability; adapters throw `ProviderUnsupportedError` if
//      called anyway.
// ============================================================

import type {
  InteractiveButton,
  InteractiveListSection,
  MediaKind,
} from '@/lib/whatsapp/meta-api';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import type { MessageTemplate } from '@/types';

export type ProviderId = 'meta' | 'uazapi';

/** Every provider id the config column accepts, for validation + UI. */
export const PROVIDER_IDS: readonly ProviderId[] = ['meta', 'uazapi'] as const;

export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    (PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/**
 * What a backend can actually do. Read this instead of branching on
 * `provider.id` — a check like `if (provider.id === 'meta')` re-couples
 * the caller to the very thing this port exists to hide.
 */
export interface ProviderCapabilities {
  /** Pre-approved message templates (Meta) vs. none (UAZAPI). */
  templates: boolean;
  /** Reply buttons and selectable lists. */
  interactive: boolean;
  /** Emoji reactions on an existing message. */
  reactions: boolean;
  /**
   * Free-form sends are limited to 24h after the customer's last
   * message. True for Meta; UAZAPI has no such window, which is the
   * whole reason some operators want it.
   */
  session24h: boolean;
  /**
   * Inbound media arrives as an opaque id that needs a second,
   * authenticated fetch (Meta) rather than a directly usable URL.
   * Drives whether the media-proxy route is needed.
   */
  inboundMediaNeedsFetch: boolean;
}

/**
 * Raised when a caller asks a provider for something its
 * `capabilities` already said it cannot do. Carries the capability
 * name so the UI can explain *what* is missing rather than showing a
 * generic failure.
 */
export class ProviderUnsupportedError extends Error {
  readonly provider: ProviderId;
  readonly capability: keyof ProviderCapabilities;

  constructor(provider: ProviderId, capability: keyof ProviderCapabilities) {
    super(`Provider "${provider}" does not support "${capability}".`);
    this.name = 'ProviderUnsupportedError';
    this.provider = provider;
    this.capability = capability;
  }
}

export interface ProviderSendResult {
  /** The backend's own id for the sent message (Meta wamid, UAZAPI messageid). */
  messageId: string;
  /**
   * The phone number the backend actually accepted.
   *
   * Meta rejects recipients whose formatting does not match how the
   * number is registered (a Brazilian trunk `9`, say), so the Meta
   * adapter retries across variants internally. When this differs from
   * the `to` that was passed, the caller should persist it back onto
   * the contact so the next send goes straight through — that DB write
   * stays with the caller, which is the one that knows the contact row.
   */
  deliveredTo: string;
}

export interface SendTextArgs {
  to: string;
  text: string;
  /** Backend message id being replied to; renders a quote preview. */
  contextMessageId?: string;
}

export interface SendMediaArgs {
  to: string;
  kind: MediaKind;
  /** Public URL the backend fetches at send time. */
  link: string;
  /** Ignored for audio — neither backend renders a caption on a voice note. */
  caption?: string;
  /** Document-only file name shown in the recipient's chat. */
  filename?: string;
  contextMessageId?: string;
}

export interface SendTemplateArgs {
  to: string;
  templateName: string;
  language?: string;
  /** Local template row, for header + button components. */
  template?: MessageTemplate;
  /** Structured header/body/button params. */
  messageParams?: SendTimeParams;
  /** Legacy positional body params. */
  params?: string[];
  contextMessageId?: string;
}

export interface SendInteractiveButtonsArgs {
  to: string;
  bodyText: string;
  headerText?: string;
  footerText?: string;
  buttons: InteractiveButton[];
  contextMessageId?: string;
}

export interface SendInteractiveListArgs {
  to: string;
  bodyText: string;
  buttonLabel: string;
  headerText?: string;
  footerText?: string;
  sections: InteractiveListSection[];
  contextMessageId?: string;
}

export interface SendReactionArgs {
  to: string;
  /** Backend message id being reacted to. */
  targetMessageId: string;
  /** Single emoji, or empty string to remove the reaction. */
  emoji: string;
}

/**
 * One account's bound connection to its WhatsApp backend.
 *
 * Build it with `getProvider(db, accountId)` (loads + decrypts the
 * config) or `createProvider(config)` when the caller already holds
 * the row.
 */
export interface WhatsAppProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;

  sendText(args: SendTextArgs): Promise<ProviderSendResult>;
  sendMedia(args: SendMediaArgs): Promise<ProviderSendResult>;
  sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult>;
  sendInteractiveButtons(
    args: SendInteractiveButtonsArgs
  ): Promise<ProviderSendResult>;
  sendInteractiveList(
    args: SendInteractiveListArgs
  ): Promise<ProviderSendResult>;
  sendReaction(args: SendReactionArgs): Promise<ProviderSendResult>;

  /**
   * Resolve an inbound media reference to its bytes.
   *
   * `ref` is whatever the inbound parser put on the message: a Meta
   * media id, or a UAZAPI message id. Each adapter knows how to turn
   * its own flavour into bytes, so the media-proxy route does not
   * branch on the provider.
   */
  fetchInboundMedia(
    ref: string
  ): Promise<{ buffer: Buffer; contentType: string }>;
}

/**
 * The subset of a `whatsapp_config` row an adapter needs. Declared
 * structurally (not as the full `WhatsAppConfig`) so callers can pass
 * a narrowed `.select()` result without casting.
 */
export interface ProviderConfigRow {
  provider?: string | null;
  // Meta
  phone_number_id?: string | null;
  access_token?: string | null;
  // UAZAPI
  uazapi_host?: string | null;
  uazapi_instance_id?: string | null;
  uazapi_instance_token?: string | null;
}
