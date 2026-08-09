'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FileText, Loader2, Save, Trash2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { GroupContentType } from '@/lib/whatsapp/group-broadcast';

export interface CampaignTemplate {
  id: string;
  name: string;
  content_type: GroupContentType;
  content_text: string | null;
  media_url: string | null;
  filename: string | null;
}

/** What the composer currently holds — offered as a template to save. */
export interface CampaignDraft {
  content_type: GroupContentType;
  content_text: string;
  media_url: string;
  filename: string;
}

interface TemplateManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Loads a saved template's content into the composer and closes the dialog. */
  onPick: (template: CampaignTemplate) => void;
  draft: CampaignDraft;
}

/**
 * Combined picker + manager for campaign_templates (052): lets the
 * composer load a saved spintax template, and save its current draft as a
 * new one, in a single dialog. Separate from Settings' TemplateManager,
 * which manages Meta-approved WhatsApp templates — these are unofficial,
 * UAZAPI-only, spintax-capable local snippets with no approval flow.
 */
export function TemplateManagerDialog({
  open,
  onOpenChange,
  onPick,
  draft,
}: TemplateManagerDialogProps) {
  const t = useTranslations('GroupBroadcasts.new.templates');

  const [templates, setTemplates] = useState<CampaignTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch('/api/campaign-templates', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) setTemplates(data.templates ?? []);
        else if (!cancelled) toast.error(t('toastLoadError'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  const canSaveDraft =
    draft.content_type === 'text' ? draft.content_text.trim().length > 0 : draft.media_url.length > 0;

  async function handleSave() {
    if (!saveName.trim() || !canSaveDraft || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/campaign-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: saveName.trim(),
          content_type: draft.content_type,
          content_text: draft.content_text.trim() || undefined,
          media_url: draft.media_url || undefined,
          filename: draft.filename || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('toastSaveError'));
        return;
      }
      setTemplates((prev) => [data.template, ...prev]);
      setSaveName('');
      toast.success(t('toastSaved'));
    } catch {
      toast.error(t('toastSaveError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(template: CampaignTemplate) {
    setDeletingId(template.id);
    try {
      const res = await fetch(`/api/campaign-templates/${template.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? t('toastDeleteError'));
        return;
      }
      setTemplates((prev) => prev.filter((tpl) => tpl.id !== template.id));
      toast.success(t('toastDeleted'));
    } catch {
      toast.error(t('toastDeleteError'));
    } finally {
      setDeletingId(null);
    }
  }

  function handlePick(template: CampaignTemplate) {
    onPick(template);
    onOpenChange(false);
    toast.success(t('toastLoaded'));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('dialogTitle')}</DialogTitle>
          <DialogDescription>{t('dialogDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
          <Label htmlFor="template-save-name">{t('nameLabel')}</Label>
          <div className="flex gap-2">
            <Input
              id="template-save-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder={t('namePlaceholder')}
              className="flex-1"
            />
            <Button
              type="button"
              onClick={handleSave}
              disabled={!saveName.trim() || !canSaveDraft || saving}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {saving ? t('saving') : t('save')}
            </Button>
          </div>
        </div>

        <div className="max-h-[45vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : templates.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {templates.map((tpl) => (
                <li
                  key={tpl.id}
                  className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2.5"
                >
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{tpl.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {tpl.content_text || tpl.filename || tpl.content_type}
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => handlePick(tpl)}>
                    {t('load')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={deletingId === tpl.id}
                    onClick={() => void handleDelete(tpl)}
                    className="text-muted-foreground hover:text-red-400 hover:bg-red-950/30"
                    aria-label={t('delete')}
                  >
                    {deletingId === tpl.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
