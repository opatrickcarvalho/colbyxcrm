'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
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
import { Users, Plus, Loader2 } from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

interface GroupRow {
  id: string;
  name: string;
  participant_count: number;
  max_participants: number | null;
  campaign_slug: string | null;
  status: 'active' | 'archived';
  created_at: string;
}

function CapacityCell({ count, max }: { count: number; max: number | null }) {
  if (!max) {
    return <span className="text-sm tabular-nums text-muted-foreground">{count}</span>;
  }
  const pct = Math.min(100, Math.round((count / max) * 100));
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
        {count}/{max}
      </span>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <div className="h-1.5 rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function GroupsPage() {
  const t = useTranslations('Groups.page');
  const tStatus = useTranslations('Groups.status');
  const router = useRouter();
  const canManage = useCan('send-messages');

  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [participantsText, setParticipantsText] = useState('');
  const [campaignSlug, setCampaignSlug] = useState('');
  const [maxParticipants, setMaxParticipants] = useState('');
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const res = await fetch('/api/whatsapp/groups', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t('errorLoad'));
      setGroups(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorLoad'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetCreateForm() {
    setName('');
    setParticipantsText('');
    setCampaignSlug('');
    setMaxParticipants('');
  }

  async function handleCreate() {
    const trimmedName = name.trim();
    const participants = participantsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (!trimmedName) {
      toast.error(t('create.nameRequired'));
      return;
    }
    if (participants.length === 0) {
      toast.error(t('create.participantsRequired'));
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('/api/whatsapp/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          participants,
          campaign_slug: campaignSlug.trim() || undefined,
          max_participants: maxParticipants ? Number(maxParticipants) : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('create.error'));
        return;
      }
      toast.success(t('create.success'));
      setDialogOpen(false);
      resetCreateForm();
      setGroups((prev) => [data.data, ...prev]);
    } catch {
      toast.error(t('create.error'));
    } finally {
      setCreating(false);
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <GatedButton
          canAct={canManage}
          gateReason="send messages"
          onClick={() => setDialogOpen(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t('newGroup')}
        </GatedButton>
      </div>

      {groups.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Users className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('noGroupsYet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('createFirst')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('table.name')}</TableHead>
                <TableHead className="text-muted-foreground">{t('table.participants')}</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">
                  {t('table.campaign')}
                </TableHead>
                <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">
                  {t('table.created')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <TableRow
                  key={group.id}
                  className="cursor-pointer border-border hover:bg-muted/50"
                  onClick={() => router.push(`/groups/${group.id}`)}
                >
                  <TableCell className="font-medium text-foreground">{group.name}</TableCell>
                  <TableCell>
                    <CapacityCell
                      count={group.participant_count}
                      max={group.max_participants}
                    />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {group.campaign_slug || '—'}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
                        group.status === 'active'
                          ? 'border-green-500/30 bg-green-500/10 text-green-400'
                          : 'border-border bg-muted text-muted-foreground'
                      }`}
                    >
                      {tStatus(group.status)}
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {new Date(group.created_at).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) resetCreateForm();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('create.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="group-name">{t('create.nameLabel')}</Label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('create.namePlaceholder')}
                maxLength={25}
              />
            </div>
            <div>
              <Label htmlFor="group-participants">{t('create.participantsLabel')}</Label>
              <Textarea
                id="group-participants"
                value={participantsText}
                onChange={(e) => setParticipantsText(e.target.value)}
                placeholder={'5521987654321\n5511912345678'}
                rows={4}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('create.participantsHint')}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="group-campaign">{t('create.campaignLabel')}</Label>
                <Input
                  id="group-campaign"
                  value={campaignSlug}
                  onChange={(e) => setCampaignSlug(e.target.value)}
                  placeholder={t('create.campaignPlaceholder')}
                />
              </div>
              <div>
                <Label htmlFor="group-max">{t('create.maxParticipantsLabel')}</Label>
                <Input
                  id="group-max"
                  type="number"
                  min={1}
                  value={maxParticipants}
                  onChange={(e) => setMaxParticipants(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={creating}>
              {t('create.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1 h-4 w-4" />
              )}
              {creating ? t('create.creating') : t('create.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
