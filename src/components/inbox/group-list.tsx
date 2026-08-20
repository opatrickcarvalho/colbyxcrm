'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR, enUS } from 'date-fns/locale';
import { useTranslations, useLocale } from 'next-intl';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Users } from 'lucide-react';

export interface GroupListItem {
  id: string;
  name: string;
  participant_count: number;
  max_participants: number | null;
  campaign_slug: string | null;
  status: 'active' | 'archived';
  last_message_at: string | null;
  last_message_preview: string | null;
}

interface GroupListProps {
  activeGroupId: string | null;
  onSelect: (group: GroupListItem) => void;
  /** Bumped by the parent to force a refetch (same convention as
   *  ConversationList's resyncToken) — kept intentionally simple here
   *  since groups have no realtime channel yet. */
  resyncToken?: number;
}

export function GroupList({ activeGroupId, onSelect, resyncToken = 0 }: GroupListProps) {
  const t = useTranslations('Groups.page');
  const locale = useLocale();
  const dateFnsLocale = locale === 'pt-BR' ? ptBR : enUS;
  const [groups, setGroups] = useState<GroupListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/groups', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const rows: GroupListItem[] = (data.data ?? []).filter(
        (g: GroupListItem & { status: string }) => g.status === 'active'
      );
      rows.sort((a, b) => {
        const at = a.last_message_at ?? '';
        const bt = b.last_message_at ?? '';
        return bt.localeCompare(at);
      });
      setGroups(rows);
    } catch {
      // Best-effort — the tab shows an empty list rather than blocking
      // the inbox on a groups-fetch failure.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, resyncToken]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : groups.length === 0 ? (
        <div className="px-4 py-12 text-center">
          <p className="text-sm text-muted-foreground">{t('noGroupsYet')}</p>
        </div>
      ) : (
        <div className="flex flex-col">
          {groups.map((group) => (
            <button
              key={group.id}
              onClick={() => onSelect(group)}
              className={cn(
                'flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50',
                group.id === activeGroupId && 'border-l-2 border-primary bg-muted/70'
              )}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Users className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {group.name}
                  </span>
                  {group.last_message_at && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(group.last_message_at), {
                        addSuffix: false,
                        locale: dateFnsLocale,
                      })}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <p className="truncate text-xs text-muted-foreground">
                    {group.last_message_preview || t('noGroupsYet')}
                  </p>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {group.max_participants
                      ? `${group.participant_count}/${group.max_participants}`
                      : group.participant_count}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}
