'use client';

// ============================================================
// /billing — the customer-facing subscription screen.
//
// Reachable in two ways: the sidebar link (any role, read-only for
// non-owners) and the entitlement redirect in dashboard-shell.tsx
// (any role, because a locked-out viewer still needs to see WHY).
// Only 'owner' can actually subscribe/cancel — enforced server-side
// by /api/billing/subscribe and /api/billing/cancel, mirrored here by
// hiding the actions rather than disabling them silently.
// ============================================================

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, ExternalLink, Loader2, ShieldAlert } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useBillingStatus } from '@/hooks/use-billing-status';
import type { BillingPlanDTO } from '@/lib/billing/api-types';
import { formatPriceCents } from '@/lib/billing/format-price';
import {
  isValidCpfCnpj,
  maskCpfCnpj,
  maskFromLastFour,
  normalizeCpfCnpj,
} from '@/lib/billing/cpf';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// See src/app/(dashboard)/settings/page.tsx for why a page reading
// useSearchParams needs this Suspense split (CSR-bailout otherwise).
export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingPageInner />
    </Suspense>
  );
}

type BillingStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'expired'
  | 'cancelled'
  | 'exempt';

const KNOWN_STATUSES = new Set<BillingStatus>([
  'trialing',
  'active',
  'past_due',
  'expired',
  'cancelled',
  'exempt',
]);

const KNOWN_PAYMENT_STATUSES = new Set([
  'PENDING',
  'CONFIRMED',
  'RECEIVED',
  'OVERDUE',
  'REFUNDED',
]);

function statusBadgeVariant(
  status: string | null
): 'outline' | 'destructive' | 'secondary' {
  if (status === 'active' || status === 'exempt' || status === 'trialing') return 'outline';
  if (status === 'past_due' || status === 'expired') return 'destructive';
  return 'secondary';
}

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function BillingPageInner() {
  const t = useTranslations('Billing');
  const tCycle = useTranslations('Billing.cycle');
  const tStatus = useTranslations('Billing.statusBadge');
  const tPayStatus = useTranslations('Billing.paymentStatus');
  const searchParams = useSearchParams();
  const { profile, isOwner } = useAuth();
  const { data, loading, loaded, refetch } = useBillingStatus(true);

  const showSuccessBanner = searchParams.get('success') === '1';

  // ---------------------------------------------------------
  // Subscribe dialog
  // ---------------------------------------------------------
  const [subscribeTarget, setSubscribeTarget] = useState<BillingPlanDTO | null>(null);
  const [subName, setSubName] = useState('');
  const [subEmail, setSubEmail] = useState('');
  const [subPhone, setSubPhone] = useState('');
  const [subDoc, setSubDoc] = useState('');
  const [subscribing, setSubscribing] = useState(false);

  useEffect(() => {
    if (subscribeTarget && profile) {
      setSubName(profile.full_name ?? '');
      setSubEmail(profile.email ?? '');
    }
  }, [subscribeTarget, profile]);

  const docValid = useMemo(() => isValidCpfCnpj(subDoc), [subDoc]);

  async function handleSubscribe() {
    if (!subscribeTarget) return;
    if (!subName.trim() || !docValid) {
      toast.error(t('fieldDocumentError'));
      return;
    }
    setSubscribing(true);
    try {
      const res = await fetch('/api/billing/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: subscribeTarget.id,
          name: subName.trim(),
          email: subEmail.trim() || undefined,
          phone: subPhone.trim() || undefined,
          cpfCnpj: normalizeCpfCnpj(subDoc),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          res.status === 409 ? t('alreadyLiveError') : (json.error ?? t('subscribeError'))
        );
        if (res.status === 409) setSubscribeTarget(null);
        return;
      }
      toast.success(t('subscribedToast'));
      if (json.invoiceUrl) {
        window.open(json.invoiceUrl as string, '_blank', 'noopener,noreferrer');
      }
      setSubscribeTarget(null);
      setSubDoc('');
      setSubPhone('');
      void refetch();
    } catch {
      toast.error(t('subscribeError'));
    } finally {
      setSubscribing(false);
    }
  }

  // ---------------------------------------------------------
  // Cancel dialog
  // ---------------------------------------------------------
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  async function handleCancel() {
    if (!data?.subscription) return;
    setCancelling(true);
    try {
      const res = await fetch('/api/billing/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId: data.subscription.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? t('cancelError'));
        return;
      }
      toast.success(t('cancelledToast'));
      setCancelOpen(false);
      void refetch();
    } catch {
      toast.error(t('cancelError'));
    } finally {
      setCancelling(false);
    }
  }

  if (!loaded || loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>{t('loadError')}</AlertTitle>
        </Alert>
      </div>
    );
  }

  const now = new Date();
  const horizon = data.planExpiresAt ? new Date(data.planExpiresAt) : null;
  const trialEnd = data.trialEndsAt ? new Date(data.trialEndsAt) : null;

  const selectablePlans = data.plans.filter((p) => p.isActive && p.isPublic);
  const hasLiveSubscription = !!data.subscription;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-xl font-semibold text-foreground">{t('pageTitle')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t('pageDesc')}</p>

      {showSuccessBanner && (
        <Alert className="mt-6 border-emerald-500/40 bg-emerald-500/10">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <AlertDescription className="text-emerald-200">
            {t('successBanner')}
          </AlertDescription>
        </Alert>
      )}

      {!data.entitled && (
        <Alert variant="destructive" className="mt-6">
          <ShieldAlert className="h-4 w-4" />
          <AlertDescription>{t('lockedBanner')}</AlertDescription>
        </Alert>
      )}

      {/* Status card */}
      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between gap-2 border-b">
          <CardTitle>{t('currentPlan')}</CardTitle>
          <Badge variant={statusBadgeVariant(data.billingStatus)}>
            {data.billingStatus && KNOWN_STATUSES.has(data.billingStatus as BillingStatus)
              ? tStatus(data.billingStatus as BillingStatus)
              : (data.billingStatus ?? '—')}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2 pt-4">
          {data.billingExempt ? (
            <p className="text-sm text-muted-foreground">{t('exemptNote')}</p>
          ) : hasLiveSubscription && data.subscription ? (
            <>
              <p className="text-sm text-foreground">
                {data.subscription.planName ?? '—'} ·{' '}
                {formatPriceCents(data.subscription.valueCents, data.subscription.currency)}{' '}
                / {tCycle(data.subscription.cycle)}
              </p>
              {data.subscription.nextDueDate && (
                <p className="text-sm text-muted-foreground">
                  {t('nextDueDate', {
                    date: new Date(data.subscription.nextDueDate).toLocaleDateString(),
                  })}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-2">
                {data.subscription.latestInvoiceUrl && (
                  <a
                    href={data.subscription.latestInvoiceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <Button size="sm" variant="outline">
                      <ExternalLink className="h-3.5 w-3.5" />
                      {t('viewInvoice')}
                    </Button>
                  </a>
                )}
                {isOwner && (
                  <Button size="sm" variant="destructive" onClick={() => setCancelOpen(true)}>
                    {t('cancelSubscription')}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t('noActivePlan')}</p>
              {trialEnd && now < trialEnd && (
                <p className="text-sm text-muted-foreground">
                  {t('trialEndsIn', { days: Math.max(0, daysBetween(now, trialEnd)) })}
                </p>
              )}
              {horizon && now < horizon && !trialEnd && (
                <p className="text-sm text-muted-foreground">
                  {t('expiresIn', { days: Math.max(0, daysBetween(now, horizon)) })}
                </p>
              )}
              {horizon && now >= horizon && (
                <p className="text-sm text-muted-foreground">
                  {t('expiredDaysAgo', { days: daysBetween(horizon, now) })}
                </p>
              )}
              {!isOwner && <p className="text-sm text-muted-foreground">{t('ownerOnlyNote')}</p>}
            </>
          )}
        </CardContent>
      </Card>

      {/* Plan grid — only when there's nothing live to show instead. */}
      {!hasLiveSubscription && !data.billingExempt && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-foreground">{t('choosePlan')}</h2>

          {!data.asaasConfigured ? (
            <Alert className="mt-3">
              <AlertDescription>{t('notConfigured')}</AlertDescription>
            </Alert>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {selectablePlans.map((plan) => (
                <Card key={plan.id}>
                  <CardHeader>
                    <CardTitle>{plan.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {plan.description && (
                      <p className="text-sm text-muted-foreground">{plan.description}</p>
                    )}
                    <p className="text-lg font-semibold text-foreground">
                      {t('pricePerCycle', {
                        price: formatPriceCents(plan.priceCents, plan.currency),
                        cycle: tCycle(plan.cycle),
                      })}
                    </p>
                    {plan.trialDays > 0 && (
                      <Badge variant="outline" className="w-fit">
                        {t('trialDaysBadge', { days: plan.trialDays })}
                      </Badge>
                    )}
                    {isOwner ? (
                      <Button onClick={() => setSubscribeTarget(plan)}>
                        {t('subscribe')}
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t('ownerOnlyNote')}</p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Payment history */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold text-foreground">{t('paymentHistory')}</h2>
        <div className="mt-3 rounded-xl border border-border bg-card">
          {data.payments.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t('noPayments')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('colDueDate')}</TableHead>
                  <TableHead>{t('colValue')}</TableHead>
                  <TableHead>{t('colStatus')}</TableHead>
                  <TableHead className="text-right">{t('colInvoice')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-muted-foreground">
                      {p.dueDate ? new Date(p.dueDate).toLocaleDateString() : '—'}
                    </TableCell>
                    <TableCell className="text-foreground">
                      {formatPriceCents(p.valueCents, data.subscription?.currency ?? 'BRL')}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {KNOWN_PAYMENT_STATUSES.has(p.status)
                          ? tPayStatus(
                              p.status as
                                | 'PENDING'
                                | 'CONFIRMED'
                                | 'RECEIVED'
                                | 'OVERDUE'
                                | 'REFUNDED'
                            )
                          : p.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {p.invoiceUrl && (
                        <a href={p.invoiceUrl} target="_blank" rel="noreferrer noopener">
                          <Button size="sm" variant="ghost">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </a>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {/* Subscribe dialog */}
      <Dialog open={!!subscribeTarget} onOpenChange={(open) => !open && setSubscribeTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('subscribeDialogTitle', { plan: subscribeTarget?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('subscribeDialogDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>{t('fieldName')}</Label>
              <Input value={subName} onChange={(e) => setSubName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('fieldEmail')}</Label>
              <Input
                type="email"
                value={subEmail}
                onChange={(e) => setSubEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('fieldPhone')}</Label>
              <Input value={subPhone} onChange={(e) => setSubPhone(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('fieldDocument')}</Label>
              <Input
                value={subDoc}
                onChange={(e) => setSubDoc(maskCpfCnpj(e.target.value))}
                placeholder={
                  data.cpfCnpjLast4 ? maskFromLastFour(data.cpfCnpjLast4) : '000.000.000-00'
                }
              />
              {subDoc.length > 0 && !docValid && (
                <p className="text-xs text-destructive">{t('fieldDocumentError')}</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSubscribeTarget(null)}>
              {t('cancel')}
            </Button>
            <Button onClick={handleSubscribe} disabled={subscribing}>
              {subscribing ? <Loader2 className="h-4 w-4 animate-spin" /> : t('subscribe')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel dialog */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('cancelDialogTitle')}</DialogTitle>
            <DialogDescription>{t('cancelDialogDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              {t('cancelDismiss')}
            </Button>
            <Button variant="destructive" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : t('cancelConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
