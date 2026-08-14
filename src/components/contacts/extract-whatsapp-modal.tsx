'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Inbox,
  Loader2,
  CheckCircle,
  AlertTriangle,
  XCircle,
} from 'lucide-react';

interface ExtractResult {
  found: number;
  imported: number;
  skipped: number;
  failed: number;
}

interface ExtractWhatsappModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

export function ExtractWhatsappModal({
  open,
  onOpenChange,
  onImported,
}: ExtractWhatsappModalProps) {
  const t = useTranslations('Contacts.extractModal');

  const [extracting, setExtracting] = useState(false);
  const [result, setResult] = useState<ExtractResult | null>(null);

  function reset() {
    setResult(null);
    setExtracting(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleExtract() {
    setExtracting(true);
    try {
      const res = await fetch('/api/whatsapp/contacts/extract', {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(body?.error || t('toastError'));
      }

      const data = body.data as ExtractResult;
      setResult(data);

      if (data.imported > 0) {
        toast.success(t('toastImported', { count: data.imported }));
        onImported();
      } else {
        toast.info(t('toastNoneFound'));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setExtracting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('title')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('desc')}
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/80 bg-background/40 px-4 py-8 text-center">
            <div className="bg-primary/15 ring-primary/25 flex size-10 items-center justify-center rounded-lg ring-1">
              <Inbox className="text-primary size-5" />
            </div>
            {extracting && (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                {t('extracting')}
              </p>
            )}
          </div>
        )}

        {result && (
          <div className="rounded-xl border border-border bg-background/50 p-4">
            <p className="text-sm font-medium text-popover-foreground">
              {t('extractComplete')}
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
                <Inbox className="size-4 shrink-0" />
                {t('resultFound', { count: result.found })}
              </div>
              {result.imported > 0 && (
                <div className="text-primary flex items-center gap-1.5 text-sm">
                  <CheckCircle className="size-4 shrink-0" />
                  {t('resultImported', { count: result.imported })}
                </div>
              )}
              {result.skipped > 0 && (
                <div className="flex items-center gap-1.5 text-sm text-amber-400">
                  <AlertTriangle className="size-4 shrink-0" />
                  {t('resultSkipped', { count: result.skipped })}
                </div>
              )}
              {result.failed > 0 && (
                <div className="flex items-center gap-1.5 text-sm text-red-400">
                  <XCircle className="size-4 shrink-0" />
                  {t('resultFailed', { count: result.failed })}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {result ? t('close') : t('cancel')}
          </Button>
          {!result && (
            <Button
              onClick={handleExtract}
              disabled={extracting}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {extracting && <Loader2 className="size-4 animate-spin" />}
              {t('startBtn')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
