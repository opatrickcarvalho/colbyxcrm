'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, LogIn, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface AccountBilling {
  status: string | null;
  planId: string | null;
  planName: string | null;
  planExpiresAt: string | null;
  trialEndsAt: string | null;
  exempt: boolean;
}

interface AccountDetail {
  account: {
    id: string;
    name: string;
    owner_user_id: string;
    status: 'active' | 'suspended';
    suspended_at: string | null;
    suspended_reason: string | null;
    created_at: string;
  };
  billing: AccountBilling;
  members: {
    user_id: string;
    full_name: string;
    email: string;
    account_role: string;
  }[];
  whatsapp: {
    provider: string;
    status: string;
    connected_at: string | null;
  } | null;
  usage: {
    contactCount: number;
    conversationCount: number;
    messagesLast30d: number;
  };
}

export default function AdminAccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const t = useTranslations('Admin.accountDetail');
  const router = useRouter();

  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);
  const [savingExempt, setSavingExempt] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/accounts/${id}`);
      if (res.status === 401 || res.status === 403) {
        setDenied(true);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('loadError'));
        return;
      }
      setDetail(data);
    } catch {
      toast.error(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (denied) {
      const timer = setTimeout(() => router.replace('/dashboard'), 1500);
      return () => clearTimeout(timer);
    }
  }, [denied, router]);

  const impersonate = async (targetUserId: string) => {
    setImpersonatingId(targetUserId);
    try {
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_user_id: targetUserId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('impersonateError'));
        setImpersonatingId(null);
        return;
      }
      window.location.href = data.redirectUrl;
    } catch {
      toast.error(t('impersonateError'));
      setImpersonatingId(null);
    }
  };

  const toggleExempt = async (nextExempt: boolean) => {
    setSavingExempt(true);
    try {
      const res = await fetch(`/api/admin/accounts/${id}/billing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billingExempt: nextExempt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('billingActionError'));
        return;
      }
      setDetail((prev) => (prev ? { ...prev, billing: data.billing } : prev));
      toast.success(t('billingSavedToast'));
    } catch {
      toast.error(t('billingActionError'));
    } finally {
      setSavingExempt(false);
    }
  };

  if (denied) {
    return (
      <div className="bg-background flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <ShieldAlert className="text-destructive h-10 w-10" />
        <p className="text-muted-foreground text-sm">{t('accessDenied')}</p>
      </div>
    );
  }

  if (loading || !detail) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  const { account, billing, members, whatsapp, usage } = detail;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <a
        href="/admin"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('back')}
      </a>

      <div className="mt-4 flex items-center gap-3">
        <h1 className="text-foreground text-xl font-semibold">
          {account.name}
        </h1>
        <Badge
          variant={account.status === 'active' ? 'outline' : 'destructive'}
        >
          {account.status === 'active' ? t('active') : t('suspendedBadge')}
        </Badge>
      </div>
      {account.status === 'suspended' && account.suspended_reason && (
        <p className="text-muted-foreground mt-1 text-sm">
          {t('suspendedReasonLabel')}: {account.suspended_reason}
        </p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="border-border bg-card rounded-xl border p-4">
          <p className="text-muted-foreground text-xs">{t('contacts')}</p>
          <p className="text-foreground mt-1 text-2xl font-semibold">
            {usage.contactCount}
          </p>
        </div>
        <div className="border-border bg-card rounded-xl border p-4">
          <p className="text-muted-foreground text-xs">{t('conversations')}</p>
          <p className="text-foreground mt-1 text-2xl font-semibold">
            {usage.conversationCount}
          </p>
        </div>
        <div className="border-border bg-card rounded-xl border p-4">
          <p className="text-muted-foreground text-xs">{t('messages30d')}</p>
          <p className="text-foreground mt-1 text-2xl font-semibold">
            {usage.messagesLast30d}
          </p>
        </div>
      </div>

      <div className="border-border bg-card mt-6 rounded-xl border p-4">
        <p className="text-foreground text-sm font-medium">{t('whatsapp')}</p>
        <p className="text-muted-foreground mt-1 text-sm">
          {whatsapp
            ? `${whatsapp.provider} · ${whatsapp.status}`
            : t('notConnected')}
        </p>
      </div>

      <div className="border-border bg-card mt-6 rounded-xl border p-4">
        <div className="flex items-center justify-between gap-4">
          <p className="text-foreground text-sm font-medium">{t('billing')}</p>
          <Badge variant={billing.exempt ? 'secondary' : 'outline'}>
            {billing.status ?? '—'}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          {billing.planName ?? t('noPlan')}
          {billing.planExpiresAt &&
            ` · ${t('planExpiresLabel')}: ${new Date(billing.planExpiresAt).toLocaleDateString()}`}
        </p>
        <div className="border-border mt-3 flex items-center justify-between gap-4 border-t pt-3">
          <div>
            <p className="text-foreground text-sm">{t('billingExemptLabel')}</p>
            <p className="text-muted-foreground text-xs">
              {t('billingExemptHint')}
            </p>
          </div>
          <Switch
            checked={billing.exempt}
            disabled={savingExempt}
            onCheckedChange={(v) => void toggleExempt(!!v)}
          />
        </div>
      </div>

      <div className="border-border bg-card mt-6 rounded-xl border">
        <div className="border-border border-b px-4 py-3">
          <p className="text-foreground text-sm font-medium">{t('members')}</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('colName')}</TableHead>
              <TableHead>{t('colEmail')}</TableHead>
              <TableHead>{t('colRole')}</TableHead>
              <TableHead className="text-right">{t('colActions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.user_id}>
                <TableCell className="text-foreground">{m.full_name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {m.email}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {m.account_role}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={impersonatingId === m.user_id}
                    onClick={() => void impersonate(m.user_id)}
                  >
                    {impersonatingId === m.user_id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <>
                        <LogIn className="mr-1 h-3 w-3" />
                        {t('enterAs')}
                      </>
                    )}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
