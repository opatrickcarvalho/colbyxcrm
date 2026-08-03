'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  ArrowLeft,
  Copy,
  Loader2,
  RefreshCw,
  Shield,
  ShieldOff,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

interface LiveParticipant {
  jid: string;
  phone: string;
  displayName?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

interface LiveGroup {
  jid: string;
  name: string;
  description?: string;
  inviteLink?: string;
  isAnnounce: boolean;
  isLocked: boolean;
  participants: LiveParticipant[];
  participantCount: number;
}

interface LocalGroup {
  id: string;
  group_jid: string;
  name: string;
  description: string | null;
  invite_link: string | null;
  participant_count: number;
  max_participants: number | null;
  campaign_slug: string | null;
  is_announce: boolean;
  is_locked: boolean;
  status: 'active' | 'archived';
}

export default function GroupDetailPage() {
  const t = useTranslations('Groups.detail');
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const groupId = params.id;
  const canManage = useCan('send-messages');

  const [local, setLocal] = useState<LocalGroup | null>(null);
  const [live, setLive] = useState<LiveGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [campaignSlug, setCampaignSlug] = useState('');
  const [maxParticipants, setMaxParticipants] = useState('');
  const [announce, setAnnounce] = useState(false);
  const [locked, setLocked] = useState(false);
  const [saving, setSaving] = useState(false);

  const [addText, setAddText] = useState('');
  const [busyJid, setBusyJid] = useState<string | null>(null);
  const [addingParticipants, setAddingParticipants] = useState(false);
  const [resettingLink, setResettingLink] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}`, { cache: 'no-store' });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error);

      const g = data.data as LocalGroup;
      setLocal(g);
      setLive(data.live as LiveGroup | null);
      setName(g.name);
      setDescription(g.description ?? '');
      setCampaignSlug(g.campaign_slug ?? '');
      setMaxParticipants(g.max_participants ? String(g.max_participants) : '');
      setAnnounce(g.is_announce);
      setLocked(g.is_locked);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRefresh() {
    setRefreshing(true);
    await load();
  }

  async function handleSave() {
    if (!local) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() !== local.name ? name.trim() : undefined,
          description: description !== (local.description ?? '') ? description : undefined,
          is_announce: announce !== local.is_announce ? announce : undefined,
          is_locked: locked !== local.is_locked ? locked : undefined,
          campaign_slug: campaignSlug.trim() || null,
          max_participants: maxParticipants ? Number(maxParticipants) : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveError'));
        return;
      }
      toast.success(t('saved'));
      setLocal(data.data);
    } catch {
      toast.error(t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleParticipantAction(
    action: 'add' | 'remove' | 'promote' | 'demote',
    participants: string[]
  ) {
    if (participants.length === 0) return;
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, participants }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('participantActionError'));
        return;
      }
      const failed = (data.results ?? []).filter((r: { error: number }) => r.error !== 0);
      if (failed.length > 0) {
        toast.error(t('participantActionError'));
      } else {
        toast.success(t('participantActionSuccess'));
      }
      await load();
    } catch {
      toast.error(t('participantActionError'));
    }
  }

  async function handleAddParticipants() {
    const participants = addText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (participants.length === 0) return;
    setAddingParticipants(true);
    try {
      await handleParticipantAction('add', participants);
      setAddText('');
    } finally {
      setAddingParticipants(false);
    }
  }

  async function handleSingleParticipantAction(
    action: 'remove' | 'promote' | 'demote',
    jid: string,
    phone: string
  ) {
    setBusyJid(jid);
    try {
      await handleParticipantAction(action, [phone || jid]);
    } finally {
      setBusyJid(null);
    }
  }

  async function handleResetLink() {
    if (!window.confirm(t('resetLinkConfirm'))) return;
    setResettingLink(true);
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}/invite-link`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('resetLinkError'));
        return;
      }
      toast.success(t('resetLinkSuccess'));
      setLocal((prev) => (prev ? { ...prev, invite_link: data.invite_link } : prev));
    } catch {
      toast.error(t('resetLinkError'));
    } finally {
      setResettingLink(false);
    }
  }

  async function handleCopyLink() {
    const link = local?.invite_link;
    if (!link) return;
    await navigator.clipboard.writeText(link);
    toast.success(t('linkCopied'));
  }

  async function handleLeave() {
    if (!window.confirm(t('leaveConfirm'))) return;
    setLeaving(true);
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('leaveError'));
        return;
      }
      toast.success(t('leaveSuccess'));
      router.push('/groups');
    } catch {
      toast.error(t('leaveError'));
    } finally {
      setLeaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (notFound || !local) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
        <Button variant="outline" onClick={() => router.push('/groups')}>
          {t('back')}
        </Button>
      </div>
    );
  }

  const participants = live?.participants ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => router.push('/groups')}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </button>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-4 w-4" />
          )}
          {t('refresh')}
        </Button>
      </div>

      <h1 className="text-2xl font-bold text-foreground">{local.name}</h1>

      {/* Settings */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-4 text-sm font-semibold text-foreground">{t('settings')}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="g-name">{t('nameLabel')}</Label>
            <Input id="g-name" value={name} maxLength={25} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="g-campaign">{t('campaignLabel')}</Label>
            <Input
              id="g-campaign"
              value={campaignSlug}
              onChange={(e) => setCampaignSlug(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="g-description">{t('descriptionLabel')}</Label>
            <Textarea
              id="g-description"
              value={description}
              maxLength={512}
              rows={2}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="g-max">{t('maxParticipantsLabel')}</Label>
            <Input
              id="g-max"
              type="number"
              min={1}
              value={maxParticipants}
              onChange={(e) => setMaxParticipants(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span className="text-sm text-foreground">{t('announceLabel')}</span>
            <Switch checked={announce} onCheckedChange={setAnnounce} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span className="text-sm text-foreground">{t('lockedLabel')}</span>
            <Switch checked={locked} onCheckedChange={setLocked} />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {local.invite_link && (
              <>
                <Button variant="outline" size="sm" onClick={handleCopyLink}>
                  <Copy className="mr-1 h-4 w-4" />
                  {t('copyLink')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleResetLink}
                  disabled={resettingLink || !canManage}
                >
                  {resettingLink ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 h-4 w-4" />
                  )}
                  {t('resetLink')}
                </Button>
              </>
            )}
          </div>
          <GatedButton canAct={canManage} gateReason="send messages" disabled={saving} onClick={handleSave}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {saving ? t('saving') : t('save')}
          </GatedButton>
        </div>
      </div>

      {/* Participants */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-4 text-sm font-semibold text-foreground">
          {t('participants', { count: live?.participantCount ?? local.participant_count })}
        </h2>

        {!live && (
          <p className="mb-4 text-xs text-muted-foreground">{t('unavailable')}</p>
        )}

        {canManage && (
          <div className="mb-4 flex items-end gap-2">
            <div className="flex-1">
              <Label htmlFor="add-participants">{t('addParticipants')}</Label>
              <Textarea
                id="add-participants"
                value={addText}
                onChange={(e) => setAddText(e.target.value)}
                placeholder={t('addPlaceholder')}
                rows={2}
              />
            </div>
            <Button onClick={handleAddParticipants} disabled={addingParticipants || !addText.trim()}>
              {addingParticipants ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="mr-1 h-4 w-4" />
              )}
              {t('add')}
            </Button>
          </div>
        )}

        {participants.length > 0 && (
          <ul className="divide-y divide-border">
            {participants.map((p) => (
              <li key={p.jid} className="flex items-center justify-between py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">
                    {p.displayName || p.phone || p.jid}
                  </p>
                  {(p.isAdmin || p.isSuperAdmin) && (
                    <span className="text-xs text-primary">
                      {p.isSuperAdmin ? t('superAdmin') : t('admin')}
                    </span>
                  )}
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyJid === p.jid}
                      onClick={() =>
                        handleSingleParticipantAction(
                          p.isAdmin ? 'demote' : 'promote',
                          p.jid,
                          p.phone
                        )
                      }
                      title={p.isAdmin ? t('demote') : t('promote')}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                    >
                      {p.isAdmin ? (
                        <ShieldOff className="h-4 w-4" />
                      ) : (
                        <Shield className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyJid === p.jid}
                      onClick={() => handleSingleParticipantAction('remove', p.jid, p.phone)}
                      title={t('remove')}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-red-400"
                    >
                      <UserMinus className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canManage && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            className="text-red-400 hover:bg-red-500/10 hover:text-red-400"
            disabled={leaving}
            onClick={handleLeave}
          >
            {leaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {t('leaveGroup')}
          </Button>
        </div>
      )}
    </div>
  );
}
