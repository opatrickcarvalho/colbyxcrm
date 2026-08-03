'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Clock, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

interface ScheduledMessageRow {
  id: string;
  content_type: 'text' | 'image' | 'document' | 'audio' | 'video';
  content_text: string | null;
  scheduled_at: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';
  error_message: string | null;
  conversation: {
    id: string;
    contact: { name: string | null; phone: string | null } | null;
  } | null;
}

const STATUS_CLASSES: Record<ScheduledMessageRow['status'], string> = {
  pending: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  processing: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400',
  sent: 'border-green-500/30 bg-green-500/10 text-green-400',
  failed: 'border-red-500/30 bg-red-500/10 text-red-400',
  cancelled: 'border-border bg-muted text-muted-foreground',
};

function preview(row: ScheduledMessageRow): string {
  if (row.content_type === 'text') return row.content_text ?? '';
  return `[${row.content_type}]${row.content_text ? ` ${row.content_text}` : ''}`;
}

export default function ScheduledMessagesPage() {
  const t = useTranslations('ScheduledMessages.page');
  const tStatus = useTranslations('ScheduledMessages.status');
  const [items, setItems] = useState<ScheduledMessageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch('/api/whatsapp/scheduled-messages', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t('errorLoad'));
      setItems(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorLoad'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Mount-only fetch — `load` reads no reactive state itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCancel(id: string) {
    if (!window.confirm(t('cancelConfirm'))) return;
    setCancellingId(id);
    try {
      const res = await fetch(`/api/whatsapp/scheduled-messages/${id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('cancelError'));
        return;
      }
      toast.success(t('cancelled'));
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, status: 'cancelled' } : item)),
      );
    } catch {
      toast.error(t('cancelError'));
    } finally {
      setCancellingId(null);
    }
  }

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
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {items.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Clock className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('empty')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('table.contact')}</TableHead>
                <TableHead className="text-muted-foreground">{t('table.message')}</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">
                  {t('table.scheduledAt')}
                </TableHead>
                <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                <TableHead className="text-right text-muted-foreground">
                  {t('table.actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <TableRow key={row.id} className="border-border hover:bg-muted/50">
                  <TableCell className="font-medium text-foreground">
                    {row.conversation?.contact?.name ||
                      row.conversation?.contact?.phone ||
                      t('unknownContact')}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {preview(row)}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {new Date(row.scheduled_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[row.status]}`}
                      title={row.status === 'failed' ? row.error_message ?? undefined : undefined}
                    >
                      {tStatus(row.status)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {row.status === 'pending' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={cancellingId === row.id}
                        onClick={() => handleCancel(row.id)}
                        className="h-8 text-muted-foreground hover:text-red-400"
                      >
                        {cancellingId === row.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <X className="h-4 w-4" />
                        )}
                        {t('cancel')}
                      </Button>
                    )}
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
