'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, Paperclip, Shuffle, FileText, Save, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { uploadAccountMedia } from '@/lib/storage/upload-media';
import { CHAT_MEDIA_BUCKET } from '@/components/inbox/message-composer';
import type { GroupContentType } from '@/lib/whatsapp/group-broadcast';
import { renderMessage, validateSpintax, countVariants } from '@/lib/campaigns/spintax';
import {
  AudiencePicker,
  EMPTY_AUDIENCE_SELECTION,
  type AudienceSelection,
} from '@/components/campaigns/audience-picker';
import {
  TemplateManagerDialog,
  type CampaignTemplate,
} from '@/components/campaigns/template-manager-dialog';

/** Local `datetime-local` floor (now + 1 min), mirrors message-composer.tsx. */
function minScheduleValue(): string {
  const d = new Date(Date.now() + 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MEDIA_TYPES: GroupContentType[] = ['image', 'video', 'document', 'audio'];

// ISO weekdays, 1 = Monday .. 7 = Sunday — matches window_days (052).
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const VARIABLE_TOKENS = ['{{nome}}', '{{primeiro_nome}}', '{{telefone}}', '{{emoji}}'] as const;

// Sample values for the live preview — never sent, just illustrative.
const PREVIEW_VARS = {
  nome: 'Maria Silva',
  primeiro_nome: 'Maria',
  telefone: '+55 11 99999-9999',
};

export default function NewGroupBroadcastPage() {
  const t = useTranslations('GroupBroadcasts.new');
  const tDays = useTranslations('GroupBroadcasts.days');
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Static key lookups (not a dynamic t() call) — keeps next-intl's
  // static-analysis-friendly usage while still being weekday-indexed.
  // Shared with the list/detail screens under the top-level `days` key.
  const WEEKDAY_LABELS: Record<number, string> = {
    1: tDays('mon'),
    2: tDays('tue'),
    3: tDays('wed'),
    4: tDays('thu'),
    5: tDays('fri'),
    6: tDays('sat'),
    7: tDays('sun'),
  };

  const [name, setName] = useState('');
  const [contentType, setContentType] = useState<GroupContentType>('text');
  const [contentText, setContentText] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [uploading, setUploading] = useState(false);

  const [audience, setAudience] = useState<AudienceSelection>(EMPTY_AUDIENCE_SELECTION);
  const [saveAudienceAs, setSaveAudienceAs] = useState('');

  const [spintaxEnabled, setSpintaxEnabled] = useState(true);
  const [invisibleChars, setInvisibleChars] = useState(false);
  const [previewText, setPreviewText] = useState('');
  const [shuffleNonce, setShuffleNonce] = useState(0);

  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  const [delaySeconds, setDelaySeconds] = useState('8');
  const [delayJitterPct, setDelayJitterPct] = useState('20');
  const [scheduleAt, setScheduleAt] = useState('');
  const [windowEnabled, setWindowEnabled] = useState(false);
  const [windowStart, setWindowStart] = useState('09:00');
  const [windowEnd, setWindowEnd] = useState('18:00');
  const [windowDays, setWindowDays] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch('/api/whatsapp/group-broadcasts/settings', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!cancelled && data?.data?.delay_seconds) {
        setDelaySeconds(String(data.data.delay_seconds));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const spintaxCheck = useMemo(() => validateSpintax(contentText), [contentText]);
  const variantCount = useMemo(() => countVariants(contentText), [contentText]);

  useEffect(() => {
    if (!contentText.trim() || !spintaxCheck.ok) {
      setPreviewText('');
      return;
    }
    setPreviewText(renderMessage(contentText, { vars: PREVIEW_VARS, invisibleChars }));
    // shuffleNonce is a deliberate re-render trigger to force a fresh
    // random render on demand — it's already listed below.
  }, [contentText, invisibleChars, spintaxCheck.ok, shuffleNonce]);

  function insertVariable(token: string) {
    const el = textareaRef.current;
    if (!el) {
      setContentText((prev) => prev + token);
      return;
    }
    const start = el.selectionStart ?? contentText.length;
    const end = el.selectionEnd ?? contentText.length;
    const next = contentText.slice(0, start) + token + contentText.slice(end);
    setContentText(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function handlePickTemplate(template: CampaignTemplate) {
    setContentType(template.content_type);
    setContentText(template.content_text ?? '');
    setMediaUrl(template.media_url ?? '');
    setFilename(template.filename ?? '');
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

  function toggleWeekday(day: number) {
    setWindowDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  const isMedia = MEDIA_TYPES.includes(contentType);
  const hasContent =
    contentType === 'text' ? contentText.trim().length > 0 : mediaUrl.length > 0;
  const hasAudience =
    audience.contactIds.length > 0 || audience.groupIds.length > 0 || audience.phones.length > 0;
  const windowValid = !windowEnabled || (windowStart && windowEnd && windowDays.size > 0);
  const jitterNum = Number(delayJitterPct);
  const delayNum = Number(delaySeconds);

  const canSubmit =
    name.trim().length > 0 &&
    hasAudience &&
    hasContent &&
    spintaxCheck.ok &&
    Number.isFinite(delayNum) &&
    delayNum >= 1 &&
    Number.isFinite(jitterNum) &&
    jitterNum >= 0 &&
    jitterNum <= 90 &&
    windowValid &&
    !submitting &&
    !uploading;

  // 60s ±20% → between 48s and 72s
  const jitterRange = useMemo(() => {
    if (!Number.isFinite(delayNum) || !Number.isFinite(jitterNum)) return null;
    const swing = delayNum * (jitterNum / 100);
    return {
      min: Math.max(0, Math.round(delayNum - swing)),
      max: Math.round(delayNum + swing),
    };
  }, [delayNum, jitterNum]);

  async function handleSubmit() {
    if (!canSubmit) return;

    // `datetime-local` hands back a naive wall-clock string with no
    // offset, so it only means what the operator picked while it is
    // still in the browser — the zone they are sitting in. Resolve it to
    // an absolute instant here rather than shipping the ambiguity to the
    // server, which would otherwise read it in its own zone (UTC in
    // production) and reject it as past, or silently fire it hours
    // early. Same contract the inbox composer uses for scheduled
    // messages.
    let scheduledDate: Date | null = null;
    if (scheduleAt) {
      scheduledDate = new Date(scheduleAt);
      if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
        toast.error(t('schedule.invalidDate'));
        return;
      }
    }

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
          delay_seconds: delayNum,
          delay_jitter_pct: jitterNum,
          scheduled_at: scheduledDate ? scheduledDate.toISOString() : undefined,
          // The sending window is wall-clock, so it is meaningless
          // without the zone it was authored in. Until now this was left
          // unset and every campaign silently inherited the column
          // default (America/Sao_Paulo), which is wrong for any operator
          // elsewhere.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          window: windowEnabled
            ? { start: windowStart, end: windowEnd, days: Array.from(windowDays).sort() }
            : null,
          spintax_enabled: spintaxEnabled,
          invisible_chars: invisibleChars,
          targets: {
            group_ids: audience.groupIds,
            contact_ids: audience.contactIds,
            phones: audience.phones,
          },
          save_audience_as: saveAudienceAs.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('createError'));
        return;
      }
      toast.success(t('createSuccess'));
      router.push(`/group-broadcasts/${data.id}`);
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
        <CardContent className="space-y-2 pt-6">
          <Label htmlFor="campaign-name">{t('nameLabel')}</Label>
          <Input
            id="campaign-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="text-sm font-semibold text-foreground">{t('sectionAudience')}</h2>
          <AudiencePicker
            selection={audience}
            onSelectionChange={setAudience}
            saveAsName={saveAudienceAs}
            onSaveAsNameChange={setSaveAudienceAs}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 pt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">{t('sectionMessage')}</h2>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setTemplatePickerOpen(true)}>
                <FileText className="size-3.5" />
                {t('templates.loadButton')}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('contentTypeLabel')}</Label>
            <Select
              value={contentType}
              onValueChange={(v) => {
                if (!v) return;
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
              <Label htmlFor="campaign-text">
                {contentType === 'text' ? t('messageLabel') : t('captionLabel')}
              </Label>
              <Textarea
                ref={textareaRef}
                id="campaign-text"
                value={contentText}
                onChange={(e) => setContentText(e.target.value)}
                rows={5}
                placeholder={t('messagePlaceholder')}
              />
              <div className="flex flex-wrap gap-1.5">
                {VARIABLE_TOKENS.map((token) => (
                  <Button
                    key={token}
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => insertVariable(token)}
                  >
                    {token}
                  </Button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch checked={spintaxEnabled} onCheckedChange={setSpintaxEnabled} />
                  {t('composer.spintaxEnabledLabel')}
                </label>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch checked={invisibleChars} onCheckedChange={setInvisibleChars} />
                  {t('composer.invisibleCharsLabel')}
                </label>
              </div>

              {!spintaxCheck.ok && (
                <p className="text-xs text-red-400">
                  {t('composer.spintaxError', { error: spintaxCheck.error })}
                </p>
              )}

              {contentText.trim().length > 0 && spintaxCheck.ok && (
                <div className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t('composer.previewLabel')}
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">
                        {t('composer.variantsCount', { count: variantCount })}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setShuffleNonce((n) => n + 1)}
                        aria-label={t('composer.shuffle')}
                        title={t('composer.shuffle')}
                      >
                        <Shuffle className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                  <p className="text-sm text-foreground">{previewText}</p>
                </div>
              )}
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

          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setTemplatePickerOpen(true)}>
              <Save className="size-3.5" />
              {t('templates.saveButton')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 pt-6">
          <h2 className="text-sm font-semibold text-foreground">{t('sectionSchedule')}</h2>

          <div className="space-y-2">
            <Label htmlFor="campaign-schedule">{t('schedule.startLabel')}</Label>
            <Input
              id="campaign-schedule"
              type="datetime-local"
              min={minScheduleValue()}
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('schedule.startHint')}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="campaign-delay">{t('schedule.delayLabel')}</Label>
              <Input
                id="campaign-delay"
                type="number"
                min={1}
                value={delaySeconds}
                onChange={(e) => setDelaySeconds(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('schedule.delayHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="campaign-jitter">{t('schedule.jitterLabel')}</Label>
              <Input
                id="campaign-jitter"
                type="number"
                min={0}
                max={90}
                value={delayJitterPct}
                onChange={(e) => setDelayJitterPct(e.target.value)}
              />
              {jitterRange && (
                <p className="text-xs text-muted-foreground">
                  {t('schedule.jitterHint', {
                    seconds: delayNum,
                    pct: jitterNum,
                    min: jitterRange.min,
                    max: jitterRange.max,
                  })}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Switch checked={windowEnabled} onCheckedChange={setWindowEnabled} />
              {t('schedule.windowToggle')}
            </label>

            {windowEnabled && (
              <div className="space-y-3">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="campaign-window-start">{t('schedule.windowStartLabel')}</Label>
                    <Input
                      id="campaign-window-start"
                      type="time"
                      value={windowStart}
                      onChange={(e) => setWindowStart(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="campaign-window-end">{t('schedule.windowEndLabel')}</Label>
                    <Input
                      id="campaign-window-end"
                      type="time"
                      value={windowEnd}
                      onChange={(e) => setWindowEnd(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{t('schedule.windowDaysLabel')}</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((day) => (
                      <Button
                        key={day}
                        type="button"
                        size="xs"
                        variant={windowDays.has(day) ? 'default' : 'outline'}
                        onClick={() => toggleWeekday(day)}
                      >
                        {WEEKDAY_LABELS[day]}
                      </Button>
                    ))}
                  </div>
                  {windowDays.size === 0 && (
                    <p className="text-xs text-red-400">{t('schedule.windowInvalid')}</p>
                  )}
                </div>
              </div>
            )}
          </div>
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

      <TemplateManagerDialog
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
        onPick={handlePickTemplate}
        draft={{ content_type: contentType, content_text: contentText, media_url: mediaUrl, filename }}
      />
    </div>
  );
}
