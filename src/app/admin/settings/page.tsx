'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface BillingSettings {
  enforcementEnabled: boolean;
  trialDays: number;
  graceDays: number;
}

/**
 * Platform-admin control for `platform_settings` (migration 053) —
 * the kill switch, trial length and grace window. Before this page
 * the only way to change any of the three was a hand-run SQL
 * statement; see the header comment on the API route this calls.
 */
export default function AdminBillingSettingsPage() {
  const t = useTranslations('Admin.billingSettings');

  const [saved, setSaved] = useState<BillingSettings | null>(null);
  const [form, setForm] = useState<BillingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [denied, setDenied] = useState(false);
  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/billing-settings');
      if (res.status === 401 || res.status === 403) {
        setDenied(true);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('loadError'));
        return;
      }
      setSaved(data.settings);
      setForm(data.settings);
    } catch {
      toast.error(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function persist(next: BillingSettings) {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/billing-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enforcementEnabled: next.enforcementEnabled,
          trialDays: next.trialDays,
          graceDays: next.graceDays,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('actionError'));
        return;
      }
      setSaved(data.settings);
      setForm(data.settings);
      toast.success(t('savedToast'));
    } catch {
      toast.error(t('actionError'));
    } finally {
      setSaving(false);
    }
  }

  function handleSaveClick() {
    if (!form || !saved) return;
    // Flipping the kill switch OFF -> ON locks out every account
    // whose plan_expires_at + grace has already passed — a one-line
    // toggle with a fleet-wide blast radius. Everything else on this
    // page (trial/grace days, turning it back off) saves immediately.
    if (form.enforcementEnabled && !saved.enforcementEnabled) {
      setConfirmEnableOpen(true);
      return;
    }
    void persist(form);
  }

  if (denied) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-muted-foreground text-sm">{t('loadError')}</p>
      </div>
    );
  }

  if (loading || !form) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-foreground text-xl font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('fieldEnforcement')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <p className="text-muted-foreground text-sm">
              {t('fieldEnforcementHint')}
            </p>
            <Switch
              checked={form.enforcementEnabled}
              onCheckedChange={(v) =>
                setForm((f) => (f ? { ...f, enforcementEnabled: !!v } : f))
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>{t('fieldTrialDays')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Input
            inputMode="numeric"
            value={form.trialDays}
            onChange={(e) =>
              setForm((f) =>
                f ? { ...f, trialDays: Number(e.target.value) || 0 } : f
              )
            }
            className="max-w-[8rem]"
          />
          <p className="text-muted-foreground text-xs">
            {t('fieldTrialDaysHint')}
          </p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>{t('fieldGraceDays')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Input
            inputMode="numeric"
            value={form.graceDays}
            onChange={(e) =>
              setForm((f) =>
                f ? { ...f, graceDays: Number(e.target.value) || 0 } : f
              )
            }
            className="max-w-[8rem]"
          />
          <p className="text-muted-foreground text-xs">
            {t('fieldGraceDaysHint')}
          </p>
        </CardContent>
      </Card>

      <div className="mt-6 flex justify-end">
        <Button onClick={handleSaveClick} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('save')}
        </Button>
      </div>

      <Dialog open={confirmEnableOpen} onOpenChange={setConfirmEnableOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="text-destructive h-4 w-4" />
              {t('confirmEnableTitle')}
            </DialogTitle>
            <DialogDescription>{t('confirmEnableDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmEnableOpen(false)}
            >
              {t('confirmEnableCancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={() => {
                setConfirmEnableOpen(false);
                if (form) void persist(form);
              }}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t('confirmEnableConfirm')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
