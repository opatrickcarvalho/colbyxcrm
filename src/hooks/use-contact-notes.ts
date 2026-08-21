import { useState, useCallback, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { ContactNote } from "@/types";

export type ContactNoteError = "invalid" | "not_authenticated" | "db_error";

/**
 * Shared `contact_notes` fetch/add/delete, previously duplicated between
 * `contact-sidebar.tsx` and `contact-detail-view.tsx` (and now also used by
 * the Kanban card's quick-note popover). A note is always contact-scoped —
 * there is no per-deal or per-view note concept, so callers all read/write
 * the same rows on purpose.
 */
export function useContactNotes(contactId: string | null | undefined) {
  const supabase = createClient();
  const { accountId } = useAuth();
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!contactId) {
      setNotes([]);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from("contact_notes")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false });
    setNotes(data ?? []);
    setLoading(false);
  }, [contactId, supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  const addNote = useCallback(
    async (text: string): Promise<{ error: ContactNoteError | null }> => {
      const trimmed = text.trim();
      if (!contactId || !trimmed || !accountId) return { error: "invalid" };

      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return { error: "not_authenticated" };

      const { data, error } = await supabase
        .from("contact_notes")
        .insert({
          contact_id: contactId,
          account_id: accountId,
          user_id: user.id,
          note_text: trimmed,
        })
        .select()
        .single();

      if (error || !data) return { error: "db_error" };
      setNotes((prev) => [data, ...prev]);
      return { error: null };
    },
    [contactId, accountId, supabase],
  );

  const deleteNote = useCallback(
    async (noteId: string): Promise<{ error: ContactNoteError | null }> => {
      const { error } = await supabase
        .from("contact_notes")
        .delete()
        .eq("id", noteId);
      if (error) return { error: "db_error" };
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      return { error: null };
    },
    [supabase],
  );

  return { notes, loading, addNote, deleteNote, refresh };
}
