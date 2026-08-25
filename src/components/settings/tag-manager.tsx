'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Tag as TagIcon, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import type { Tag } from '@/types';

const PRESET_COLORS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'emerald', value: '#10b981' },
  { name: 'cyan', value: '#06b6d4' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'pink', value: '#ec4899' },
];

interface WhatsappLabel {
  id: string;
  name: string;
  color_code: number;
}

const NO_SYNC = '__none__';

/** Small "Sincronizar com etiqueta do WhatsApp" select, shared by the
 *  create row and the edit dialog. Renders nothing when the account
 *  has no WhatsApp labels to offer (not UAZAPI-connected, or none
 *  created on the phone yet) — there's nothing useful to pick. */
function WhatsappLabelSelect({
  labels,
  value,
  onChange,
  t,
}: {
  labels: WhatsappLabel[];
  value: string;
  onChange: (value: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  if (labels.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{t('syncWithWhatsappLabel')}</Label>
      <Select value={value} onValueChange={(v) => onChange(v ?? NO_SYNC)}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={t('syncWithWhatsappLabelNone')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_SYNC}>{t('syncWithWhatsappLabelNone')}</SelectItem>
          {labels.map((l) => (
            <SelectItem key={l.id} value={l.id}>
              {l.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">{t('syncWithWhatsappLabelHint')}</p>
    </div>
  );
}

/**
 * Tags card — colour-coded contact labels. Creation is an inline row
 * (name + colour swatch + optional WhatsApp label sync + Add); clicking
 * an existing tag opens an edit dialog for the same fields; deletion
 * goes through a confirmation dialog since it detaches the tag from
 * every contact.
 */
export function TagManager() {
  const t = useTranslations('Settings.tagsAndFields');
  const supabase = createClient();
  const { user, accountId, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [tags, setTags] = useState<Tag[]>([]);
  const [whatsappLabels, setWhatsappLabels] = useState<WhatsappLabel[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [tagToDelete, setTagToDelete] = useState<Tag | null>(null);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [editSync, setEditSync] = useState(NO_SYNC);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedColor, setSelectedColor] = useState(PRESET_COLORS[3].value);
  const [newTagSync, setNewTagSync] = useState(NO_SYNC);

  useEffect(() => {
    if (authLoading) return;
    if (!accountId || !user) {
      setLoading(false);
      return;
    }
    fetchTags(accountId, user.id);
    fetchWhatsappLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accountId, user?.id]);

  async function fetchTags(accountId: string, userId: string) {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('tags')
        .select('*')
        // Include tags belonging to the account OR created by the current user (legacy).
        .or(`account_id.eq.${accountId},user_id.eq.${userId}`)
        .order('created_at', { ascending: true });

      if (error) throw error;
      setTags(data || []);
    } catch (err) {
      console.error('Failed to fetch tags:', err);
      toast.error(t('failedToLoadTags'));
    } finally {
      setLoading(false);
    }
  }

  // Best-effort: an account not connected via UAZAPI (or with no
  // labels on the phone yet) simply gets an empty list, and the sync
  // picker hides itself — never blocks the rest of the tags UI.
  async function fetchWhatsappLabels() {
    try {
      const res = await fetch('/api/whatsapp/labels', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      setWhatsappLabels(data?.labels ?? []);
    } catch (err) {
      console.error('Failed to fetch WhatsApp labels:', err);
    }
  }

  async function handleCreate() {
    if (!newTagName.trim()) {
      toast.error(t('nameRequired'));
      return;
    }

    try {
      setSaving(true);
      if (!user || !accountId) {
        toast.error(t('notAuthenticated'));
        return;
      }

      // account_id is mandatory on every account-scoped insert (NOT
      // NULL + RLS, no DB default).
      const { error } = await supabase.from('tags').insert({
        user_id: user.id,
        account_id: accountId,
        name: newTagName.trim(),
        color: selectedColor,
        whatsapp_label_id: newTagSync === NO_SYNC ? null : newTagSync,
      });

      if (error) throw error;

      toast.success(t('tagCreated'));
      setNewTagName('');
      setSelectedColor(PRESET_COLORS[3].value);
      setNewTagSync(NO_SYNC);
      await fetchTags(accountId, user.id);
    } catch (err) {
      console.error('Create error:', err);
      toast.error(t('failedToCreateTag'));
    } finally {
      setSaving(false);
    }
  }

  function openEdit(tag: Tag) {
    setEditingTag(tag);
    setEditName(tag.name);
    setEditColor(tag.color);
    setEditSync(tag.whatsapp_label_id ?? NO_SYNC);
  }

  async function handleEditSave() {
    if (!editingTag || !accountId || !user) return;
    if (!editName.trim()) {
      toast.error(t('nameRequired'));
      return;
    }
    try {
      setSaving(true);
      const { error } = await supabase
        .from('tags')
        .update({
          name: editName.trim(),
          color: editColor,
          whatsapp_label_id: editSync === NO_SYNC ? null : editSync,
        })
        .eq('id', editingTag.id);

      if (error) throw error;

      toast.success(t('tagUpdated'));
      setEditingTag(null);
      await fetchTags(accountId, user.id);
    } catch (err) {
      console.error('Update error:', err);
      toast.error(t('failedToUpdateTag'));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(tag: Tag) {
    setTagToDelete(tag);
    setDeleteDialogOpen(true);
  }

  async function handleDelete() {
    if (!tagToDelete) return;

    try {
      setDeleting(true);
      const { error } = await supabase
        .from('tags')
        .delete()
        .eq('id', tagToDelete.id);

      if (error) throw error;

      toast.success(t('tagDeleted'));
      setTags((prev) => prev.filter((t) => t.id !== tagToDelete.id));
      setDeleteDialogOpen(false);
      setTagToDelete(null);
    } catch (err) {
      console.error('Delete error:', err);
      toast.error(t('failedToDeleteTag'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <TagIcon className="size-4 text-primary" />
          {t('tagsTitle')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('tagsDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {tags.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="group inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                      border: `1px solid ${tag.color}40`,
                    }}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <button
                      type="button"
                      onClick={() => openEdit(tag)}
                      className="cursor-pointer"
                      title={
                        tag.whatsapp_label_id
                          ? t('syncedBadge')
                          : undefined
                      }
                    >
                      {tag.name}
                      {tag.whatsapp_label_id ? ' 🔗' : ''}
                    </button>
                    <button
                      type="button"
                      onClick={() => confirmDelete(tag)}
                      aria-label={t('deleteAria', { name: tag.name })}
                      className="ml-0.5 rounded-full p-0.5 opacity-60 transition-opacity hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('noTags')}
              </p>
            )}

            {/* Inline create row */}
            <div className="space-y-3 rounded-lg border border-border/60 p-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <Input
                  placeholder={t('placeholder')}
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                  }}
                  disabled={saving}
                  maxLength={40}
                  className="min-w-[180px] flex-1"
                />
                <div className="flex gap-1.5">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color.value}
                      type="button"
                      onClick={() => setSelectedColor(color.value)}
                      aria-label={t('useColor', { color: t(`colors.${color.name}` as Parameters<typeof t>[0]) })}
                      aria-pressed={selectedColor === color.value}
                      className={cn(
                        'size-6 rounded-md transition-transform hover:scale-110',
                        selectedColor === color.value &&
                          'outline outline-2 outline-offset-2 outline-primary',
                      )}
                      style={{ backgroundColor: color.value }}
                      title={t(`colors.${color.name}` as Parameters<typeof t>[0])}
                    />
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCreate}
                  disabled={saving || !newTagName.trim()}
                >
                  {saving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  {t('addTag')}
                </Button>
              </div>
              <WhatsappLabelSelect
                labels={whatsappLabels}
                value={newTagSync}
                onChange={setNewTagSync}
                t={t}
              />
            </div>
          </>
        )}
      </CardContent>

      {/* Edit dialog */}
      <Dialog open={!!editingTag} onOpenChange={(open) => !open && setEditingTag(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('editTag')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('placeholder')}</Label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={40}
              />
            </div>
            <div className="flex gap-1.5">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color.value}
                  type="button"
                  onClick={() => setEditColor(color.value)}
                  aria-pressed={editColor === color.value}
                  className={cn(
                    'size-6 rounded-md transition-transform hover:scale-110',
                    editColor === color.value &&
                      'outline outline-2 outline-offset-2 outline-primary',
                  )}
                  style={{ backgroundColor: color.value }}
                  title={t(`colors.${color.name}` as Parameters<typeof t>[0])}
                />
              ))}
            </div>
            <WhatsappLabelSelect
              labels={whatsappLabels}
              value={editSync}
              onChange={setEditSync}
              t={t}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditingTag(null)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={handleEditSave} disabled={saving || !editName.trim()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteTag')}</DialogTitle>
            <DialogDescription>
              {tagToDelete ? t('deleteConfirm', { name: tagToDelete.name }) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('deleting')}
                </>
              ) : (
                t('deleteTag')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
