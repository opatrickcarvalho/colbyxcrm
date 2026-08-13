// ============================================================
// Asaas resource calls — customers and subscriptions.
//
// Thin wrappers over asaasFetch. All the interesting decisions live
// in the callers; what's encoded here is the shape of the requests
// and the cents/reais boundary.
// ============================================================

import { asaasFetch } from './client';
import type {
  AsaasCustomer,
  AsaasList,
  AsaasPayment,
  AsaasSubscription,
} from './types';
import type { AsaasCycle } from '../cycles';

// ------------------------------------------------------------
// Currency
//
// We store integer cents; Asaas speaks decimal reais. Every
// conversion goes through these two so the rounding rule is stated
// once. Math.round on the way in matters: 19.99 * 100 is
// 1998.9999999999998 in IEEE 754, and truncating would undercharge
// by a cent on a large fraction of prices.
// ------------------------------------------------------------

export function toReais(cents: number): number {
  return Math.round(cents) / 100;
}

export function toCents(reais: number | null | undefined): number {
  if (typeof reais !== 'number' || !Number.isFinite(reais)) return 0;
  return Math.round(reais * 100);
}

// ------------------------------------------------------------
// Customers
// ------------------------------------------------------------

export interface CreateCustomerInput {
  name: string;
  /** Digits only. Asaas requires it — see src/lib/billing/cpf.ts. */
  cpfCnpj: string;
  email?: string | null;
  mobilePhone?: string | null;
  /** Always `accounts.id`, so support can trace a charge back. */
  externalReference: string;
}

export async function createAsaasCustomer(
  input: CreateCustomerInput
): Promise<AsaasCustomer> {
  return asaasFetch<AsaasCustomer>('/customers', {
    method: 'POST',
    body: {
      name: input.name,
      cpfCnpj: input.cpfCnpj,
      email: input.email ?? undefined,
      mobilePhone: input.mobilePhone ?? undefined,
      externalReference: input.externalReference,
      // Let Asaas send its own invoice / due-date emails. They are
      // in Portuguese, they carry the payment link, and rebuilding
      // that reliably is a project of its own.
      notificationDisabled: false,
    },
  });
}

// ------------------------------------------------------------
// Subscriptions
// ------------------------------------------------------------

export interface CreateSubscriptionInput {
  customerId: string;
  cycle: AsaasCycle;
  valueCents: number;
  /** `YYYY-MM-DD` in São Paulo time — see expiry.todayInSaoPaulo. */
  nextDueDate: string;
  description: string;
  /** Always `accounts.id`. THE webhook's primary account key. */
  externalReference: string;
  /** Where Asaas sends the customer after a successful payment. */
  successUrl?: string;
}

export async function createAsaasSubscription(
  input: CreateSubscriptionInput
): Promise<AsaasSubscription> {
  return asaasFetch<AsaasSubscription>('/subscriptions', {
    method: 'POST',
    body: {
      customer: input.customerId,
      // UNDEFINED lets the customer choose PIX, boleto or card on
      // Asaas's hosted invoice. That keeps card data entirely off
      // our infrastructure — no PCI surface, no card form to build.
      billingType: 'UNDEFINED',
      value: toReais(input.valueCents),
      nextDueDate: input.nextDueDate,
      cycle: input.cycle,
      description: input.description.slice(0, 500),
      externalReference: input.externalReference,
      callback: input.successUrl
        ? { successUrl: input.successUrl, autoRedirect: true }
        : undefined,
    },
  });
}

/**
 * The invoices Asaas has generated for a subscription, newest first.
 *
 * Needed because `POST /v3/subscriptions` does NOT return an
 * `invoiceUrl` — the subscription is a schedule, not a charge. The
 * payable link lives on the first payment, which Asaas creates
 * moments later. The subscribe route reads it from here; if it isn't
 * there yet, the PAYMENT_CREATED webhook fills it in within seconds.
 *
 * Also used by the hourly sweep to reconcile a subscription stuck in
 * `pending` — that's the safety net for a webhook lost while the
 * Asaas queue was interrupted.
 */
export async function listSubscriptionPayments(
  subscriptionId: string,
  limit = 10
): Promise<AsaasPayment[]> {
  const result = await asaasFetch<AsaasList<AsaasPayment>>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}/payments`,
    { query: { limit, offset: 0 } }
  );
  return Array.isArray(result?.data) ? result.data : [];
}

/**
 * Stop future invoices. Already-issued unpaid invoices are removed
 * by Asaas along with the subscription.
 *
 * Deliberately does NOT touch `accounts.plan_expires_at`: the
 * customer keeps the window they already paid for. Cancelling is not
 * a refund.
 */
export async function cancelAsaasSubscription(
  subscriptionId: string
): Promise<void> {
  await asaasFetch<{ deleted?: boolean }>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: 'DELETE' }
  );
}
