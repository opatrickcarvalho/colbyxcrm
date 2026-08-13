import { describe, expect, it } from 'vitest';

import { HANDLED_EVENT_TYPES, resolveEventEffect } from './events';

describe('resolveEventEffect — documented event types', () => {
  it.each<[string, string]>([
    ['PAYMENT_CREATED', 'record_invoice'],
    ['PAYMENT_UPDATED', 'record_invoice'],
    ['PAYMENT_RESTORED', 'record_invoice'],
    ['PAYMENT_CONFIRMED', 'apply_paid'],
    ['PAYMENT_RECEIVED', 'apply_paid'],
    ['PAYMENT_RECEIVED_IN_CASH', 'apply_paid'],
    ['PAYMENT_OVERDUE', 'mark_past_due'],
    ['PAYMENT_REFUNDED', 'reverse'],
    ['PAYMENT_DELETED', 'reverse'],
    ['PAYMENT_CHARGEBACK_REQUESTED', 'reverse'],
  ])('%s => %s', (event, effect) => {
    expect(resolveEventEffect(event)).toBe(effect);
  });

  it('maps CONFIRMED and RECEIVED to the same effect', () => {
    // Asaas fires both for the SAME payment.id — "confirmed" means
    // the provider accepted it, "received" means the funds landed.
    // Either grants access; the guard against granting TWO cycles is
    // the `period_end IS NULL` condition in the store, not a
    // distinction here.
    expect(resolveEventEffect('PAYMENT_CONFIRMED')).toBe(
      resolveEventEffect('PAYMENT_RECEIVED')
    );
  });

  it('does not claw back access for a refund that is only requested', () => {
    expect(resolveEventEffect('PAYMENT_REFUND_IN_PROGRESS')).toBe('ignore');
    expect(resolveEventEffect('PAYMENT_REFUNDED')).toBe('reverse');
  });

  it('leaves the horizon alone when an invoice merely lapses', () => {
    // past_due is a label. The customer paid for the window they are
    // in; the grace period covers the tail. Rolling plan_expires_at
    // back here would lock out someone who is still inside the
    // period they bought.
    expect(resolveEventEffect('PAYMENT_OVERDUE')).toBe('mark_past_due');
  });
});

describe('resolveEventEffect — unknown input never throws', () => {
  // 15 consecutive non-2xx responses INTERRUPT the entire Asaas
  // webhook queue until someone reactivates it by hand, and
  // undelivered events are deleted after 14 days. Asaas adds event
  // types without notice. A throw here would take billing down for
  // every tenant at once, days before anyone noticed.
  it.each<[string, unknown]>([
    ['a brand-new Asaas event type', 'SOMETHING_NEW'],
    ['a non-payment event', 'TRANSFER_CREATED'],
    ['lowercase', 'payment_received'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', { event: 'PAYMENT_RECEIVED' }],
  ])('%s => ignore', (_label, input) => {
    expect(() => resolveEventEffect(input)).not.toThrow();
    expect(resolveEventEffect(input)).toBe('ignore');
  });

  it('is not fooled by prototype keys', () => {
    // A plain-object lookup table must not answer for "constructor"
    // or "toString".
    expect(resolveEventEffect('constructor')).toBe('ignore');
    expect(resolveEventEffect('toString')).toBe('ignore');
    expect(resolveEventEffect('__proto__')).toBe('ignore');
  });
});

describe('HANDLED_EVENT_TYPES', () => {
  it('lists only the events that actually change state', () => {
    expect(HANDLED_EVENT_TYPES).toContain('PAYMENT_CONFIRMED');
    expect(HANDLED_EVENT_TYPES).toContain('PAYMENT_REFUNDED');
    expect(HANDLED_EVENT_TYPES).not.toContain('PAYMENT_REFUND_IN_PROGRESS');
  });

  it('every listed type resolves to something other than ignore', () => {
    for (const event of HANDLED_EVENT_TYPES) {
      expect(resolveEventEffect(event)).not.toBe('ignore');
    }
  });
});
