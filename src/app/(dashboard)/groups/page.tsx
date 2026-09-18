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
import {
  Users,
  Plus,
  Loader2,
  RefreshCw,
  Search,
  AlertTriangle,
} from 'lucide-react';
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
  /** Null = never auto-cloned (manual/imported group), so not applicable.
   *  Empty array = auto-cloned and verified clean. Non-empty = still has
   *  pending setup issues after retries — see whatsapp-group-pool.ts. */
  setup_issues: string[] | null;
}

interface AvailableGroup {
  jid: string;
  name: string;
  participantCount: number;
  localId: string | null;
  status: 'active' | 'archived' | null;
}

function CapacityCell({ count, max }: { count: number; max: number | null }) {
  if (!max) {
    return (
      <span className="text-muted-foreground text-sm tabular-nums">
        {count}
      </span>
    );
  }
  const pct = Math.min(100, Math.round((count / max) * 100));
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-16 text-right text-xs tabular-nums">
        {count}/{max}
      </span>
      <div className="bg-muted h-1.5 w-20 overflow-hidden rounded-full">
        <div
          className="bg-primary h-1.5 rounded-full"
          style={{ width: `${pct}%` }}
        />
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

  // "Sync from WhatsApp" — pick which of the number's existing groups
  // (created on the phone, never through this CRM) should show up in
  // the Groups tab. Fetched lazily, only when the dialog opens.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [availableGroups, setAvailableGroups] = useState<AvailableGroup[]>([]);
  const [pickerSearch, setPickerSearch] = useState('');
  const [busyJid, setBusyJid] = useState<string | null>(null);

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
          max_participants: maxParticipants
            ? Number(maxParticipants)
            : undefined,
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

  async function loadAvailableGroups() {
    setPickerLoading(true);
    setPickerError(null);
    try {
      const res = await fetch('/api/whatsapp/groups/available', {
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t('picker.errorLoad'));
      setAvailableGroups(data.data ?? []);
    } catch (err) {
      setPickerError(
        err instanceof Error ? err.message : t('picker.errorLoad')
      );
    } finally {
      setPickerLoading(false);
    }
  }

  function openPicker() {
    setPickerOpen(true);
    void loadAvailableGroups();
  }

  /** Merges an add/re-add response into both the picker list and the
   *  main table, so the agent sees it land without a full page reload. */
  function upsertGroupRow(row: GroupRow) {
    setGroups((prev) => {
      const exists = prev.some((g) => g.id === row.id);
      return exists
        ? prev.map((g) => (g.id === row.id ? row : g))
        : [row, ...prev];
    });
  }

  async function handleAddExisting(group: AvailableGroup) {
    setBusyJid(group.jid);
    try {
      const res = await fetch('/api/whatsapp/groups/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_jid: group.jid }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('picker.addError'));
        return;
      }
      const row = data.data as GroupRow;
      setAvailableGroups((prev) =>
        prev.map((g) =>
          g.jid === group.jid ? { ...g, status: 'active', localId: row.id } : g
        )
      );
      upsertGroupRow(row);
      toast.success(t('picker.addSuccess'));
    } catch {
      toast.error(t('picker.addError'));
    } finally {
      setBusyJid(null);
    }
  }

  async function handleHideGroup(group: AvailableGroup) {
    if (!group.localId) return;
    setBusyJid(group.jid);
    try {
      const res = await fetch(`/api/whatsapp/groups/${group.localId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('picker.hideError'));
        return;
      }
      const row = data.data as GroupRow;
      setAvailableGroups((prev) =>
        prev.map((g) =>
          g.jid === group.jid ? { ...g, status: 'archived' } : g
        )
      );
      upsertGroupRow(row);
      toast.success(t('picker.hideSuccess'));
    } catch {
      toast.error(t('picker.hideError'));
    } finally {
      setBusyJid(null);
    }
  }

  const filteredAvailableGroups = availableGroups.filter((g) =>
    g.name.toLowerCase().includes(pickerSearch.trim().toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
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
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <GatedButton
            canAct={canManage}
            gateReason="send messages"
            variant="outline"
            onClick={openPicker}
          >
            <RefreshCw className="h-4 w-4" />
            {t('pickExisting')}
          </GatedButton>
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
      </div>

      {groups.length === 0 ? (
        <div className="border-border bg-card flex h-64 flex-col items-center justify-center rounded-xl border">
          <Users className="text-muted-foreground mb-3 h-10 w-10" />
          <p className="text-foreground text-sm font-medium">
            {t('noGroupsYet')}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t('createFirst')}
          </p>
        </div>
      ) : (
        <div className="border-border bg-card overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">
                  {t('table.name')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('table.participants')}
                </TableHead>
                <TableHead className="text-muted-foreground hidden sm:table-cell">
                  {t('table.campaign')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('table.status')}
                </TableHead>
                <TableHead className="text-muted-foreground hidden sm:table-cell">
                  {t('table.created')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <TableRow
                  key={group.id}
                  className="border-border hover:bg-muted/50 cursor-pointer"
                  onClick={() => router.push(`/groups/${group.id}`)}
                >
                  <TableCell className="text-foreground font-medium">
                    <span className="flex items-center gap-1.5">
                      {group.name}
                      {group.setup_issues && group.setup_issues.length > 0 && (
                        <span
                          title={group.setup_issues.join(' ')}
                          aria-label={t('setupIssuesBadge')}
                        >
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <CapacityCell
                      count={group.participant_count}
                      max={group.max_participants}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden sm:table-cell">
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
                  <TableCell className="text-muted-foreground hidden sm:table-cell">
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
              <Label htmlFor="group-participants">
                {t('create.participantsLabel')}
              </Label>
              <Textarea
                id="group-participants"
                value={participantsText}
                onChange={(e) => setParticipantsText(e.target.value)}
                placeholder={'5521987654321\n5511912345678'}
                rows={4}
              />
              <p className="text-muted-foreground mt-1 text-xs">
                {t('create.participantsHint')}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="group-campaign">
                  {t('create.campaignLabel')}
                </Label>
                <Input
                  id="group-campaign"
                  value={campaignSlug}
                  onChange={(e) => setCampaignSlug(e.target.value)}
                  placeholder={t('create.campaignPlaceholder')}
                />
              </div>
              <div>
                <Label htmlFor="group-max">
                  {t('create.maxParticipantsLabel')}
                </Label>
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
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={creating}
            >
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

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('picker.title')}</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">
            {t('picker.subtitle')}
          </p>
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
            <Input
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
              placeholder={t('picker.searchPlaceholder')}
              className="pl-8"
            />
          </div>
          <div className="border-border max-h-80 overflow-y-auto rounded-lg border">
            {pickerLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="text-primary h-5 w-5 animate-spin" />
              </div>
            ) : pickerError ? (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <p className="text-sm text-red-400">{pickerError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadAvailableGroups()}
                >
                  {t('retry')}
                </Button>
              </div>
            ) : filteredAvailableGroups.length === 0 ? (
              <p className="text-muted-foreground p-6 text-center text-sm">
                {availableGroups.length === 0
                  ? t('noGroupsYet')
                  : t('picker.noResults')}
              </p>
            ) : (
              <ul className="divide-border divide-y">
                {filteredAvailableGroups.map((g) => (
                  <li
                    key={g.jid}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-foreground truncate text-sm font-medium">
                        {g.name}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {t('picker.participants', {
                          count: g.participantCount,
                        })}
                      </p>
                    </div>
                    {g.status === 'active' ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xs font-medium text-green-500">
                          {t('picker.added')}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyJid === g.jid}
                          onClick={() => void handleHideGroup(g)}
                        >
                          {busyJid === g.jid ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            t('picker.hide')
                          )}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        className="shrink-0"
                        disabled={busyJid === g.jid}
                        onClick={() => void handleAddExisting(g)}
                      >
                        {busyJid === g.jid ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : g.status === 'archived' ? (
                          t('picker.reactivate')
                        ) : (
                          t('picker.add')
                        )}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPickerOpen(false)}>
              {t('picker.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
