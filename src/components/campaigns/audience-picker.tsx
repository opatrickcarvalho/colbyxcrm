'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Filter, Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Contact, Tag } from '@/types';

/**
 * The three recipient kinds a campaign target (and an audience member) can
 * be, mirroring the XOR shape enforced by migration 052 —
 * `whatsapp_group_broadcast_targets_one_recipient` /
 * `campaign_audience_members_one_recipient`. Phones are kept normalised
 * (digits only) here so the "unique recipients" count and the submit
 * payload never have to re-derive it.
 */
export interface AudienceSelection {
  contactIds: string[];
  groupIds: string[];
  phones: string[];
}

export const EMPTY_AUDIENCE_SELECTION: AudienceSelection = {
  contactIds: [],
  groupIds: [],
  phones: [],
};

interface GroupOption {
  id: string;
  name: string;
  campaign_slug: string | null;
  status: 'active' | 'archived';
}

interface SavedAudienceOption {
  id: string;
  name: string;
}

interface AudienceMember {
  contact_id: string | null;
  group_id: string | null;
  phone: string | null;
}

/** Digits-only, matching how the backend normalises hand-typed numbers before insert (052). */
function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

const CONTACTS_PAGE_SIZE = 30;
// Safety cap on "select all matching" — bounds one click against an
// account with an enormous, unfiltered contact list rather than pulling
// every id into the browser at once.
const SELECT_ALL_CAP = 5000;

interface AudiencePickerProps {
  selection: AudienceSelection;
  onSelectionChange: (next: AudienceSelection) => void;
  /**
   * Composer-only affordances. The audiences manager edits one audience
   * directly, so for it "load another saved audience over this one" and
   * "save this selection as a new audience" are both nonsense — omit the
   * handler and neither control renders.
   */
  saveAsName?: string;
  onSaveAsNameChange?: (name: string) => void;
  showSavedAudiences?: boolean;
}

/**
 * Three-tab recipient picker (saved contacts / WhatsApp groups / pasted
 * phone numbers) shared by the campaign composer. Contacts are searched
 * and paginated server-side — the same query shape (and the same
 * `filter_contacts_by_tags` RPC for the tag filter, migration 025) the
 * Contacts page uses — because an account can have thousands of
 * contacts (e.g. from the inbox-extraction import) and a single
 * unbounded/capped client fetch either misses rows past the cap or
 * chokes rendering a checkbox per row. "Select all matching" re-runs the
 * same filter server-side with a much higher cap to add a whole result
 * set without paging through it by hand. Groups and saved audiences go
 * through their existing/contracted API routes.
 */
export function AudiencePicker({
  selection,
  onSelectionChange,
  saveAsName,
  onSaveAsNameChange,
  showSavedAudiences = true,
}: AudiencePickerProps) {
  const t = useTranslations('GroupBroadcasts.new.audience');
  const supabase = createClient();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [contactSearch, setContactSearch] = useState('');
  const [contactPage, setContactPage] = useState(0);
  const [totalContacts, setTotalContacts] = useState(0);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectingAll, setSelectingAll] = useState(false);
  // Guards against out-of-order fetch responses when search/tag/page
  // changes fire in quick succession — same pattern as the Contacts page.
  const contactFetchSeq = useRef(0);

  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupFilter, setGroupFilter] = useState('');

  const [phoneText, setPhoneText] = useState(selection.phones.join('\n'));

  const [savedAudiences, setSavedAudiences] = useState<SavedAudienceOption[]>([]);
  const [savedAudiencesLoading, setSavedAudiencesLoading] = useState(true);
  const [pickedAudienceId, setPickedAudienceId] = useState<string | undefined>(undefined);
  const [audienceLoading, setAudienceLoading] = useState(false);

  // Tags are used both by the tag-filter popover and the RPC below —
  // load once on mount.
  useEffect(() => {
    let cancelled = false;
    async function loadTags() {
      const { data } = await supabase.from('tags').select('*');
      if (!cancelled) setAllTags(data ?? []);
    }
    void loadTags();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchContacts = useCallback(async () => {
    const seq = ++contactFetchSeq.current;
    setContactsLoading(true);

    const from = contactPage * CONTACTS_PAGE_SIZE;
    const to = from + CONTACTS_PAGE_SIZE - 1;
    const term = contactSearch.trim();

    let rows: Contact[];
    let count: number;

    if (selectedTagIds.length > 0) {
      // Tag filter active — same server-side join/count/paginate RPC the
      // Contacts page uses (migration 025), so a tag covering hundreds
      // of contacts can't silently truncate the result.
      const { data, error } = await supabase.rpc('filter_contacts_by_tags', {
        p_tag_ids: selectedTagIds,
        p_search: term || null,
        p_limit: CONTACTS_PAGE_SIZE,
        p_offset: from,
      });
      if (seq !== contactFetchSeq.current) return;
      if (error) {
        toast.error(t('errorLoadContacts'));
        setContactsLoading(false);
        return;
      }
      const matched = (data ?? []) as { contact: Contact; total_count: number }[];
      rows = matched.map((r) => r.contact);
      count = matched.length > 0 ? Number(matched[0].total_count) : 0;
    } else {
      let query = supabase
        .from('contacts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);
      if (term) {
        const like = `%${term}%`;
        query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
      }
      const { data, count: exactCount, error } = await query;
      if (seq !== contactFetchSeq.current) return;
      if (error) {
        toast.error(t('errorLoadContacts'));
        setContactsLoading(false);
        return;
      }
      rows = data ?? [];
      count = exactCount ?? 0;
    }

    setContacts(rows);
    setTotalContacts(count);
    setContactsLoading(false);
  }, [supabase, contactPage, contactSearch, selectedTagIds, t]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  useEffect(() => {
    let cancelled = false;
    async function loadGroups() {
      const res = await fetch('/api/whatsapp/groups', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!cancelled) {
        setGroups((data.data ?? []).filter((g: GroupOption) => g.status === 'active'));
        setGroupsLoading(false);
      }
    }
    void loadGroups();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!showSavedAudiences) {
      setSavedAudiencesLoading(false);
      return;
    }
    let cancelled = false;
    async function loadAudiences() {
      try {
        const res = await fetch('/api/campaign-audiences', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) setSavedAudiences(data.audiences ?? []);
      } finally {
        if (!cancelled) setSavedAudiencesLoading(false);
      }
    }
    void loadAudiences();
    return () => {
      cancelled = true;
    };
  }, [showSavedAudiences]);

  const totalContactPages = Math.max(1, Math.ceil(totalContacts / CONTACTS_PAGE_SIZE));

  const filteredGroups = useMemo(() => {
    const q = groupFilter.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) => g.name.toLowerCase().includes(q) || (g.campaign_slug ?? '').toLowerCase().includes(q)
    );
  }, [groups, groupFilter]);

  const parsedPhones = useMemo(
    () =>
      Array.from(
        new Set(
          phoneText
            .split('\n')
            .map((line) => normalizePhone(line))
            .filter((p) => p.length >= 8)
        )
      ),
    [phoneText]
  );

  // Keeps the parent's `selection.phones` in sync with what the textarea
  // currently parses to, without fighting the user's cursor by rewriting
  // phoneText itself on every keystroke.
  useEffect(() => {
    const current = selection.phones;
    const same =
      current.length === parsedPhones.length && current.every((p, i) => p === parsedPhones[i]);
    if (!same) onSelectionChange({ ...selection, phones: parsedPhones });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedPhones]);

  const totalRecipients = useMemo(() => {
    const keys = new Set<string>();
    for (const id of selection.contactIds) keys.add(`c:${id}`);
    for (const id of selection.groupIds) keys.add(`g:${id}`);
    // A hand-typed number that matches a selected contact's phone is the
    // same human — don't double-count them.
    const contactPhones = new Set(
      contacts
        .filter((c) => selection.contactIds.includes(c.id))
        .map((c) => normalizePhone(c.phone))
    );
    for (const phone of selection.phones) {
      if (!contactPhones.has(phone)) keys.add(`p:${phone}`);
    }
    return keys.size;
  }, [selection, contacts]);

  function toggleContact(id: string, checked: boolean) {
    const next = new Set(selection.contactIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectionChange({ ...selection, contactIds: Array.from(next) });
  }

  function toggleGroup(id: string, checked: boolean) {
    const next = new Set(selection.groupIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectionChange({ ...selection, groupIds: Array.from(next) });
  }

  function toggleTagFilter(id: string) {
    setSelectedTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setContactPage(0);
  }

  function handleContactSearchChange(value: string) {
    setContactSearch(value);
    setContactPage(0);
  }

  /**
   * Re-runs the current search/tag filter server-side with a much
   * higher cap and adds every matching id to the selection — the escape
   * hatch for "everyone from this filter", since hand-checking a
   * multi-hundred-row paginated list isn't realistic (this is what the
   * inbox-extraction import needed: it can land far more contacts than
   * a single page shows).
   */
  async function selectAllMatching() {
    setSelectingAll(true);
    try {
      const term = contactSearch.trim();
      let ids: string[];

      if (selectedTagIds.length > 0) {
        const { data, error } = await supabase.rpc('filter_contacts_by_tags', {
          p_tag_ids: selectedTagIds,
          p_search: term || null,
          p_limit: SELECT_ALL_CAP,
          p_offset: 0,
        });
        if (error) {
          toast.error(t('errorLoadContacts'));
          return;
        }
        const matched = (data ?? []) as { contact: Contact }[];
        ids = matched.map((r) => r.contact.id);
      } else {
        let query = supabase
          .from('contacts')
          .select('id')
          .order('created_at', { ascending: false })
          .limit(SELECT_ALL_CAP);
        if (term) {
          const like = `%${term}%`;
          query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
        }
        const { data, error } = await query;
        if (error) {
          toast.error(t('errorLoadContacts'));
          return;
        }
        ids = (data ?? []).map((r) => r.id as string);
      }

      const next = new Set(selection.contactIds);
      let added = 0;
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          added++;
        }
      }
      onSelectionChange({ ...selection, contactIds: Array.from(next) });

      if (ids.length >= SELECT_ALL_CAP) {
        toast.warning(t('toastSelectAllCapped', { count: SELECT_ALL_CAP }));
      } else {
        toast.success(t('toastSelectAllAdded', { count: added }));
      }
    } finally {
      setSelectingAll(false);
    }
  }

  async function loadSavedAudience(audienceId: string) {
    setPickedAudienceId(audienceId);
    setAudienceLoading(true);
    try {
      const res = await fetch(`/api/campaign-audiences/${audienceId}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('loadAudienceError'));
        return;
      }
      const members: AudienceMember[] = data.audience?.members ?? [];
      const contactIds = members.filter((m) => m.contact_id).map((m) => m.contact_id as string);
      const groupIds = members.filter((m) => m.group_id).map((m) => m.group_id as string);
      const phones = members
        .filter((m) => m.phone)
        .map((m) => normalizePhone(m.phone as string));
      onSelectionChange({ contactIds, groupIds, phones });
      setPhoneText(phones.join('\n'));
    } catch {
      toast.error(t('loadAudienceError'));
    } finally {
      setAudienceLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Tabs defaultValue="contacts">
        <TabsList>
          <TabsTrigger value="contacts">{t('tabContacts')}</TabsTrigger>
          <TabsTrigger value="groups">{t('tabGroups')}</TabsTrigger>
          <TabsTrigger value="phones">{t('tabPhones')}</TabsTrigger>
        </TabsList>

        <TabsContent value="contacts" className="space-y-3 pt-3">
          <div className="flex gap-2">
            <Input
              value={contactSearch}
              onChange={(e) => handleContactSearchChange(e.target.value)}
              placeholder={t('searchContactsPlaceholder')}
              className="flex-1"
            />
            <Popover>
              <PopoverTrigger render={<Button variant="outline" className="shrink-0" />}>
                <Filter className="size-4" />
                {t('filterByTags')}
                {selectedTagIds.length > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-0">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="text-sm font-medium text-popover-foreground">
                    {t('filterByTags')}
                  </span>
                  {selectedTagIds.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTagIds([]);
                        setContactPage(0);
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      {t('clearAll')}
                    </button>
                  )}
                </div>
                {allTags.length === 0 ? (
                  <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                    {t('noTagsYet')}
                  </p>
                ) : (
                  <div className="max-h-64 overflow-y-auto py-1">
                    {allTags.map((tag) => (
                      <label
                        key={tag.id}
                        className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={selectedTagIds.includes(tag.id)}
                          onCheckedChange={() => toggleTagFilter(tag.id)}
                        />
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: tag.color }}
                        />
                        <span className="truncate text-sm text-popover-foreground">
                          {tag.name}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>
          {!contactsLoading && totalContacts > 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {t('showingContacts', {
                  start: contactPage * CONTACTS_PAGE_SIZE + 1,
                  end: Math.min((contactPage + 1) * CONTACTS_PAGE_SIZE, totalContacts),
                  total: totalContacts,
                })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={selectAllMatching}
                disabled={selectingAll}
                className="h-auto shrink-0 px-2 py-1 text-xs text-primary hover:text-primary"
              >
                {selectingAll && <Loader2 className="size-3 animate-spin" />}
                {t('selectAllMatching', { count: totalContacts })}
              </Button>
            </div>
          )}
          {contactsLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : contacts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('noContactsFound')}
            </p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
              {contacts.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <Checkbox
                    checked={selection.contactIds.includes(c.id)}
                    onCheckedChange={(checked) => toggleContact(c.id, checked === true)}
                  />
                  <span className="text-foreground">{c.name || c.phone}</span>
                  <span className="text-xs text-muted-foreground">{c.phone}</span>
                </label>
              ))}
            </div>
          )}
          {!contactsLoading && totalContactPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={contactPage === 0}
                onClick={() => setContactPage((p) => p - 1)}
                className="border-border text-muted-foreground disabled:opacity-30"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('pageCount', { page: contactPage + 1, total: totalContactPages })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={contactPage >= totalContactPages - 1}
                onClick={() => setContactPage((p) => p + 1)}
                className="border-border text-muted-foreground disabled:opacity-30"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="groups" className="space-y-3 pt-3">
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
            <p className="py-6 text-center text-sm text-muted-foreground">{t('noGroupsFound')}</p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
              {filteredGroups.map((g) => (
                <label
                  key={g.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <Checkbox
                    checked={selection.groupIds.includes(g.id)}
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
        </TabsContent>

        <TabsContent value="phones" className="space-y-2 pt-3">
          <Label htmlFor="audience-phones">{t('phonesLabel')}</Label>
          <Textarea
            id="audience-phones"
            rows={6}
            value={phoneText}
            onChange={(e) => setPhoneText(e.target.value)}
            placeholder={t('phonesPlaceholder')}
          />
          <p className="text-xs text-muted-foreground">
            {t('phonesHint', { count: parsedPhones.length })}
          </p>
        </TabsContent>
      </Tabs>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm font-medium text-foreground">
          {t('totalRecipients', { count: totalRecipients })}
        </span>
        {showSavedAudiences && (
        <div className="flex items-center gap-2">
          {audienceLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          <Select
            value={pickedAudienceId}
            onValueChange={(val) => {
              if (val) void loadSavedAudience(val);
            }}
          >
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue placeholder={t('loadAudiencePlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {savedAudiencesLoading ? (
                <SelectItem value="__loading" disabled>
                  {t('loadAudienceLoading')}
                </SelectItem>
              ) : savedAudiences.length === 0 ? (
                <SelectItem value="__empty" disabled>
                  {t('loadAudienceEmpty')}
                </SelectItem>
              ) : (
                savedAudiences.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
        )}
      </div>

      {onSaveAsNameChange && (
        <div className="space-y-1.5">
          <Label htmlFor="audience-save-as">{t('saveAsLabel')}</Label>
          <Input
            id="audience-save-as"
            value={saveAsName ?? ''}
            onChange={(e) => onSaveAsNameChange(e.target.value)}
            placeholder={t('saveAsPlaceholder')}
          />
        </div>
      )}
    </div>
  );
}
