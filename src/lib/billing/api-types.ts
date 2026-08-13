// ============================================================
// Wire types shared between GET /api/billing and its client
// consumers (the billing page, the entitlement redirect hook).
//
// Deliberately free of server-only imports (no next/headers, no
// Supabase client) so a client component can import these as
// `import type { ... }` without crossing the server/client boundary
// that src/lib/auth/account.ts documents at its top.
// ============================================================

export interface BillingPlanDTO {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  cycle: string;
  trialDays: number;
  isActive: boolean;
  isPublic: boolean;
  sortOrder: number;
}

export interface BillingSubscriptionDTO {
  id: string;
  planId: string | null;
  /** Resolved from the plans list already in the response — never a join. */
  planName: string | null;
  status: string;
  cycle: string;
  valueCents: number;
  currency: string;
  nextDueDate: string | null;
  latestInvoiceUrl: string | null;
  createdAt: string;
}

export interface BillingPaymentDTO {
  id: string;
  /** Asaas payment.status verbatim (PENDING, CONFIRMED, RECEIVED, ...). */
  status: string;
  billingType: string | null;
  valueCents: number;
  dueDate: string | null;
  paidAt: string | null;
  invoiceUrl: string | null;
}

export interface BillingSummaryResponse {
  entitled: boolean;
  billingStatus: string | null;
  planExpiresAt: string | null;
  trialEndsAt: string | null;
  billingExempt: boolean;
  /** False when ASAAS_API_KEY isn't set — hides every subscribe CTA. */
  asaasConfigured: boolean;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
  cpfCnpjLast4: string | null;
  /** Every plan, including inactive/admin-only ones — the UI filters. */
  plans: BillingPlanDTO[];
  subscription: BillingSubscriptionDTO | null;
  payments: BillingPaymentDTO[];
}
