import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isAsaasConfigured } from '@/lib/billing/asaas/client';
import type {
  BillingPaymentDTO,
  BillingPlanDTO,
  BillingSubscriptionDTO,
  BillingSummaryResponse,
} from '@/lib/billing/api-types';

/**
 * GET /api/billing
 *
 * The one read the billing page (and the entitlement redirect) needs:
 * this account's billing snapshot, the plan catalogue, its live
 * subscription (if any) and recent payment history.
 *
 * `allowUnentitled` on purpose — same reasoning as /api/billing/subscribe
 * and /api/billing/cancel: a locked-out account has to be able to read
 * why it's locked and what to do about it. Any role may call it (viewer
 * included); only the UI hides subscribe/cancel from non-owners, mirroring
 * the 'owner'-only guard on the mutating routes.
 *
 * No FK embeds (`plans(name)` etc.) — see the comment in
 * src/lib/auth/account.ts about PGRST200 on a stale schema cache.
 * `planName` is resolved by matching `plan_id` against the already
 * -fetched plans list instead.
 */
export async function GET() {
  try {
    const ctx = await requireRole('viewer', { allowUnentitled: true });
    const { accountId, role, supabase, billing } = ctx;

    const [plansRes, subRes, cpfRes, paymentsRes] = await Promise.all([
      supabase
        .from('plans')
        .select(
          'id, slug, name, description, price_cents, currency, cycle, trial_days, is_active, is_public, sort_order'
        )
        .order('sort_order', { ascending: true }),
      supabase
        .from('account_subscriptions')
        .select(
          'id, plan_id, status, cycle, value_cents, currency, next_due_date, latest_invoice_url, created_at'
        )
        .eq('account_id', accountId)
        .in('status', ['pending', 'active', 'past_due'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('accounts')
        .select('billing_cpf_cnpj_last4')
        .eq('id', accountId)
        .maybeSingle(),
      supabase
        .from('subscription_payments')
        .select(
          'id, status, billing_type, value_cents, due_date, paid_at, invoice_url'
        )
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    if (plansRes.error) {
      console.error('[GET /api/billing] plans error:', plansRes.error.message);
    }
    if (subRes.error) {
      console.error(
        '[GET /api/billing] subscription error:',
        subRes.error.message
      );
    }
    if (paymentsRes.error) {
      console.error(
        '[GET /api/billing] payments error:',
        paymentsRes.error.message
      );
    }

    const plans: BillingPlanDTO[] = (plansRes.data ?? []).map((p) => ({
      id: p.id as string,
      slug: p.slug as string,
      name: p.name as string,
      description: (p.description as string | null) ?? null,
      priceCents: p.price_cents as number,
      currency: p.currency as string,
      cycle: p.cycle as string,
      trialDays: p.trial_days as number,
      isActive: p.is_active as boolean,
      isPublic: p.is_public as boolean,
      sortOrder: p.sort_order as number,
    }));

    const subRow = subRes.data as
      | {
          id: string;
          plan_id: string | null;
          status: string;
          cycle: string;
          value_cents: number;
          currency: string;
          next_due_date: string | null;
          latest_invoice_url: string | null;
          created_at: string;
        }
      | null
      | undefined;

    const subscription: BillingSubscriptionDTO | null = subRow
      ? {
          id: subRow.id,
          planId: subRow.plan_id,
          planName: plans.find((p) => p.id === subRow.plan_id)?.name ?? null,
          status: subRow.status,
          cycle: subRow.cycle,
          valueCents: subRow.value_cents,
          currency: subRow.currency,
          nextDueDate: subRow.next_due_date,
          latestInvoiceUrl: subRow.latest_invoice_url,
          createdAt: subRow.created_at,
        }
      : null;

    const payments: BillingPaymentDTO[] = (paymentsRes.data ?? []).map((p) => ({
      id: p.id as string,
      status: p.status as string,
      billingType: (p.billing_type as string | null) ?? null,
      valueCents: p.value_cents as number,
      dueDate: (p.due_date as string | null) ?? null,
      paidAt: (p.paid_at as string | null) ?? null,
      invoiceUrl: (p.invoice_url as string | null) ?? null,
    }));

    const response: BillingSummaryResponse = {
      entitled: billing.entitled,
      billingStatus: billing.status,
      planExpiresAt: billing.planExpiresAt,
      trialEndsAt: billing.trialEndsAt,
      billingExempt: billing.exempt,
      asaasConfigured: await isAsaasConfigured(),
      role,
      cpfCnpjLast4:
        (cpfRes.data?.billing_cpf_cnpj_last4 as string | null) ?? null,
      plans,
      subscription,
      payments,
    };

    return NextResponse.json(response);
  } catch (error) {
    return toErrorResponse(error);
  }
}
