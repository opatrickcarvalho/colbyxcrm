'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Loader2, Pencil, Plus, Trash2, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCan } from '@/hooks/use-can';
import {
  AudiencePicker,
  EMPTY_AUDIENCE_SELECTION,
  type AudienceSelection,
} from '@/components/campaigns/audience-picker';

interface SavedAudience {
  id: string;
  name: string;
  member_count: number;
  updated_at: string;
}

/** Shape returned by GET /api/campaign-audiences/[id] — the XOR of 052. */
interface AudienceMemberRow {
  contact_id: string | null;
  group_id: string | null;
  phone: string | null;
}

/**
 * Editor state. `null` means the dialog is closed; an entry without an
 * `id` is a brand-new audience, which is why the id is optional rather
 * than a separate mode flag.
 */
interface EditorState {
  id?: string;
  name: string;
  selection: AudienceSelection;
}

/**
 * Manager for the saved audiences a campaign can be seeded from
 * (`campaign_audiences`, migration 052). A campaign snapshots its
 * targets at creation, so editing an audience here only changes what
 * *future* campaigns start from — never one that already fired.
 */
export default function CampaignAudiencesPage() {
  const t = useTranslations('GroupBroadcasts.audiences');
  const router = useRouter();
  const canManage = useCan('send-messages');

  const [audiences, setAudiences] = useState<SavedAudience[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editor, setEditor] = useState<EditorState | null>(null);
  // Distinct from `editor === null`: the dialog is already open while an
  // existing audience's members are still being fetched.
  const [editorLoading, setEditorLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<SavedAudience | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/campaign-audiences', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t('errorLoad'));
      setAudiences(data.audiences ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorLoad'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditor({ name: '', selection: EMPTY_AUDIENCE_SELECTION });
  }

  async function openEdit(audience: SavedAudience) {
    setEditorLoading(true);
    setEditor({ id: audience.id, name: audience.name, selection: EMPTY_AUDIENCE_SELECTION });
    try {
      const res = await fetch(`/api/campaign-audiences/${audience.id}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('errorLoad'));
        setEditor(null);
        return;
      }
      const members: AudienceMemberRow[] = data.audience?.members ?? [];
      setEditor({
        id: audience.id,
        name: data.audience?.name ?? audience.name,
        selection: {
          contactIds: members.filter((m) => m.contact_id).map((m) => m.contact_id as string),
          groupIds: members.filter((m) => m.group_id).map((m) => m.group_id as string),
          phones: members.filter((m) => m.phone).map((m) => m.phone as string),
        },
      });
    } catch {
      toast.error(t('errorLoad'));
      setEditor(null);
    } finally {
      setEditorLoading(false);
    }
  }

  const editorTotal = editor
    ? editor.selection.contactIds.length +
      editor.selection.groupIds.length +
      editor.selection.phones.length
    : 0;

  async function handleSave() {
    if (!editor || !editor.name.trim() || editorTotal === 0 || saving) return;
    setSaving(true);
    try {
      // PATCH replaces the member set wholesale — the API has no
      // per-member endpoint, and the picker always hands back the full
      // selection anyway.
      const res = await fetch(
        editor.id ? `/api/campaign-audiences/${editor.id}` : '/api/campaign-audiences',
        {
          method: editor.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: editor.name.trim(),
            targets: {
              group_ids: editor.selection.groupIds,
              contact_ids: editor.selection.contactIds,
              phones: editor.selection.phones,
            },
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('errorSave'));
        return;
      }
      toast.success(editor.id ? t('toastUpdated') : t('toastCreated'));
      setEditor(null);
      void load();
    } catch {
      toast.error(t('errorSave'));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/campaign-audiences/${pendingDelete.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? t('errorDelete'));
        return;
      }
      toast.success(t('toastDeleted'));
      setPendingDelete(null);
      void load();
    } finally {
      setDeleting(false);
    }
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

  if (audiences === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <button
        onClick={() => router.push('/group-broadcasts')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t('backToCampaigns')}
      </button>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <GatedButton
          canAct={canManage}
          gateReason="send messages"
          onClick={openCreate}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t('newAudience')}
        </GatedButton>
      </div>

      {audiences.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Users className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('emptyTitle')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('emptyDesc')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('table.name')}</TableHead>
                <TableHead className="text-muted-foreground">{t('table.members')}</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">
                  {t('table.updated')}
                </TableHead>
                <TableHead className="w-24 text-right text-muted-foreground">
                  {t('table.actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audiences.map((a) => (
                <TableRow key={a.id} className="border-border">
                  <TableCell className="font-medium text-foreground">{a.name}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {t('memberCount', { count: a.member_count })}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {new Date(a.updated_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canManage}
                        onClick={() => void openEdit(a)}
                        aria-label={t('edit')}
                        title={t('edit')}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canManage}
                        onClick={() => setPendingDelete(a)}
                        aria-label={t('delete')}
                        title={t('delete')}
                        className="text-muted-foreground hover:bg-red-950/30 hover:text-red-400"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={!!editor} onOpenChange={(open) => !open && !saving && setEditor(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editor?.id ? t('editTitle') : t('createTitle')}</DialogTitle>
            <DialogDescription>{t('dialogDesc')}</DialogDescription>
          </DialogHeader>

          {editorLoading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : (
            editor && (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="audience-name">{t('nameLabel')}</Label>
                  <Input
                    id="audience-name"
                    value={editor.name}
                    onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                    placeholder={t('namePlaceholder')}
                  />
                </div>
                {/* Remounted per audience so the picker's phone textarea
                    takes the loaded members as its initial value. */}
                <AudiencePicker
                  key={editor.id ?? 'new'}
                  selection={editor.selection}
                  onSelectionChange={(selection) =>
                    setEditor((prev) => (prev ? { ...prev, selection } : prev))
                  }
                  showSavedAudiences={false}
                />
              </div>
            )
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditor(null)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || editorLoading || !editor?.name.trim() || editorTotal === 0}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteDesc', { name: pendingDelete?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
