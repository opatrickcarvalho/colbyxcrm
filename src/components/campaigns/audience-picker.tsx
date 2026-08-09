'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Filter, Loader2 } from 'lucide-react';

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

interface AudiencePickerProps {
  selection: AudienceSelection;
  onSelectionChange: (next: AudienceSelection) => void;
  saveAsName: string;
  onSaveAsNameChange: (name: string) => void;
}

/**
 * Three-tab recipient picker (saved contacts / WhatsApp groups / pasted
 * phone numbers) shared by the campaign composer. Contacts and tags are
 * read directly via the Supabase client — the same pattern the Contacts
 * page and TemplateManager already use for account-scoped tables covered
 * by RLS — while groups and saved audiences go through their existing/
 * contracted API routes.
 */
export function AudiencePicker({
  selection,
  onSelectionChange,
  saveAsName,
  onSaveAsNameChange,
}: AudiencePickerProps) {
  const t = useTranslations('GroupBroadcasts.new.audience');
  const supabase = createClient();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [contactSearch, setContactSearch] = useState('');
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagsByContact, setTagsByContact] = useState<Record<string, string[]>>({});

  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupFilter, setGroupFilter] = useState('');

  const [phoneText, setPhoneText] = useState(selection.phones.join('\n'));

  const [savedAudiences, setSavedAudiences] = useState<SavedAudienceOption[]>([]);
  const [savedAudiencesLoading, setSavedAudiencesLoading] = useState(true);
  const [pickedAudienceId, setPickedAudienceId] = useState<string | undefined>(undefined);
  const [audienceLoading, setAudienceLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadContacts() {
      const { data } = await supabase
        .from('contacts')
        .select('*')
        .order('name', { ascending: true })
        .limit(500);
      if (!cancelled) {
        setContacts(data ?? []);
        setContactsLoading(false);
      }
    }
    async function loadTags() {
      const { data } = await supabase.from('tags').select('*');
      if (!cancelled) setAllTags(data ?? []);
    }
    async function loadContactTags() {
      const { data } = await supabase.from('contact_tags').select('contact_id, tag_id');
      if (cancelled) return;
      const map: Record<string, string[]> = {};
      (data ?? []).forEach((row) => {
        if (!map[row.contact_id]) map[row.contact_id] = [];
        map[row.contact_id].push(row.tag_id);
      });
      setTagsByContact(map);
    }
    void loadContacts();
    void loadTags();
    void loadContactTags();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  }, []);

  const filteredContacts = useMemo(() => {
    const q = contactSearch.trim().toLowerCase();
    return contacts.filter((c) => {
      if (selectedTagIds.length > 0) {
        const tags = tagsByContact[c.id] ?? [];
        if (!selectedTagIds.some((id) => tags.includes(id))) return false;
      }
      if (!q) return true;
      return (
        (c.name ?? '').toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q)
      );
    });
  }, [contacts, contactSearch, selectedTagIds, tagsByContact]);

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
              onChange={(e) => setContactSearch(e.target.value)}
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
                      onClick={() => setSelectedTagIds([])}
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
          {contactsLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : filteredContacts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('noContactsFound')}
            </p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
              {filteredContacts.map((c) => (
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
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="audience-save-as">{t('saveAsLabel')}</Label>
        <Input
          id="audience-save-as"
          value={saveAsName}
          onChange={(e) => onSaveAsNameChange(e.target.value)}
          placeholder={t('saveAsPlaceholder')}
        />
      </div>
    </div>
  );
}
