// ============================================================
// Meta (WhatsApp Cloud API) adapter.
//
// A thin binding over `meta-api.ts`: it holds one account's
// phone_number_id + decrypted access token and fills them into every
// call, so callers stop threading credentials through their own code.
//
// It also owns the phone-variant retry. That loop used to be
// copy-pasted into all five send paths, and it is Meta-specific —
// Meta rejects a recipient whose formatting does not match how the
// number is registered (a Brazilian trunk `9`, most often), so we walk
// the variants until one lands. UAZAPI has no such behaviour, which is
// precisely why the retry belongs in the adapter and not in the shared
// send code above it.
//
// Note the namespace import below. `meta-api` is replaced wholesale by
// a factory mock in send/route.test.ts that defines only three
// exports; named imports of the others would fail at module load. A
// namespace import resolves lazily at call time, so that test keeps
// passing untouched and this file still type-checks fully.
// ============================================================

import * as metaApi from '@/lib/whatsapp/meta-api';
import {
  isRecipientNotAllowedError,
  phoneVariants,
} from '@/lib/whatsapp/phone-utils';
import type {
  ProviderCapabilities,
  ProviderSendResult,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  SendMediaArgs,
  SendReactionArgs,
  SendTemplateArgs,
  SendTextArgs,
  WhatsAppProvider,
} from './types';

export const META_CAPABILITIES: ProviderCapabilities = {
  templates: true,
  interactive: true,
  reactions: true,
  session24h: true,
  inboundMediaNeedsFetch: true,
};

export interface MetaProviderCredentials {
  phoneNumberId: string;
  /** Already decrypted by the caller. */
  accessToken: string;
}

/**
 * Try `send` against each formatting variant of `to`, stopping at the
 * first one Meta accepts.
 *
 * Only "recipient not in allowed list" is treated as retryable — every
 * other Meta failure (bad token, malformed template, rate limit) is
 * rethrown immediately, because retrying those just multiplies the
 * same error and delays the real diagnosis.
 */
async function withVariantRetry(
  to: string,
  send: (phone: string) => Promise<metaApi.MetaSendResult>
): Promise<ProviderSendResult> {
  const variants = phoneVariants(to);
  let lastError: unknown = null;

  for (const variant of variants) {
    try {
      const result = await send(variant);
      return { messageId: result.messageId, deliveredTo: variant };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(message)) throw err;
      lastError = err;
      console.warn(
        `[provider:meta] variant "${variant}" rejected by Meta, trying next…`
      );
    }
  }

  // Every variant was rejected as "not allowed". Surface the last
  // rejection rather than a synthesised message, so the operator sees
  // Meta's own wording.
  throw lastError ?? new Error('Meta rejected every phone-number variant.');
}

export function createMetaProvider(
  credentials: MetaProviderCredentials
): WhatsAppProvider {
  const { phoneNumberId, accessToken } = credentials;

  return {
    id: 'meta',
    capabilities: META_CAPABILITIES,

    sendText(args: SendTextArgs) {
      return withVariantRetry(args.to, (to) =>
        metaApi.sendTextMessage({
          phoneNumberId,
          accessToken,
          to,
          text: args.text,
          contextMessageId: args.contextMessageId,
        })
      );
    },

    sendMedia(args: SendMediaArgs) {
      return withVariantRetry(args.to, (to) =>
        metaApi.sendMediaMessage({
          phoneNumberId,
          accessToken,
          to,
          kind: args.kind,
          link: args.link,
          caption: args.caption,
          filename: args.filename,
          contextMessageId: args.contextMessageId,
        })
      );
    },

    sendTemplate(args: SendTemplateArgs) {
      return withVariantRetry(args.to, (to) =>
        metaApi.sendTemplateMessage({
          phoneNumberId,
          accessToken,
          to,
          templateName: args.templateName,
          language: args.language,
          template: args.template,
          messageParams: args.messageParams,
          params: args.params,
          contextMessageId: args.contextMessageId,
        })
      );
    },

    sendInteractiveButtons(args: SendInteractiveButtonsArgs) {
      return withVariantRetry(args.to, (to) =>
        metaApi.sendInteractiveButtons({
          phoneNumberId,
          accessToken,
          to,
          bodyText: args.bodyText,
          headerText: args.headerText,
          footerText: args.footerText,
          buttons: args.buttons,
          contextMessageId: args.contextMessageId,
        })
      );
    },

    sendInteractiveList(args: SendInteractiveListArgs) {
      return withVariantRetry(args.to, (to) =>
        metaApi.sendInteractiveList({
          phoneNumberId,
          accessToken,
          to,
          bodyText: args.bodyText,
          buttonLabel: args.buttonLabel,
          headerText: args.headerText,
          footerText: args.footerText,
          sections: args.sections,
          contextMessageId: args.contextMessageId,
        })
      );
    },

    // Reactions deliberately skip the variant retry. The target
    // message already proves this number reached the customer, so a
    // rejection here is never a formatting problem — retrying would
    // only obscure the real cause.
    async sendReaction(args: SendReactionArgs) {
      const result = await metaApi.sendReactionMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        targetMessageId: args.targetMessageId,
        emoji: args.emoji,
      });
      return { messageId: result.messageId, deliveredTo: args.to };
    },

    // Meta hands out a media *id*; turning it into bytes takes two
    // authenticated calls — resolve the short-lived CDN URL, then
    // download it.
    async fetchInboundMedia(ref: string) {
      const { url } = await metaApi.getMediaUrl({ mediaId: ref, accessToken });
      return metaApi.downloadMedia({ downloadUrl: url, accessToken });
    },
  };
}
