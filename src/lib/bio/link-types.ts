// ============================================================
// Bio-page link types — shared between the dashboard editor and the
// API validation, so both agree on the type/url/ad_campaign_id shape
// enforced by the `bio_page_links_type_shape` CHECK constraint
// (071_bio_pages.sql).
// ============================================================

export const BIO_LINK_TYPES = ['link', 'whatsapp', 'whatsapp_group', 'social', 'embed'] as const;
export type BioLinkType = (typeof BIO_LINK_TYPES)[number];

export function isBioLinkType(value: unknown): value is BioLinkType {
  return typeof value === 'string' && (BIO_LINK_TYPES as readonly string[]).includes(value);
}

/** type=social icon values — a fixed, known set rendered with a dedicated brand icon. */
export const SOCIAL_PLATFORMS = [
  'instagram',
  'tiktok',
  'facebook',
  'youtube',
  'twitter',
  'linkedin',
  'telegram',
  'email',
  'phone',
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

export const BIO_LINK_TYPE_LABELS: Record<BioLinkType, string> = {
  link: 'Link',
  whatsapp: 'WhatsApp',
  whatsapp_group: 'Grupo do WhatsApp (fila automática)',
  social: 'Rede social',
  embed: 'Vídeo/áudio embutido',
};
