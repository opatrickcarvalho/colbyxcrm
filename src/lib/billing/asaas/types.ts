// ============================================================
// Asaas API v3 — the shapes we actually consume.
//
// Deliberately partial. Asaas ships new attributes on webhooks
// WITHOUT notice (their docs say so explicitly), so every interface
// here carries an index signature and every optional field is
// genuinely optional. Nothing in this codebase should ever throw
// because a payload grew a key.
//
// Types only — no runtime, no env reads, safe to import anywhere
// including client components that just need the cycle union.
// ============================================================

import type { AsaasCycle } from '../cycles';

/**
 * `UNDEFINED` is the one we use for self-serve: it lets the
 * customer pick PIX / boleto / card on Asaas's hosted invoice page,
 * which keeps card data entirely off our infrastructure.
 */
export type AsaasBillingType = 'BOLETO' | 'CREDIT_CARD' | 'PIX' | 'UNDEFINED';

export interface AsaasCustomer {
  object?: 'customer';
  id: string;
  name?: string;
  email?: string | null;
  cpfCnpj?: string;
  mobilePhone?: string | null;
  /** We always set this to `accounts.id`. */
  externalReference?: string | null;
  [key: string]: unknown;
}

export type AsaasSubscriptionStatus = 'ACTIVE' | 'EXPIRED' | 'INACTIVE';

export interface AsaasSubscription {
  object?: 'subscription';
  id: string;
  customer: string;
  billingType: AsaasBillingType;
  cycle: AsaasCycle;
  /** Reais, not cents — Asaas speaks decimal currency. */
  value: number;
  /** `YYYY-MM-DD`. */
  nextDueDate: string;
  status?: AsaasSubscriptionStatus;
  description?: string | null;
  externalReference?: string | null;
  deleted?: boolean;
  [key: string]: unknown;
}

/**
 * Asaas payment status. Listed for readability; never exhaustively
 * switched on — `subscription_payments.status` stores whatever
 * string arrives, verbatim.
 */
export type AsaasPaymentStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'RECEIVED'
  | 'OVERDUE'
  | 'REFUNDED'
  | 'RECEIVED_IN_CASH'
  | 'REFUND_REQUESTED'
  | 'CHARGEBACK_REQUESTED'
  | 'CHARGEBACK_DISPUTE'
  | 'AWAITING_CHARGEBACK_REVERSAL'
  | 'DUNNING_REQUESTED'
  | 'DUNNING_RECEIVED'
  | 'AWAITING_RISK_ANALYSIS';

export interface AsaasPayment {
  object?: 'payment';
  id: string;
  customer?: string;
  /** The Asaas subscription id this invoice belongs to, if any. */
  subscription?: string | null;
  status: string;
  billingType?: string | null;
  /** Reais. Converted to cents at the boundary — never stored raw. */
  value?: number;
  /** `YYYY-MM-DD`. */
  dueDate?: string | null;
  /** ISO date-time when Asaas confirmed / received it. */
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
  /** THE hosted page where the customer picks PIX/boleto/card. */
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  /** We always set this to `accounts.id` on the subscription. */
  externalReference?: string | null;
  [key: string]: unknown;
}

/**
 * The webhook envelope.
 *
 * `id` is the `evt_…` identifier and is our idempotency key
 * (`asaas_events.event_id` UNIQUE). Delivery is AT LEAST ONCE, so
 * duplicates are normal traffic, not an error condition.
 */
export interface AsaasWebhookEvent {
  id?: string;
  event: string;
  dateCreated?: string;
  payment?: AsaasPayment;
  [key: string]: unknown;
}

/** `GET /v3/subscriptions/{id}/payments` and friends. */
export interface AsaasList<T> {
  object?: 'list';
  hasMore?: boolean;
  totalCount?: number;
  limit?: number;
  offset?: number;
  data: T[];
}
