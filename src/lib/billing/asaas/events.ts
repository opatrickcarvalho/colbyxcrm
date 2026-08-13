// ============================================================
// Webhook event -> state effect.
//
// A pure reducer, isolated from the route so it can be tested
// exhaustively. The webhook handler's job is then only: store the
// payload, ask this function what to do, do it, answer 200.
//
// THE RULE: never throw, never fall through to something
// destructive. An unrecognised event returns 'ignore'.
//
// Why that matters more than usual here: 15 consecutive non-2xx
// responses INTERRUPT the entire Asaas webhook queue until someone
// reactivates it by hand, and undelivered events are deleted after
// 14 days. A `default:` that threw on the next event type Asaas
// invents would take down billing for every tenant at once, days
// before anyone noticed. Asaas adds event types without notice.
// ============================================================

/**
 * What the webhook handler should do with an event.
 *
 * - `record_invoice` — a charge exists; store/refresh the invoice
 *   row and its URL. Grants nothing.
 * - `apply_paid`     — money arrived; push `plan_expires_at`
 *   forward by one cycle. Guarded so it can only happen once per
 *   `asaas_payment_id` (see `period_end IS NULL` in store.ts).
 * - `mark_past_due`  — the invoice lapsed. Labels only:
 *   `plan_expires_at` is deliberately NOT rolled back, because the
 *   customer already paid for the window they're in and the grace
 *   period is what covers the tail.
 * - `reverse`        — refund / chargeback / deletion. Claw the
 *   horizon back to that payment's `period_start`.
 * - `ignore`         — everything else, including unknown types.
 */
export type AsaasEventEffect =
  'record_invoice' | 'apply_paid' | 'mark_past_due' | 'reverse' | 'ignore';

/**
 * Note that both PAYMENT_CONFIRMED and PAYMENT_RECEIVED map to
 * `apply_paid`. Asaas fires them for the SAME payment.id —
 * "confirmed" means the provider accepted it, "received" means the
 * funds landed — and either one is good enough to grant access.
 * The idempotency that stops this from granting two cycles lives in
 * the store (`WHERE asaas_payment_id = $1 AND period_end IS NULL`),
 * not here, because it is a database-level race, not a mapping
 * question.
 */
const EFFECTS: Readonly<Record<string, AsaasEventEffect>> = {
  PAYMENT_CREATED: 'record_invoice',
  PAYMENT_UPDATED: 'record_invoice',
  PAYMENT_RESTORED: 'record_invoice',

  PAYMENT_CONFIRMED: 'apply_paid',
  PAYMENT_RECEIVED: 'apply_paid',
  PAYMENT_RECEIVED_IN_CASH: 'apply_paid',

  PAYMENT_OVERDUE: 'mark_past_due',

  PAYMENT_REFUNDED: 'reverse',
  PAYMENT_DELETED: 'reverse',
  PAYMENT_CHARGEBACK_REQUESTED: 'reverse',

  // Listed explicitly so the intent is on the record: a refund that
  // is merely *requested* must not claw back access. Only the
  // terminal PAYMENT_REFUNDED does.
  PAYMENT_REFUND_IN_PROGRESS: 'ignore',
};

/**
 * Map an Asaas `event` string to its effect.
 *
 * Unknown types return 'ignore' rather than throwing — see the
 * queue-interruption note at the top of this file. The event is
 * still persisted in `asaas_events` with the raw payload, so
 * nothing is lost: a type we later decide to handle can be replayed
 * from the table.
 */
export function resolveEventEffect(eventType: unknown): AsaasEventEffect {
  if (typeof eventType !== 'string') return 'ignore';
  // Own-property check, not `EFFECTS[x] ?? 'ignore'`: a plain object
  // answers for inherited keys, so an event literally named
  // "constructor" or "toString" would resolve to a Function and be
  // handed to the webhook's switch. `??` does not catch that — the
  // value isn't nullish, it's just wrong.
  if (!Object.hasOwn(EFFECTS, eventType)) return 'ignore';
  return EFFECTS[eventType];
}

/** The event types this file knowingly acts on. Test surface. */
export const HANDLED_EVENT_TYPES: readonly string[] = Object.keys(
  EFFECTS
).filter((key) => EFFECTS[key] !== 'ignore');
