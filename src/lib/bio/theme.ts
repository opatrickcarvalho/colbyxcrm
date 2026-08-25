// ============================================================
// Bio-page theming — button background color + font color, the two
// knobs the dashboard editor exposes. Kept as plain hex strings
// (validated, not free CSS) so they're safe to drop straight into an
// inline `style` object with no injection surface.
// ============================================================

export const DEFAULT_BUTTON_COLOR = '#171717'; // matches the old bg-neutral-900 button
export const DEFAULT_TEXT_COLOR = '#f5f5f5'; // matches the old text-neutral-100 default

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}
