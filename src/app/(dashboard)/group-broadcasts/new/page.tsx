'use client';

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, Paperclip, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { uploadAccountMedia } from '@/lib/storage/upload-media';
import { CHAT_MEDIA_BUCKET } from '@/components/inbox/message-composer';
import type { GroupContentType } from '@/lib/whatsapp/group-broadcast';

interface GroupOption {
  id: string;
  name: string;
  campaign_slug: string | null;
  status: 'active' | 'archived';
}

/** Local `datetime-local` floor (now + 1 min), mirrors message-composer.tsx. */
function minScheduleValue(): string {
  const d = new Date(Date.now() + 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MEDIA_TYPES: GroupContentType[] = ['image', 'video', 'document', 'audio'];

export default function NewGroupBroadcastPage() {
  const t = useTranslations('GroupBroadcasts.new');
  const router = useRouter();

  const [name, setName] = useState('');
  const [contentType, setContentType] = useState<GroupContentType>('text');
  const [contentText, setContentText] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [uploading, setUploading] = useState(false);

  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupFilter, setGroupFilter] = useState('');

  const [delaySeconds, setDelaySeconds] = useState('8');
  const [scheduleAt, setScheduleAt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [groupsRes, settingsRes] = await Promise.all([
          fetch('/api/whatsapp/groups', { cache: 'no-store' }),
          fetch('/api/whatsapp/group-broadcasts/settings', { cache: 'no-store' }),
        ]);
        const groupsData = await groupsRes.json().catch(() => ({}));
        const settingsData = await settingsRes.json().catch(() => ({}));
        if (cancelled) return;
        setGroups(
          (groupsData.data ?? []).filter((g: GroupOption) => g.status === 'active')
        );
        if (settingsData?.data?.delay_seconds) {
          setDelaySeconds(String(settingsData.data.delay_seconds));
        }
      } finally {
        if (!cancelled) setGroupsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredGroups = useMemo(() => {
    const q = groupFilter.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        (g.campaign_slug ?? '').toLowerCase().includes(q)
    );
  }, [groups, groupFilter]);

  function toggleGroup(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const g of filteredGroups) next.add(g.id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function handleFilePicked(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
      setMediaUrl(publicUrl);
      if (contentType === 'document') setFilename(file.name);
    } catch {
      toast.error(t('uploadError'));
    } finally {
      setUploading(false);
    }
  }

  const isMedia = MEDIA_TYPES.includes(contentType);
  const canSubmit =
    name.trim().length > 0 &&
    selectedIds.size > 0 &&
    Number(delaySeconds) >= 1 &&
    (contentType === 'text' ? contentText.trim().length > 0 : mediaUrl.length > 0) &&
    !submitting &&
    !uploading;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/whatsapp/group-broadcasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          content_type: contentType,
          content_text: contentText.trim() || undefined,
          media_url: mediaUrl || undefined,
          filename: contentType === 'document' ? filename || undefined : undefined,
          group_ids: Array.from(selectedIds),
          delay_seconds: Number(delaySeconds),
          scheduled_at: scheduleAt || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('createError'));
        return;
      }
      toast.success(t('createSuccess'));
      router.push(`/group-broadcasts/${data.data.id}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Card>
        <CardContent className="space-y-5 pt-6">
          <div className="space-y-2">
            <Label htmlFor="broadcast-name">{t('nameLabel')}</Label>
            <Input
              id="broadcast-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('contentTypeLabel')}</Label>
            <Select
              value={contentType}
              onValueChange={(v) => {
                setContentType(v as GroupContentType);
                setMediaUrl('');
                setFilename('');
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">{t('contentType.text')}</SelectItem>
                <SelectItem value="image">{t('contentType.image')}</SelectItem>
                <SelectItem value="video">{t('contentType.video')}</SelectItem>
                <SelectItem value="document">{t('contentType.document')}</SelectItem>
                <SelectItem value="audio">{t('contentType.audio')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {contentType !== 'audio' && (
            <div className="space-y-2">
              <Label htmlFor="broadcast-text">
                {contentType === 'text' ? t('messageLabel') : t('captionLabel')}
              </Label>
              <Textarea
                id="broadcast-text"
                value={contentText}
                onChange={(e) => setContentText(e.target.value)}
                rows={4}
                placeholder={t('messagePlaceholder')}
              />
            </div>
          )}

          {isMedia && (
            <div className="space-y-2">
              <Label>{t('mediaLabel')}</Label>
              {mediaUrl ? (
                <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground">
                  <span className="truncate">{filename || mediaUrl}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setMediaUrl('');
                      setFilename('');
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ) : (
                <label className="flex h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground hover:border-primary hover:text-foreground">
                  {uploading ? (
                    <Loader2 className="size-5 animate-spin" />
                  ) : (
                    <Paperclip className="size-5" />
                  )}
                  {uploading ? t('uploading') : t('attachFile')}
                  <input
                    type="file"
                    className="hidden"
                    disabled={uploading}
                    onChange={handleFilePicked}
                  />
                </label>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="broadcast-delay">{t('delayLabel')}</Label>
              <Input
                id="broadcast-delay"
                type="number"
                min={1}
                value={delaySeconds}
                onChange={(e) => setDelaySeconds(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('delayHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="broadcast-schedule">{t('scheduleLabel')}</Label>
              <Input
                id="broadcast-schedule"
                type="datetime-local"
                min={minScheduleValue()}
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('scheduleHint')}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex items-center justify-between gap-2">
            <Label>{t('groupsLabel', { count: selectedIds.size })}</Label>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={selectAllFiltered} type="button">
                {t('selectAllActive')}
              </Button>
              <Button variant="outline" size="sm" onClick={clearSelection} type="button">
                {t('clearSelection')}
              </Button>
            </div>
          </div>
          <Input
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            placeholder={t('groupFilterPlaceholder')}
          />
          {groupsLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : filteredGroups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('noGroupsFound')}
            </p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
              {filteredGroups.map((g) => (
                <label
                  key={g.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <Checkbox
                    checked={selectedIds.has(g.id)}
                    onCheckedChange={(checked) => toggleGroup(g.id, checked === true)}
                  />
                  <span className="text-foreground">{g.name}</span>
                  {g.campaign_slug && (
                    <span className="text-xs text-muted-foreground">({g.campaign_slug})</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => router.push('/group-broadcasts')}>
          {t('cancel')}
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {t('submit')}
        </Button>
      </div>
    </div>
  );
}
