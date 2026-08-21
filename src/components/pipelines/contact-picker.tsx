"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ContactAvatar } from "@/components/inbox/contact-avatar";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Contact } from "@/types";

interface ContactPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (contact: Contact) => void;
  onSkip: () => void;
}

/**
 * Replaces the alphabetical `<select>` in `DealForm`'s create path with a
 * searchable, avatar-led contact list — the "start from who you're already
 * talking to" flow instead of "type a title, then hunt a name in a dropdown".
 */
export function ContactPicker({
  open,
  onOpenChange,
  onSelect,
  onSkip,
}: ContactPickerProps) {
  const t = useTranslations("Pipelines.contactPicker");
  const supabase = createClient();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data } = await supabase.from("contacts").select("*").order("name");
      if (cancelled) return;
      setContacts((data ?? []) as Contact[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) => c.name?.toLowerCase().includes(q) || c.phone.includes(q),
    );
  }, [contacts, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[70vh] flex-col gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-8"
          />
        </div>

        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t("loading")}
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t("noResults")}
            </p>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(c)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted"
              >
                <ContactAvatar
                  avatarUrl={c.avatar_url}
                  name={c.name || c.phone}
                  wrapperClassName="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground overflow-hidden"
                  imgClassName="h-9 w-9 rounded-full object-cover"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {c.name || c.phone}
                  </p>
                  {c.name && (
                    <p className="truncate text-xs text-muted-foreground">
                      {c.phone}
                    </p>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        <button
          type="button"
          onClick={onSkip}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("createBlank")}
        </button>
      </DialogContent>
    </Dialog>
  );
}
