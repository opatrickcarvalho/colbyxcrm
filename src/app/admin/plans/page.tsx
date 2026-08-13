'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ASAAS_CYCLES, type AsaasCycle } from '@/lib/billing/cycles';
import { formatPriceCents } from '@/lib/billing/format-price';

interface AdminPlanRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  cycle: string;
  trial_days: number;
  is_active: boolean;
  is_public: boolean;
  sort_order: number;
}

interface PlanFormState {
  slug: string;
  name: string;
  description: string;
  priceReais: string;
  currency: string;
  cycle: AsaasCycle;
  trialDays: string;
  isActive: boolean;
  isPublic: boolean;
  sortOrder: string;
}

const EMPTY_FORM: PlanFormState = {
  slug: '',
  name: '',
  description: '',
  priceReais: '',
  currency: 'BRL',
  cycle: 'MONTHLY',
  trialDays: '0',
  isActive: true,
  isPublic: true,
  sortOrder: '0',
};

export default function AdminPlansPage() {
  const t = useTranslations('Admin.plans');
  const tCycle = useTranslations('Billing.cycle');

  const [plans, setPlans] = useState<AdminPlanRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminPlanRow | null>(null);
  const [form, setForm] = useState<PlanFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/plans');
      if (res.status === 401 || res.status === 403) {
        setDenied(true);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('loadError'));
        return;
      }
      setPlans(data.plans ?? []);
    } catch {
      toast.error(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(plan: AdminPlanRow) {
    setEditing(plan);
    setForm({
      slug: plan.slug,
      name: plan.name,
      description: plan.description ?? '',
      priceReais: (plan.price_cents / 100).toFixed(2),
      currency: plan.currency,
      cycle: (plan.cycle as AsaasCycle) ?? 'MONTHLY',
      trialDays: String(plan.trial_days),
      isActive: plan.is_active,
      isPublic: plan.is_public,
      sortOrder: String(plan.sort_order),
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    const priceCents = Math.round(Number(form.priceReais.replace(',', '.')) * 100);
    if (!form.name.trim() || !Number.isFinite(priceCents) || priceCents < 0) {
      toast.error(t('actionError'));
      return;
    }

    setSaving(true);
    try {
      if (editing) {
        const res = await fetch(`/api/admin/plans/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name.trim(),
            description: form.description.trim() || null,
            priceCents,
            currency: form.currency,
            cycle: form.cycle,
            trialDays: Number(form.trialDays) || 0,
            isActive: form.isActive,
            isPublic: form.isPublic,
            sortOrder: Number(form.sortOrder) || 0,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('actionError'));
          return;
        }
        toast.success(t('updatedToast'));
      } else {
        if (!/^[a-z0-9-]+$/.test(form.slug)) {
          toast.error(t('actionError'));
          return;
        }
        const res = await fetch('/api/admin/plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: form.slug,
            name: form.name.trim(),
            description: form.description.trim() || null,
            priceCents,
            currency: form.currency,
            cycle: form.cycle,
            trialDays: Number(form.trialDays) || 0,
            isActive: form.isActive,
            isPublic: form.isPublic,
            sortOrder: Number(form.sortOrder) || 0,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(
            data.code === 'slug_taken' ? t('slugTaken') : (data.error ?? t('actionError'))
          );
          return;
        }
        toast.success(t('createdToast'));
      }
      setDialogOpen(false);
      void load();
    } finally {
      setSaving(false);
    }
  }

  if (denied) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">{t('loadError')}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          {t('newPlan')}
        </Button>
      </div>

      <div className="mt-6 rounded-xl border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !plans || plans.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {t('noPlans')}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colName')}</TableHead>
                <TableHead>{t('colPrice')}</TableHead>
                <TableHead>{t('colCycle')}</TableHead>
                <TableHead>{t('colStatus')}</TableHead>
                <TableHead>{t('colVisibility')}</TableHead>
                <TableHead className="text-right">{t('colActions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell className="font-medium text-foreground">
                    {plan.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {plan.slug}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatPriceCents(plan.price_cents, plan.currency)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {tCycle(plan.cycle as AsaasCycle)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={plan.is_active ? 'outline' : 'secondary'}>
                      {plan.is_active ? t('active') : t('inactive')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={plan.is_public ? 'outline' : 'secondary'}>
                      {plan.is_public ? t('public') : t('adminOnly')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => openEdit(plan)}>
                      <Pencil className="h-3 w-3" />
                      {t('edit')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? t('dialogTitleEdit') : t('dialogTitleCreate')}
            </DialogTitle>
            <DialogDescription>{t('subtitle')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {!editing && (
              <div className="space-y-1.5">
                <Label>{t('fieldSlug')}</Label>
                <Input
                  value={form.slug}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                    }))
                  }
                  placeholder="pro-mensal"
                />
                <p className="text-xs text-muted-foreground">{t('fieldSlugHint')}</p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>{t('fieldName')}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t('fieldDescription')}</Label>
              <Textarea
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                rows={2}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('fieldPrice')}</Label>
                <Input
                  inputMode="decimal"
                  value={form.priceReais}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, priceReais: e.target.value }))
                  }
                  placeholder="29.90"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('fieldCycle')}</Label>
                <Select
                  value={form.cycle}
                  onValueChange={(v) => v && setForm((f) => ({ ...f, cycle: v as AsaasCycle }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>{tCycle(form.cycle)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ASAAS_CYCLES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {tCycle(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('fieldTrialDays')}</Label>
                <Input
                  inputMode="numeric"
                  value={form.trialDays}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, trialDays: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('fieldSortOrder')}</Label>
                <Input
                  inputMode="numeric"
                  value={form.sortOrder}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, sortOrder: e.target.value }))
                  }
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('fieldActive')}
                </p>
                <p className="text-xs text-muted-foreground">{t('fieldActiveHint')}</p>
              </div>
              <Switch
                checked={form.isActive}
                onCheckedChange={(v) => setForm((f) => ({ ...f, isActive: !!v }))}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('fieldPublic')}
                </p>
                <p className="text-xs text-muted-foreground">{t('fieldPublicHint')}</p>
              </div>
              <Switch
                checked={form.isPublic}
                onCheckedChange={(v) => setForm((f) => ({ ...f, isPublic: !!v }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : editing ? (
                t('save')
              ) : (
                t('create')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
