import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  createAsaasCustomer,
  createAsaasSubscription,
  listSubscriptionPayments,
} from '@/lib/billing/asaas/api';
import { isAsaasConfigured } from '@/lib/billing/asaas/client';
import { isValidCpfCnpj, normalizeCpfCnpj, lastFour } from '@/lib/billing/cpf';
import { isAsaasCycle } from '@/lib/billing/cycles';
import { todayInSaoPaulo } from '@/lib/billing/expiry';
import { encrypt } from '@/lib/whatsapp/encryption';

// Self-serve checkout. `allowUnentitled` on the requireRole call is
// what lets a locked-out owner reach this route at all — see
// AccountContextOptions in src/lib/auth/account.ts. Only 'owner' may
// call it: the customer identity (CPF/CNPJ, name) attached to the
// Asaas customer is a legal/billing fact for the whole account, not
// something an agent should be able to set.
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('owner', { allowUnentitled: true });
    const { accountId, userId, supabase } = ctx;

    if (!(await isAsaasConfigured())) {
      return NextResponse.json(
        { error: 'Billing is not configured on this deployment' },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { planId, name, email, phone, cpfCnpj } = body as {
      planId?: unknown;
      name?: unknown;
      email?: unknown;
      phone?: unknown;
      cpfCnpj?: unknown;
    };

    if (typeof planId !== 'string' || !planId) {
      return NextResponse.json(
        { error: 'planId is required' },
        { status: 400 }
      );
    }
    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (typeof cpfCnpj !== 'string' || !isValidCpfCnpj(cpfCnpj)) {
      return NextResponse.json({ error: 'Invalid CPF/CNPJ' }, { status: 400 });
    }
    const normalizedDoc = normalizeCpfCnpj(cpfCnpj);

    // Plan lookup on the session client: `plans_select` is readable by
    // any authenticated user regardless of entitlement (see 053), so
    // this works for a locked-out owner too.
    const { data: plan, error: planErr } = await supabase
      .from('plans')
      .select('id, cycle, price_cents, currency, name, is_active, is_public')
      .eq('id', planId)
      .maybeSingle();
    if (planErr || !plan) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }
    if (!plan.is_active || !plan.is_public) {
      return NextResponse.json(
        { error: 'This plan is not available for self-serve signup' },
        { status: 400 }
      );
    }
    if (!isAsaasCycle(plan.cycle)) {
      return NextResponse.json(
        { error: 'Plan has an invalid billing cycle' },
        { status: 500 }
      );
    }

    // Every write below runs on the admin client: account_subscriptions
    // and subscription_payments have no INSERT/UPDATE policies (053) —
    // the authoritative writer is the Asaas webhook, which has no
    // session. This route is the other authorized writer.
    const admin = supabaseAdmin();

    // One live subscription per account (idx_account_subscriptions_one_live,
    // 053). Check first so a double-click on "Assinar" gets an
    // actionable 409 with the existing invoice link, instead of a raw
    // unique-constraint violation after we've already called Asaas.
    const { data: existingLive } = await admin
      .from('account_subscriptions')
      .select('id, latest_invoice_url')
      .eq('account_id', accountId)
      .in('status', ['pending', 'active', 'past_due'])
      .maybeSingle();
    if (existingLive) {
      return NextResponse.json(
        {
          error: 'This account already has a live subscription',
          subscriptionId: existingLive.id,
          invoiceUrl: existingLive.latest_invoice_url ?? null,
        },
        { status: 409 }
      );
    }

    const { data: accountRow } = await admin
      .from('accounts')
      .select('asaas_customer_id')
      .eq('id', accountId)
      .maybeSingle();

    let customerId = accountRow?.asaas_customer_id as string | null | undefined;
    if (!customerId) {
      const customer = await createAsaasCustomer({
        name: name.trim(),
        cpfCnpj: normalizedDoc,
        email:
          typeof email === 'string' && email.trim() ? email.trim() : undefined,
        mobilePhone:
          typeof phone === 'string' && phone.trim() ? phone.trim() : undefined,
        externalReference: accountId,
      });
      customerId = customer.id;

      await admin
        .from('accounts')
        .update({
          asaas_customer_id: customerId,
          billing_cpf_cnpj_encrypted: encrypt(normalizedDoc),
          billing_cpf_cnpj_last4: lastFour(normalizedDoc),
        })
        .eq('id', accountId);
    }

    const origin = new URL(request.url).origin;
    const subscription = await createAsaasSubscription({
      customerId,
      cycle: plan.cycle,
      valueCents: plan.price_cents,
      nextDueDate: todayInSaoPaulo(),
      description: `Assinatura ${plan.name}`,
      externalReference: accountId,
      successUrl: `${origin}/billing?success=1`,
    });

    const { data: subRow, error: subInsertErr } = await admin
      .from('account_subscriptions')
      .insert({
        account_id: accountId,
        plan_id: plan.id,
        asaas_subscription_id: subscription.id,
        status: 'pending',
        cycle: plan.cycle,
        value_cents: plan.price_cents,
        currency: plan.currency,
        source: 'self_serve',
        created_by: userId,
      })
      .select('id')
      .maybeSingle();

    if (subInsertErr || !subRow) {
      // The Asaas subscription now exists without a local row. Rare
      // (insert failure right after a successful external call) — the
      // PAYMENT_CREATED webhook can still resolve the account via
      // asaas_customer_id (resolveAccountForPayment's third route) and
      // record the invoice, but the account_subscriptions row itself
      // needs a human to backfill. Surface the Asaas id so support has
      // something to search on.
      console.error(
        '[POST /api/billing/subscribe] failed to persist subscription row:',
        subInsertErr?.message
      );
      return NextResponse.json(
        {
          error:
            'Subscription created but could not be saved — contact support',
          asaasSubscriptionId: subscription.id,
        },
        { status: 500 }
      );
    }

    // The create-subscription response has no invoiceUrl — a
    // subscription is a schedule, not a charge. Asaas creates the
    // first payment moments later. Two short attempts cover the
    // common case; if it's still missing, PAYMENT_CREATED fills
    // latest_invoice_url in within seconds and the billing page
    // re-fetches on focus.
    let invoiceUrl: string | null = null;
    for (let attempt = 0; attempt < 2 && !invoiceUrl; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 700));
      const payments = await listSubscriptionPayments(subscription.id, 1).catch(
        () => []
      );
      invoiceUrl = payments[0]?.invoiceUrl ?? null;
    }

    if (invoiceUrl) {
      await admin
        .from('account_subscriptions')
        .update({ latest_invoice_url: invoiceUrl })
        .eq('id', subRow.id);
    }

    return NextResponse.json({
      subscriptionId: subRow.id,
      asaasSubscriptionId: subscription.id,
      invoiceUrl,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
