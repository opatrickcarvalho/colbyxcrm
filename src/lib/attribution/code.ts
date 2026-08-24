// ============================================================
// Ad-campaign tracking codes.
//
// A code identifies an `ad_campaigns` row and travels inside a WhatsApp
// message's text — either dynamically substituted by the /l/{code}
// redirect (src/app/l/[code]/route.ts) or pasted once, by hand, into a
// native Meta "Click to WhatsApp" ad's own prefilled-message field
// (that ad type has no URL hop for our redirect to sit in). Either way
// the inbound webhook extracts it with `extractCampaignCode` to
// attribute a brand-new contact.
// ============================================================

import { randomInt } from 'node:crypto';

// Excludes 0/O and 1/I — an operator reads this off a screen to paste
// into Meta Ads Manager, and those pairs are the classic transcription
// mistake.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const CAMPAIGN_CODE_LENGTH = 6;

// Matches a '#' followed by 4-8 uppercase-alnum characters anywhere in
// a message, case-insensitively (WhatsApp clients vary in whether they
// preserve the case of a prefilled message once the user edits it).
export const CAMPAIGN_CODE_PATTERN = /#([A-Z0-9]{4,8})/i;

/** A fresh random code in {@link ALPHABET}, {@link CAMPAIGN_CODE_LENGTH} long. */
export function generateCampaignCode(): string {
  let code = '';
  for (let i = 0; i < CAMPAIGN_CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/**
 * Pull a tracking code out of an inbound message's text, or null if
 * none is present. Always uppercase, matching how codes are generated.
 */
export function extractCampaignCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = CAMPAIGN_CODE_PATTERN.exec(text);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Render a campaign's message_template by substituting the literal
 * `{code}` placeholder with its own code.
 */
export function renderPrefilledMessage(template: string, code: string): string {
  return template.replace('{code}', code);
}
