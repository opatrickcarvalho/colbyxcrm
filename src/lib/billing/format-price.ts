// ============================================================
// Price display for the billing UI.
//
// Deliberately separate from src/lib/currency.ts's formatCurrency():
// that one is tuned for whole-dollar CRM deal values (zero decimals).
// A subscription price like R$ 29,90 needs cents, so this keeps its
// own two-decimal formatter rather than stripping precision off an
// unrelated feature's helper.
// ============================================================

export function formatPriceCents(cents: number, currency: string): string {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: currency || 'BRL',
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
