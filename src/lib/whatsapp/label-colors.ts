/**
 * Approximate hex swatches for uazapi's fixed 0-19 label color-code
 * palette (POST /label/edit's `color` field). WhatsApp doesn't publish
 * exact values, so these are a reasonable stand-in — good enough to
 * tell labels apart at a glance, which is all the chip UI needs.
 */
export const WHATSAPP_LABEL_COLORS: readonly string[] = [
  '#FF9485', // 0
  '#FFB444', // 1
  '#FFD429', // 2
  '#A0E572', // 3
  '#61E0B8', // 4
  '#57DBE0', // 5
  '#5AC8FA', // 6
  '#6E93FA', // 7
  '#9B8CFA', // 8
  '#D48CF5', // 9
  '#F582C5', // 10
  '#F56E7E', // 11
  '#E85D5D', // 12
  '#D97706', // 13
  '#CA9A2D', // 14
  '#65A30D', // 15
  '#0D9488', // 16
  '#0284C7', // 17
  '#7C3AED', // 18
  '#BE185D', // 19
];

export function whatsappLabelColor(colorCode: number): string {
  return WHATSAPP_LABEL_COLORS[colorCode] ?? WHATSAPP_LABEL_COLORS[0];
}
