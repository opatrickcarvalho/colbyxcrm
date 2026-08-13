import { describe, expect, it } from 'vitest';

import {
  isValidCpfCnpj,
  lastFour,
  maskCpfCnpj,
  maskFromLastFour,
  normalizeCpfCnpj,
} from './cpf';

// All documents below are synthetic — constructed to satisfy (or
// deliberately fail) the check-digit algorithm. Never put a real
// CPF/CNPJ in a test file.

const VALID_CPF = '11144477735';
const VALID_CPF_FORMATTED = '111.444.777-35';
const VALID_CNPJ = '11222333000181';
const VALID_CNPJ_FORMATTED = '11.222.333/0001-81';

describe('normalizeCpfCnpj', () => {
  it('strips punctuation and whitespace', () => {
    expect(normalizeCpfCnpj(VALID_CPF_FORMATTED)).toBe(VALID_CPF);
    expect(normalizeCpfCnpj(VALID_CNPJ_FORMATTED)).toBe(VALID_CNPJ);
    expect(normalizeCpfCnpj(' 111 444 777 35 ')).toBe(VALID_CPF);
  });

  it('survives empty and junk input', () => {
    expect(normalizeCpfCnpj('')).toBe('');
    expect(normalizeCpfCnpj('abc')).toBe('');
  });
});

describe('isValidCpfCnpj — CPF', () => {
  it('accepts a valid CPF with or without punctuation', () => {
    expect(isValidCpfCnpj(VALID_CPF)).toBe(true);
    expect(isValidCpfCnpj(VALID_CPF_FORMATTED)).toBe(true);
  });

  it('rejects a CPF with a bad check digit', () => {
    expect(isValidCpfCnpj('11144477734')).toBe(false);
    expect(isValidCpfCnpj('11144477725')).toBe(false);
  });

  it('rejects repeated-digit sequences', () => {
    // These satisfy the modulus arithmetic but are not issuable, and
    // they are exactly what a user types to get past a lazy
    // validator. Asaas rejects them downstream — fail here instead,
    // with a message the customer can act on.
    for (let d = 0; d <= 9; d++) {
      expect(isValidCpfCnpj(String(d).repeat(11))).toBe(false);
    }
  });

  it('rejects wrong lengths', () => {
    expect(isValidCpfCnpj('1114447773')).toBe(false);
    expect(isValidCpfCnpj('111444777351')).toBe(false);
    expect(isValidCpfCnpj('')).toBe(false);
  });
});

describe('isValidCpfCnpj — CNPJ', () => {
  it('accepts a valid CNPJ with or without punctuation', () => {
    expect(isValidCpfCnpj(VALID_CNPJ)).toBe(true);
    expect(isValidCpfCnpj(VALID_CNPJ_FORMATTED)).toBe(true);
  });

  it('rejects a CNPJ with a bad check digit', () => {
    expect(isValidCpfCnpj('11222333000182')).toBe(false);
    expect(isValidCpfCnpj('11222333000191')).toBe(false);
  });

  it('rejects repeated-digit sequences', () => {
    for (let d = 0; d <= 9; d++) {
      expect(isValidCpfCnpj(String(d).repeat(14))).toBe(false);
    }
  });
});

describe('lastFour / maskFromLastFour', () => {
  it('takes the last four digits after normalising', () => {
    expect(lastFour(VALID_CPF_FORMATTED)).toBe('7735');
    expect(lastFour(VALID_CNPJ_FORMATTED)).toBe('0181');
  });

  it('renders a mask that reveals only the last four', () => {
    const masked = maskFromLastFour(lastFour(VALID_CPF));
    expect(masked).toBe('•••.•••.•••-7735');
    // The plaintext document never reaches the client, so nothing
    // beyond the last four may appear.
    expect(masked).not.toContain('111');
    expect(masked).not.toContain('444');
  });

  it('renders nothing when there is no stored last4', () => {
    expect(maskFromLastFour(null)).toBe('');
    expect(maskFromLastFour(undefined)).toBe('');
    expect(maskFromLastFour('')).toBe('');
  });
});

describe('maskCpfCnpj — as-you-type formatting', () => {
  it('formats a complete CPF and CNPJ', () => {
    expect(maskCpfCnpj(VALID_CPF)).toBe(VALID_CPF_FORMATTED);
    expect(maskCpfCnpj(VALID_CNPJ)).toBe(VALID_CNPJ_FORMATTED);
  });

  it('adds separators only as they are earned', () => {
    expect(maskCpfCnpj('111')).toBe('111');
    expect(maskCpfCnpj('1114')).toBe('111.4');
    expect(maskCpfCnpj('1114447')).toBe('111.444.7');
    expect(maskCpfCnpj('1114447773')).toBe('111.444.777-3');
  });

  it('stops at 14 digits', () => {
    expect(maskCpfCnpj(VALID_CNPJ + '999')).toBe(VALID_CNPJ_FORMATTED);
  });
});
