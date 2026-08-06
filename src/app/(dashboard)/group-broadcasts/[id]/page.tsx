'use client';

import { useEffect, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface TargetRow {
  id: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';
  send_at: string;
  sent_at: string | null;
  error_message: string | null;
  group: { id: string; name: string } | null;
}

interface BroadcastDetail {
  id: string;
  name: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  content_type: string;
  delay_seconds: number;
  total_targets: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
  targets: TargetRow[];
}

export default function GroupBroadcastDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const t = useTranslations('GroupBroadcasts.detail');
  const tStatus = useTranslations('GroupBroadcasts.status');
  const router = useRouter();

  const [broadcast, setBroadcast] = useState<BroadcastDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);

  async function load() {
    const res = await fetch(`/api/whatsapp/group-broadcasts/${id}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) setBroadcast(data.data);
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // Poll while the campaign is still in flight so progress updates
    // without a manual refresh.
    const interval = setInterval(() => {
      setBroadcast((current) => {
        if (
          current &&
          (current.status === 'sent' ||
            current.status === 'failed' ||
            current.status === 'cancelled')
        ) {
          clearInterval(interval);
          return current;
        }
        void load();
        return current;
      });
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleCancel() {
    setCancelling(true);
    try {
      const res = await fetch(`/api/whatsapp/group-broadcasts/${id}/cancel`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('cancelError'));
        return;
      }
      toast.success(t('cancelSuccess'));
      void load();
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!broadcast) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
        <Button variant="outline" onClick={() => router.push('/group-broadcasts')}>
          {t('backToList')}
        </Button>
      </div>
    );
  }

  const canCancel = broadcast.status === 'pending' || broadcast.status === 'sending';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <button
        onClick={() => router.push('/group-broadcasts')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t('backToList')}
      </button>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{broadcast.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tStatus(broadcast.status)} ·{' '}
            {t('delaySummary', { seconds: broadcast.delay_seconds })}
          </p>
        </div>
        {canCancel && (
          <Button variant="outline" onClick={handleCancel} disabled={cancelling}>
            {cancelling ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('cancel')}
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('progress')}</span>
            <span className="tabular-nums text-foreground">
              {broadcast.sent_count + broadcast.failed_count}/{broadcast.total_targets}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-primary transition-all"
              style={{
                width: `${
                  broadcast.total_targets > 0
                    ? Math.round(
                        ((broadcast.sent_count + broadcast.failed_count) /
                          broadcast.total_targets) *
                          100
                      )
                    : 0
                }%`,
              }}
            />
          </div>
          {broadcast.failed_count > 0 && (
            <p className="mt-2 text-xs text-red-400">
              {t('failedCount', { count: broadcast.failed_count })}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">{t('table.group')}</TableHead>
              <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
              <TableHead className="hidden text-muted-foreground sm:table-cell">
                {t('table.sendAt')}
              </TableHead>
              <TableHead className="hidden text-muted-foreground sm:table-cell">
                {t('table.error')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {broadcast.targets.map((target) => (
              <TableRow key={target.id} className="border-border">
                <TableCell className="font-medium text-foreground">
                  {target.group?.name ?? t('unknownGroup')}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {tStatus(target.status)}
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {new Date(target.sent_at ?? target.send_at).toLocaleString()}
                </TableCell>
                <TableCell className="hidden text-red-400 sm:table-cell">
                  {target.error_message ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
