import { describe, expect, it } from 'vitest';
import { countVariants, renderMessage, validateSpintax } from './spintax';

/** rng that always returns 0 — every rotation/emoji draw picks index 0. */
const first = () => 0;

/** rng that always returns just under 1 — every draw picks the last index. */
const last = () => 0.999999;

/** rng that replays a fixed queue of values, one per call, for scripted picks. */
function scripted(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe('renderMessage — rotation', () => {
  it('picks a flat rotation option deterministically', () => {
    expect(renderMessage('{a|b|c}', { rng: first })).toBe('a');
    expect(renderMessage('{a|b|c}', { rng: last })).toBe('c');
  });

  it('supports nested rotation groups', () => {
    // Outer picks index 1 ({Oi|E ai}), inner then picks index 0 (Oi).
    const out = renderMessage('{Ola|{Oi|E ai}} tudo bem', {
      rng: scripted([1, 0]),
    });
    expect(out).toBe('Oi tudo bem');
  });

  it('allows an empty option in a rotation group', () => {
    expect(renderMessage('{|!}', { rng: first })).toBe('');
    expect(renderMessage('{|!}', { rng: last })).toBe('!');
  });

  it('is fully deterministic for a given seeded rng', () => {
    const template = '{Oi|Ola}, {{nome}}! {bom|otimo} dia';
    const vars = { nome: 'Ana' };
    // A fresh rng per call: `scripted` is stateful, so reusing one instance
    // across calls would desync the picks instead of proving determinism.
    const run = () => renderMessage(template, { rng: scripted([0, 1]), vars });
    expect(run()).toBe(run());
    expect(run()).toBe('Oi, Ana! otimo dia');
  });
});

describe('renderMessage — escapes', () => {
  it('treats \\{, \\} and \\| as literal characters', () => {
    expect(renderMessage('\\{a\\|b\\}')).toBe('{a|b}');
  });

  it('does not parse an escaped brace as a rotation group', () => {
    expect(renderMessage('\\{Oi|Ola\\}', { rng: first })).toBe('{Oi|Ola}');
  });
});

describe('renderMessage — variables', () => {
  it('substitutes known variables from options.vars', () => {
    const out = renderMessage('Ola {{primeiro_nome}}, tudo bem?', {
      vars: { primeiro_nome: 'Joao' },
    });
    expect(out).toBe('Ola Joao, tudo bem?');
  });

  it('replaces an unknown or undefined variable with "" and collapses the resulting double space', () => {
    const out = renderMessage('Ola {{nome}} tudo bem?', { vars: {} });
    expect(out).toBe('Ola tudo bem?');
    expect(out).not.toMatch(/ {2,}/);
  });

  it('resolves variables after rotation and never re-parses a value for spintax', () => {
    const out = renderMessage('{Oi|Ola} {{nome}}', {
      rng: first,
      vars: { nome: '{a|b}' },
    });
    // The contact's name is literally "{a|b}" — it must survive intact,
    // not be treated as a second rotation group.
    expect(out).toBe('Oi {a|b}');
  });

  it('draws {{emoji}} independently per occurrence', () => {
    const out = renderMessage('Oi {{emoji}} tudo bem {{emoji}}', {
      rng: scripted([0, 0.999999]),
    });
    const parts = out.split(' ');
    expect(parts[1]).not.toBe(parts[4]);
    // Both slots resolved to a single emoji character, not text/undefined.
    expect(parts[1]).toMatch(/\p{Extended_Pictographic}/u);
    expect(parts[4]).toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('renderMessage — invisibleChars', () => {
  const words = Array.from({ length: 30 }, (_, i) => `w${i + 1}`).join(' ');

  const ZWSP = '​';

  it('inserts no zero-width spaces by default', () => {
    expect(renderMessage(words).split(ZWSP).length - 1).toBe(0);
  });

  it('inserts a zero-width space after roughly every 12th word, capped at 5', () => {
    const out = renderMessage(words, { invisibleChars: true });
    const count = out.split(ZWSP).length - 1;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(5);
    // The stripped text (zero-width spaces removed) must be unchanged.
    expect(out.split(ZWSP).join('')).toBe(words);
  });
});

describe('renderMessage — malformed input', () => {
  it('never throws on unbalanced braces and strips the syntax instead', () => {
    expect(() => renderMessage('{a|b')).not.toThrow();
    expect(renderMessage('{a|b')).toBe('ab');

    expect(() => renderMessage('a} b')).not.toThrow();
    expect(renderMessage('a} b')).toBe('a b');

    expect(() => renderMessage('{{a|b}')).not.toThrow();
  });

  it('keeps escaped characters literal even on the malformed fallback path', () => {
    expect(renderMessage('\\{unterminated {a')).toBe('{unterminated a');
  });
});

describe('validateSpintax', () => {
  it('accepts balanced templates, including nested groups and variables', () => {
    expect(validateSpintax('{Ola|{Oi|E ai}} {{nome}}')).toEqual({ ok: true });
  });

  it('reports an unterminated group', () => {
    const result = validateSpintax('{a|b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unterminated/i);
  });

  it('reports an unmatched closing brace', () => {
    const result = validateSpintax('a} b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unmatched/i);
  });
});

describe('countVariants', () => {
  it('returns 1 for a template with no rotation groups', () => {
    expect(countVariants('Ola {{nome}}, tudo bem?')).toBe(1);
  });

  it('multiplies across groups and recurses into nested groups', () => {
    // First group: 3 options. Second group: "Oi" | "E ai" | {Ola|Fala} (2)
    // -> 1 + 1 + 2 = 4. Total = 3 * 4 = 12.
    expect(countVariants('{a|b|c} {Oi|E ai|{Ola|Fala}}')).toBe(12);
  });

  it('counts an empty option as one variant', () => {
    expect(countVariants('{|a|b}')).toBe(3);
  });

  it('caps the result at Number.MAX_SAFE_INTEGER without overflowing', () => {
    const wideGroup = `{${Array.from({ length: 20 }, (_, i) => `o${i}`).join('|')}}`;
    const template = Array.from({ length: 15 }, () => wideGroup).join(' ');
    const count = countVariants(template);
    expect(count).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(count)).toBe(true);
  });

  it('returns 1 for a malformed template (same as its render fallback)', () => {
    expect(countVariants('{a|b')).toBe(1);
  });
});
