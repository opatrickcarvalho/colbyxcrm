'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Copy, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

interface AsaasSettingsView {
  apiKeyConfigured: boolean;
  apiKeySource: 'database' | 'env' | 'none';
  env: 'sandbox' | 'production';
  webhookToken: string | null;
}

/**
 * Platform-admin control for `platform_settings` (migration 053) —
 * the kill switch, trial length and grace window. Before this page
 * the only way to change any of the three was a hand-run SQL
 * statement; see the header comment on the API route this calls.
 */
export default function AdminBillingSettingsPage() {
  const t = useTranslations('Admin.billingSettings');
  const tAsaas = useTranslations('Admin.asaasSettings');

  const [saved, setSaved] = useState<BillingSettings | null>(null);
  const [form, setForm] = useState<BillingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [denied, setDenied] = useState(false);
  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);

  // ---------------------------------------------------------
  // Asaas credentials — separate load/save from the policy knobs
  // above: different endpoint, different risk shape (write-only key
  // vs. freely-editable numbers).
  // ---------------------------------------------------------
  const [asaas, setAsaas] = useState<AsaasSettingsView | null>(null);
  const [asaasEnv, setAsaasEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [asaasLoading, setAsaasLoading] = useState(true);
  const [savingAsaas, setSavingAsaas] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const loadAsaas = useCallback(async () => {
    setAsaasLoading(true);
    try {
      const res = await fetch('/api/admin/asaas-settings');
      if (res.status === 401 || res.status === 403) return; // covered by the billing-settings denial state
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('loadError'));
        return;
      }
      setAsaas(data);
      setAsaasEnv(data.env);
    } catch {
      toast.error(t('loadError'));
    } finally {
      setAsaasLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadAsaas();
  }, [loadAsaas]);

  async function saveAsaasCredentials() {
    setSavingAsaas(true);
    try {
      const res = await fetch('/api/admin/asaas-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKeyInput.trim() || undefined,
          env: asaasEnv,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('actionError'));
        return;
      }
      setAsaas(data);
      setAsaasEnv(data.env);
      setApiKeyInput('');
      toast.success(t('savedToast'));
    } catch {
      toast.error(t('actionError'));
    } finally {
      setSavingAsaas(false);
    }
  }

  async function regenerateWebhookToken() {
    setRegenerating(true);
    try {
      const res = await fetch('/api/admin/asaas-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerateWebhookToken: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('actionError'));
        return;
      }
      setAsaas(data);
      toast.success(t('savedToast'));
      setRegenerateOpen(false);
    } catch {
      toast.error(t('actionError'));
    } finally {
      setRegenerating(false);
    }
  }

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(tAsaas('copied'));
    } catch {
      toast.error(tAsaas('clipboardBlocked'));
    }
  }

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/billing/asaas/webhook`
      : '';

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

      <h2 className="text-foreground mt-10 text-lg font-semibold">
        {tAsaas('title')}
      </h2>
      <p className="text-muted-foreground mt-1 text-sm">{tAsaas('subtitle')}</p>

      {asaasLoading || !asaas ? (
        <div className="mt-6 flex items-center justify-center py-10">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      ) : (
        <>
          <Card className="mt-4">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle>{tAsaas('fieldApiKey')}</CardTitle>
              <Badge variant={asaas.apiKeyConfigured ? 'outline' : 'secondary'}>
                {asaas.apiKeySource === 'database'
                  ? tAsaas('sourceDatabase')
                  : asaas.apiKeySource === 'env'
                    ? tAsaas('sourceEnv')
                    : tAsaas('sourceNone')}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>{tAsaas('fieldEnv')}</Label>
                <Select
                  value={asaasEnv}
                  onValueChange={(v) =>
                    v && setAsaasEnv(v as 'sandbox' | 'production')
                  }
                >
                  <SelectTrigger className="w-full max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sandbox">
                      {tAsaas('envSandbox')}
                    </SelectItem>
                    <SelectItem value="production">
                      {tAsaas('envProduction')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  {tAsaas('fieldEnvHint')}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>{tAsaas('fieldApiKey')}</Label>
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={
                    asaas.apiKeyConfigured
                      ? tAsaas('fieldApiKeyPlaceholderConfigured')
                      : tAsaas('fieldApiKeyPlaceholderEmpty')
                  }
                />
                <p className="text-muted-foreground text-xs">
                  {tAsaas('fieldApiKeyHint')}
                </p>
              </div>

              <div className="flex justify-end">
                <Button onClick={saveAsaasCredentials} disabled={savingAsaas}>
                  {savingAsaas ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    tAsaas('saveCredentials')
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>{tAsaas('webhookTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>{tAsaas('webhookUrlLabel')}</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={webhookUrl}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void copyValue(webhookUrl)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>{tAsaas('webhookTokenLabel')}</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={asaas.webhookToken ?? ''}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={!asaas.webhookToken}
                    onClick={() =>
                      asaas.webhookToken && void copyValue(asaas.webhookToken)
                    }
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRegenerateOpen(true)}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {tAsaas('regenerateToken')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={regenerateOpen} onOpenChange={setRegenerateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="text-destructive h-4 w-4" />
              {tAsaas('confirmRegenerateTitle')}
            </DialogTitle>
            <DialogDescription>
              {tAsaas('confirmRegenerateDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRegenerateOpen(false)}>
              {tAsaas('confirmRegenerateCancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={regenerating}
              onClick={() => void regenerateWebhookToken()}
            >
              {regenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                tAsaas('confirmRegenerateConfirm')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
