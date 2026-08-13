// ============================================================
// CPF / CNPJ — normalise, validate, mask.
//
// Asaas requires `cpfCnpj` on every customer, and nothing in this
// schema held the ACCOUNT OWNER's document before (the `contacts`
// table holds *their* customers' details, not theirs). So this is
// genuinely new PII we collect, and it is collected once, right
// before the first subscribe — never on the signup form, where a
// required document measurably hurts conversion for a value we
// don't need until someone actually pays.
//
// Pure and shared: the exact same validation runs in the browser
// (instant feedback in the dialog) and in the route handler (the
// one that actually matters). A client-only check would let a
// crafted request create a broken Asaas customer.
//
// Storage: the normalised digits are encrypted with the existing
// AES-256-GCM helper (src/lib/whatsapp/encryption.ts) into
// `accounts.billing_cpf_cnpj_encrypted`; only `..._last4` is kept
// in the clear so the UI can render a mask without a decrypt.
// ============================================================

/** Strip every non-digit. `123.456.789-09` -> `12345678909`. */
export function normalizeCpfCnpj(value: string): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * Check digits for CPF (11 digits) or CNPJ (14 digits).
 *
 * Rejects the repeated-digit sequences (`111.111.111-11`,
 * `00000000000000`, ...) explicitly: they satisfy the modulus
 * arithmetic but are not issuable documents, and they are exactly
 * what a user types to get past a lazy validator. Asaas rejects
 * them downstream anyway — better to fail here with a clear message
 * than to surface a raw gateway error.
 */
export function isValidCpfCnpj(value: string): boolean {
  const digits = normalizeCpfCnpj(value);
  if (digits.length === 11) return isValidCpf(digits);
  if (digits.length === 14) return isValidCnpj(digits);
  return false;
}

function allSameDigit(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

function isValidCpf(digits: string): boolean {
  if (allSameDigit(digits)) return false;

  // Two check digits, each a weighted sum mod 11 over the preceding
  // digits, with remainders of 10/11 collapsing to 0.
  for (let checkIndex = 9; checkIndex < 11; checkIndex++) {
    let sum = 0;
    for (let i = 0; i < checkIndex; i++) {
      sum += Number(digits[i]) * (checkIndex + 1 - i);
    }
    const remainder = (sum * 10) % 11;
    const expected = remainder === 10 || remainder === 11 ? 0 : remainder;
    if (expected !== Number(digits[checkIndex])) return false;
  }
  return true;
}

function isValidCnpj(digits: string): boolean {
  if (allSameDigit(digits)) return false;

  // CNPJ weights cycle 2..9 from the right, which is why they're
  // spelled out rather than derived from the index.
  const firstWeights = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const secondWeights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  const checkDigit = (weights: number[]): number => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += Number(digits[i]) * weights[i];
    }
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  if (checkDigit(firstWeights) !== Number(digits[12])) return false;
  if (checkDigit(secondWeights) !== Number(digits[13])) return false;
  return true;
}

/** The last four digits, for `accounts.billing_cpf_cnpj_last4`. */
export function lastFour(value: string): string {
  return normalizeCpfCnpj(value).slice(-4);
}

/**
 * Display mask built from the stored last4 alone — the plaintext
 * document never leaves the server, so the UI has nothing else to
 * work with. `1234` -> `•••.•••.•••-1234`.
 */
export function maskFromLastFour(last4: string | null | undefined): string {
  if (!last4) return '';
  return `•••.•••.•••-${last4}`;
}

/**
 * Format a full document for display in an input as the user types.
 * CPF: `123.456.789-09`. CNPJ: `12.345.678/0001-95`. A half-typed
 * value keeps the separators it has earned so far and nothing more,
 * so the caret doesn't jump around mid-entry.
 */
export function maskCpfCnpj(value: string): string {
  const digits = normalizeCpfCnpj(value);

  if (digits.length <= 11) {
    return digits
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
  }

  return digits
    .slice(0, 14)
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3/$4')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/, '$1.$2.$3/$4-$5');
}
