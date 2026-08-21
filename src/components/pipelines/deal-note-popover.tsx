"use client";

import { useState } from "react";
import { StickyNote } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useContactNotes } from "@/hooks/use-contact-notes";

interface DealNotePopoverProps {
  contactId: string | null;
}

/**
 * Quick "jot something down" surface for a Kanban card — deliberately not a
 * replacement for the full notes tab in ContactDetailView or the inbox
 * sidebar (both stay the place to see the full history / delete notes).
 * Shares the same `contact_notes` rows via `useContactNotes`, so a note
 * added here shows up in both of those too.
 */
export function DealNotePopover({ contactId }: DealNotePopoverProps) {
  const t = useTranslations("Pipelines.notePopover");
  const tCard = useTranslations("Pipelines.card");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const { notes, addNote } = useContactNotes(open ? contactId : null);

  async function handleSave() {
    if (!text.trim()) return;
    setSaving(true);
    const { error } = await addNote(text);
    setSaving(false);
    if (error) {
      toast.error(t("toastFailed"));
      return;
    }
    setText("");
    toast.success(t("toastAdded"));
  }

  return (
    // Guards against the card's own click-to-edit handler and the
    // dnd-kit PointerSensor on the ancestor drag wrapper — both listen
    // via bubbling, so stopping propagation here (outside the trigger
    // itself) keeps the popover's internal open/close logic untouched.
    <div
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          disabled={!contactId}
          aria-label={tCard("addNote")}
          title={contactId ? tCard("addNote") : t("noContact")}
          className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <StickyNote className="h-3.5 w-3.5" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <PopoverTitle>{t("title")}</PopoverTitle>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("placeholder")}
            rows={3}
            className="resize-none text-sm"
          />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!text.trim() || saving}
            className="self-end"
          >
            {saving ? t("saving") : t("save")}
          </Button>

          <div className="mt-1 max-h-40 space-y-1.5 overflow-y-auto border-t border-border pt-2">
            {notes.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noNotesYet")}</p>
            ) : (
              notes.slice(0, 3).map((note) => (
                <p
                  key={note.id}
                  className="whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground"
                >
                  {note.note_text}
                </p>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
