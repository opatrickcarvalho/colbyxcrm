'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Megaphone, Plus, Loader2, Users } from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';

interface GroupBroadcastRow {
  id: string;
  name: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  total_targets: number;
  sent_count: number;
  failed_count: number;
  delay_seconds: number;
  created_at: string;
  // Added by migration 052 — nullable when the campaign has no sending
  // window (i.e. can send around the clock).
  window_start?: string | null;
  window_end?: string | null;
  window_days?: number[] | null;
}

const STATUS_STYLES: Record<GroupBroadcastRow['status'], string> = {
  pending: 'border-border bg-muted text-muted-foreground',
  sending: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  sent: 'border-green-500/30 bg-green-500/10 text-green-400',
  failed: 'border-red-500/30 bg-red-500/10 text-red-400',
  cancelled: 'border-border bg-muted text-muted-foreground',
};

/** Compact "09:00-18:00 · Seg,Ter,Qua" summary, or a dash when unrestricted. */
function formatWindow(
  b: GroupBroadcastRow,
  t: ReturnType<typeof useTranslations>,
  dayLabels: Record<number, string>
): string {
  if (!b.window_start || !b.window_end) return t('windowNone');
  const days = b.window_days?.length
    ? b.window_days.map((d) => dayLabels[d]).join(',')
    : t('windowAllDays');
  return `${b.window_start.slice(0, 5)}–${b.window_end.slice(0, 5)} · ${days}`;
}

export default function GroupBroadcastsPage() {
  const t = useTranslations('GroupBroadcasts.list');
  const tStatus = useTranslations('GroupBroadcasts.status');
  const tDays = useTranslations('GroupBroadcasts.days');
  const router = useRouter();
  const canManage = useCan('send-messages');

  const dayLabels: Record<number, string> = {
    1: tDays('mon'),
    2: tDays('tue'),
    3: tDays('wed'),
    4: tDays('thu'),
    5: tDays('fri'),
    6: tDays('sat'),
    7: tDays('sun'),
  };

  const [broadcasts, setBroadcasts] = useState<GroupBroadcastRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/whatsapp/group-broadcasts', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? t('errorLoad'));
        if (!cancelled) setBroadcasts(data.data ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('errorLoad'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => router.push('/group-broadcasts/audiences')}>
            <Users className="h-4 w-4" />
            {t('manageAudiences')}
          </Button>
          <GatedButton
            canAct={canManage}
            gateReason="send messages"
            onClick={() => router.push('/group-broadcasts/new')}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t('newBroadcast')}
          </GatedButton>
        </div>
      </div>

      {broadcasts.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Megaphone className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('noBroadcastsYet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('createFirst')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('table.name')}</TableHead>
                <TableHead className="text-muted-foreground">{t('table.progress')}</TableHead>
                <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">
                  {t('table.delay')}
                </TableHead>
                <TableHead className="hidden text-muted-foreground lg:table-cell">
                  {t('table.window')}
                </TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">
                  {t('table.created')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {broadcasts.map((b) => (
                <TableRow
                  key={b.id}
                  className="cursor-pointer border-border hover:bg-muted/50"
                  onClick={() => router.push(`/group-broadcasts/${b.id}`)}
                >
                  <TableCell className="font-medium text-foreground">{b.name}</TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {b.sent_count + b.failed_count}/{b.total_targets}
                    {b.failed_count > 0 && (
                      <span className="ml-1 text-red-400">
                        ({b.failed_count} {t('failedSuffix')})
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[b.status]}`}
                    >
                      {tStatus(b.status)}
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {b.delay_seconds}s
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {formatWindow(b, t, dayLabels)}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {new Date(b.created_at).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
