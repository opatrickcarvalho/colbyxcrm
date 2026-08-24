/**
 * Build a wa.me deep link that opens a chat with `connectedNumber` and
 * pre-fills the compose box with `prefilledText`.
 *
 * `connectedNumber` must be digits-only (no `+`), matching how
 * `whatsapp_config.connected_number` is stored.
 */
export function buildWaMeUrl(connectedNumber: string, prefilledText: string): string {
  return `https://wa.me/${connectedNumber}?text=${encodeURIComponent(prefilledText)}`;
}
