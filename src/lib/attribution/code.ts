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
//
// Codes are operator-chosen and human-readable (e.g. "SalvadosCardoso",
// the business's own Instagram handle or name) — an auto-generated
// random string like "RGQ8X6" reads as spam in a prefilled message.
// `generateCampaignCode` still exists as the fallback when an operator
// leaves the field blank or their chosen slug collides.
//
// Matching is always case-insensitive against `ad_campaigns.code_key`
// (lower(code), see 070_ad_campaigns_readable_code.sql) — never against
// `code` directly, and this module never uppercases/lowercases a code
// on the way OUT, so the operator's original casing survives into the
// rendered message.
// ============================================================

import { randomInt } from 'node:crypto';

// Excludes 0/O and 1/I — used only for the random fallback, read off a
// screen and retyped, where those pairs are the classic transcription
// mistake. Not applied to operator-chosen codes.
const FALLBACK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const CAMPAIGN_CODE_LENGTH = 6;

// A '@' or '#' followed by 3-30 word characters, anywhere in a message.
// '@' is the primary form now (reads like citing a handle: "vim do
// anúncio @SalvadosCardoso"); '#' stays supported for campaigns created
// before this change. A false-positive match (an email's "@gmail" from
// unrelated chatter, say) is harmless — the caller looks the captured
// text up against real campaign codes and simply finds nothing.
export const CAMPAIGN_CODE_PATTERN = /[@#]([A-Za-z0-9_]{3,30})/;

/** A fresh random code, for when no operator-chosen slug is available. */
export function generateCampaignCode(): string {
  let code = '';
  for (let i = 0; i < CAMPAIGN_CODE_LENGTH; i++) {
    code += FALLBACK_ALPHABET[randomInt(FALLBACK_ALPHABET.length)];
  }
  return code;
}

/**
 * Pull a tracking code out of an inbound message's text, or null if
 * none is present. Returns the raw captured text, unmodified — callers
 * compare it against `code_key` (lower-cased) rather than normalising
 * it here.
 */
export function extractCampaignCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = CAMPAIGN_CODE_PATTERN.exec(text);
  return match ? match[1] : null;
}

/**
 * Render a campaign's message_template by substituting the literal
 * `{code}` placeholder with its own code (original casing).
 */
export function renderPrefilledMessage(template: string, code: string): string {
  return template.replace('{code}', code);
}

const COMBINING_DIACRITICS = /[̀-ͯ]/g;

/**
 * Turn free-typed input (a campaign name, an Instagram handle) into a
 * safe tracking code: strips accents and anything that isn't a letter,
 * digit, or underscore — the code sits in a URL path segment and right
 * after @/# in a chat message, so spaces and punctuation don't survive
 * either place cleanly. Casing is preserved.
 */
export function slugifyCampaignCode(input: string): string {
  return input
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 30);
}
