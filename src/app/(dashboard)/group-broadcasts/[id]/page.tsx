'use client';

import { useEffect, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, ArrowLeft, Pause, Play, X } from 'lucide-react';

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
import { createClient } from '@/lib/supabase/client';

interface TargetRow {
  id: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';
  send_at: string;
  sent_at: string | null;
  error_message: string | null;
  group: { id: string; name: string } | null;
  // Added by migration 052 — a target is a group, a saved contact, OR a
  // hand-typed phone number, never more than one.
  contact_id?: string | null;
  contact?: { id: string; name: string | null; phone: string } | null;
  phone?: string | null;
  // The spintax variant actually rendered for this recipient, frozen at
  // send time — what was truly sent, as opposed to the source template.
  rendered_text?: string | null;
}

interface BroadcastDetail {
  id: string;
  name: string;
  status: 'pending' | 'sending' | 'paused' | 'sent' | 'failed' | 'cancelled';
  content_type: string;
  delay_seconds: number;
  delay_jitter_pct?: number;
  window_start?: string | null;
  window_end?: string | null;
  window_days?: number[] | null;
  total_targets: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
  targets: TargetRow[];
}

/**
 * Recipient label for a target row — whichever of the three kinds is set.
 * `contactsById` is a client-side fallback lookup: the detail route's
 * targets query only embeds `group:whatsapp_groups(id, name)`, not a
 * contact, so a contact target is enriched here instead (see the
 * `contactsById` effect below) rather than showing a raw UUID.
 */
function targetLabel(
  target: TargetRow,
  t: ReturnType<typeof useTranslations>,
  contactsById: Record<string, { name: string | null; phone: string }>
): string {
  if (target.group) return target.group.name;
  if (target.contact) return target.contact.name || target.contact.phone;
  if (target.contact_id) {
    const c = contactsById[target.contact_id];
    if (c) return c.name || c.phone;
    return t('unknownContact');
  }
  if (target.phone) return target.phone;
  return t('unknownGroup');
}

export default function GroupBroadcastDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const t = useTranslations('GroupBroadcasts.detail');
  const tStatus = useTranslations('GroupBroadcasts.status');
  const tDays = useTranslations('GroupBroadcasts.days');
  const router = useRouter();

  const dayLabels: Record<number, string> = {
    1: tDays('mon'),
    2: tDays('tue'),
    3: tDays('wed'),
    4: tDays('thu'),
    5: tDays('fri'),
    6: tDays('sat'),
    7: tDays('sun'),
  };

  const [broadcast, setBroadcast] = useState<BroadcastDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  // Guards a single row's button while its own request is in flight,
  // rather than a blanket boolean that would disable every "Remove"
  // button in the table for one row's request.
  const [removingTargetId, setRemovingTargetId] = useState<string | null>(null);
  // Fallback name/phone lookup for contact targets — see targetLabel().
  const [contactsById, setContactsById] = useState<
    Record<string, { name: string | null; phone: string }>
  >({});

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

  // Backfill names for contact targets the detail API doesn't embed
  // (it only joins `group:whatsapp_groups`). Only fetches ids not
  // already resolved, so repeated polling ticks don't re-query.
  useEffect(() => {
    const missing = Array.from(
      new Set(
        (broadcast?.targets ?? [])
          .filter((tg) => tg.contact_id && !tg.contact && !contactsById[tg.contact_id!])
          .map((tg) => tg.contact_id as string)
      )
    );
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      // PostgREST puts `.in(...)` in the query string — a campaign with
      // thousands of contact targets can build a URL long enough to be
      // rejected (400), which silently left every one of those targets
      // showing as "removed" instead of just not-yet-resolved. Chunk it
      // the same way src/lib/campaigns/targets.ts does server-side.
      const chunkSize = 200;
      const found: { id: string; name: string | null; phone: string }[] = [];
      for (let i = 0; i < missing.length; i += chunkSize) {
        const { data } = await supabase
          .from('contacts')
          .select('id, name, phone')
          .in('id', missing.slice(i, i + chunkSize));
        if (data) found.push(...data);
      }
      if (cancelled || found.length === 0) return;
      setContactsById((prev) => {
        const next = { ...prev };
        for (const c of found) next[c.id] = { name: c.name ?? null, phone: c.phone };
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [broadcast, contactsById]);

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

  async function handlePause() {
    setPausing(true);
    try {
      const res = await fetch(`/api/whatsapp/group-broadcasts/${id}/pause`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('pauseError'));
        return;
      }
      toast.success(t('pauseSuccess'));
      void load();
    } finally {
      setPausing(false);
    }
  }

  async function handleResume() {
    setResuming(true);
    try {
      const res = await fetch(`/api/whatsapp/group-broadcasts/${id}/resume`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('resumeError'));
        return;
      }
      toast.success(t('resumeSuccess'));
      void load();
    } finally {
      setResuming(false);
    }
  }

  async function handleRemoveTarget(targetId: string) {
    setRemovingTargetId(targetId);
    try {
      const res = await fetch(`/api/whatsapp/group-broadcasts/${id}/targets/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_ids: [targetId] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('removeTargetError'));
        return;
      }
      toast.success(t('removeTargetSuccess'));
      void load();
    } finally {
      setRemovingTargetId(null);
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

  // Cancel is deliberately allowed while paused too — the API's own
  // guard (cancel/route.ts) only blocks it once the campaign is
  // already terminal (sent/failed/cancelled itself).
  const canCancel =
    broadcast.status === 'pending' ||
    broadcast.status === 'sending' ||
    broadcast.status === 'paused';
  const canPause = broadcast.status === 'pending' || broadcast.status === 'sending';
  const canResume = broadcast.status === 'paused';

  const windowSummary =
    broadcast.window_start && broadcast.window_end
      ? t('windowLabel', {
          start: broadcast.window_start.slice(0, 5),
          end: broadcast.window_end.slice(0, 5),
          days: broadcast.window_days?.length
            ? broadcast.window_days.map((d) => dayLabels[d]).join(', ')
            : t('windowAllDays'),
        })
      : t('windowNone');

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
            {typeof broadcast.delay_jitter_pct === 'number' && broadcast.delay_jitter_pct > 0 && (
              <> · {t('jitterSummary', { pct: broadcast.delay_jitter_pct })}</>
            )}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">{windowSummary}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {canPause && (
            <Button variant="outline" onClick={handlePause} disabled={pausing}>
              {pausing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Pause className="size-4" />
              )}
              {t('pause')}
            </Button>
          )}
          {canResume && (
            <Button variant="outline" onClick={handleResume} disabled={resuming}>
              {resuming ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {t('resume')}
            </Button>
          )}
          {canCancel && (
            <Button variant="outline" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('cancel')}
            </Button>
          )}
        </div>
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
              <TableHead className="text-muted-foreground">{t('table.recipient')}</TableHead>
              <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
              <TableHead className="hidden text-muted-foreground sm:table-cell">
                {t('table.sendAt')}
              </TableHead>
              <TableHead className="hidden text-muted-foreground sm:table-cell">
                {t('table.error')}
              </TableHead>
              <TableHead className="text-muted-foreground" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {broadcast.targets.map((target) => (
              <TableRow key={target.id} className="border-border align-top">
                <TableCell className="font-medium text-foreground">
                  {targetLabel(target, t, contactsById)}
                  {target.rendered_text && (
                    <p className="mt-1 max-w-xs whitespace-pre-wrap text-xs font-normal text-muted-foreground">
                      {t('renderedTextLabel')}: {target.rendered_text}
                    </p>
                  )}
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
                <TableCell>
                  {target.status === 'pending' && (
                    <button
                      type="button"
                      onClick={() => handleRemoveTarget(target.id)}
                      disabled={removingTargetId === target.id}
                      title={t('removeTarget')}
                      aria-label={t('removeTarget')}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      {removingTargetId === target.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <X className="size-4" />
                      )}
                    </button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
