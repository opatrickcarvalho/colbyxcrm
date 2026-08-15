'use client';

import { useState, useRef, useCallback, useEffect, KeyboardEvent } from 'react';
import dynamic from 'next/dynamic';
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  Square,
  X,
  Loader2,
  Sparkles,
  Plus,
  MessageSquareDashed,
  Zap,
  Clock,
  Smile,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { EmojiClickData } from 'emoji-picker-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';
import {
  clipboardImageName,
  isPasteableImage,
  shrinkImageToFit,
} from '@/lib/media/clipboard-image';
import { ReplyQuote } from './reply-quote';
import { useTranslations } from 'next-intl';
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from '@/components/interactive/interactive-builder';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import type { InteractiveMessagePayload, QuickReply } from '@/types';
import { QuickReplyPicker } from './quick-reply-picker';

// Client-only + code-split: the picker's emoji dataset is sizeable and
// irrelevant to first paint of the composer — load it lazily, only once
// the agent actually opens the picker.
const EmojiPicker = dynamic(() => import('emoji-picker-react'), {
  ssr: false,
});

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = 'image' | 'video' | 'document' | 'audio';

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = 'chat-media';

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder.
const PICKER_ACCEPT: Record<'image' | 'video' | 'document', string> = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/3gpp',
  document:
    'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain',
};

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  onSendInteractive: (
    payload: InteractiveMessagePayload,
    replyToId?: string
  ) => void;
  onOpenTemplates: () => void;
  /** Whether the connected provider supports pre-approved templates (Meta: yes, UAZAPI: no). */
  templatesEnabled?: boolean;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  /**
   * Fires the "typing…" / "recording audio…" indicator on the
   * recipient's end. Omitted entirely (not just a no-op) when the
   * connected provider doesn't support it (Meta) — the parent gates
   * this on `capabilities.presence` so the composer never has to know
   * which provider it's talking to.
   */
  onPresence?: (presence: 'composing' | 'recording' | 'paused') => void;
}

/** How long to wait after the last keystroke before clearing the
 *  "typing…" indicator. Short enough to feel honest (it disappears
 *  when the agent actually stops), long enough that normal typing
 *  pauses don't flicker it on/off. */
const TYPING_IDLE_MS = 3000;

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Local `datetime-local` floor (now + 1 min) so the picker can't be
 *  used to "schedule" something that's already due. */
function minScheduleValue(): string {
  const d = new Date(Date.now() + 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What's being scheduled — either the current text draft or the
 *  currently staged media attachment. Captured at "Agendar" click time
 *  so the dialog doesn't race further edits to the live composer state. */
type ScheduleTarget =
  | { kind: 'text'; text: string }
  | {
      kind: ComposerMediaKind;
      mediaUrl: string;
      filename: string;
      caption: string;
    };

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = '/opus/encoderWorker.min.js';

export function MessageComposer({
  conversationId,
  sessionExpired,
  onSend,
  onSendMedia,
  onSendInteractive,
  onOpenTemplates,
  templatesEnabled = true,
  replyTo,
  onClearReply,
  onPresence,
}: MessageComposerProps) {
  const t = useTranslations('Inbox.composer');

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ---- Per-conversation draft isolation -------------------------------
  // This component is NOT remounted when the agent switches conversations
  // (no `key` on <MessageComposer> in message-thread.tsx), so without
  // this, an unsent draft typed for one contact kept showing up when
  // switching to another. A Map survives across re-renders of this same
  // instance — exactly what's missing — keyed by conversationId, so
  // switching away saves the outgoing draft and switching to a
  // conversation with one restores it, and switching to a fresh one
  // shows empty. Deliberately in-memory only (not localStorage): this
  // fixes the leak-between-conversations bug without expanding into
  // persistence across page reloads, which nobody asked for.
  const draftCacheRef = useRef<Map<string, string>>(new Map());
  const prevConversationIdRef = useRef(conversationId);
  // Mirrors `text` so the conversation-switch effect below can read the
  // just-typed draft without adding `text` to its dependency array
  // (which would make it re-run — and re-save/re-load — on every
  // keystroke instead of only on an actual conversation switch). Same
  // ref-in-an-effect trick used throughout message-thread.tsx.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  });
  useEffect(() => {
    const prevId = prevConversationIdRef.current;
    if (prevId !== conversationId) {
      draftCacheRef.current.set(prevId, textRef.current);
      setText(draftCacheRef.current.get(conversationId) ?? '');
      prevConversationIdRef.current = conversationId;
    }
  }, [conversationId]);
  // Composer root — lets the document-level paste handler tell "pasted
  // into the composer" from "pasted into some other field on the page".
  const rootRef = useRef<HTMLDivElement>(null);

  // Interactive-message builder dialog + quick-reply picker.
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [interactivePayload, setInteractivePayload] =
    useState<InteractiveMessagePayload>(blankButtonsPayload);
  const [savingQuickReply, setSavingQuickReply] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);

  // Schedule-send dialog. `scheduleTarget` is null when the dialog is
  // closed; set to a snapshot of the text draft or staged media when
  // the agent clicks "Agendar envio".
  const [scheduleTarget, setScheduleTarget] = useState<ScheduleTarget | null>(
    null
  );
  const [scheduleAt, setScheduleAt] = useState('');
  const [scheduling, setScheduling] = useState(false);

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object.
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  // Voice recording state. The recorder encodes Ogg/Opus in-browser
  // (opus-recorder) so there's no server-side transcode.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import('opus-recorder').default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Typing-indicator state. `isTypingRef` guards against re-firing
  // 'composing' on every keystroke — uazapi's own presence lasts up to
  // 5 minutes per call, so one call per burst is enough; the idle timer
  // below is what clears it after a real pause.
  const isTypingRef = useRef(false);
  const typingIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan('send-messages');
  const readOnly = !canSend;
  // Media (like free-form text) is only allowed inside the 24h window.
  const inputsDisabled = readOnly || sessionExpired;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic, and GC a staged-but-unsent
  // attachment so it doesn't orphan in the bucket.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      // stop() releases the mic stream + audio context inside opus-recorder.
      void recorderRef.current?.stop().catch(() => {});
      removeStaged(draftRef.current?.path);
      if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
    };
  }, [clearTimer, removeStaged]);

  // Fire 'composing' once per typing burst, then arm/re-arm the idle
  // timer that clears it after TYPING_IDLE_MS of no further keystrokes.
  const notifyComposing = useCallback(() => {
    if (!onPresence) return;
    if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      onPresence('composing');
    }
    typingIdleTimerRef.current = setTimeout(() => {
      isTypingRef.current = false;
      onPresence('paused');
    }, TYPING_IDLE_MS);
  }, [onPresence]);

  // Clear the indicator immediately (no debounce) — used when the
  // agent deletes the whole draft or actually sends, rather than
  // waiting out the idle timer for something that's already resolved.
  const clearTyping = useCallback(() => {
    if (typingIdleTimerRef.current) {
      clearTimeout(typingIdleTimerRef.current);
      typingIdleTimerRef.current = null;
    }
    if (isTypingRef.current) {
      isTypingRef.current = false;
      onPresence?.('paused');
    }
  }, [onPresence]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || sessionExpired) return;

    // Clear the indicator (if it was showing) right as the send fires,
    // rather than waiting out the idle timer — and reset the local
    // typing flag so the next burst fires a fresh 'composing'. uazapi
    // also auto-cancels presence once the actual send lands, so this
    // is belt-and-braces for the gap between click and delivery.
    clearTyping();

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText('');
      draftCacheRef.current.delete(conversationId);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionExpired, onSend, replyTo?.id, clearTyping]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // ---- Schedule send ---------------------------------------------------

  const openScheduleForText = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      toast.error(t('scheduleNothingToSend'));
      return;
    }
    setScheduleAt('');
    setScheduleTarget({ kind: 'text', text: trimmed });
  }, [text, t]);

  const openScheduleForDraft = useCallback(() => {
    if (!draft) return;
    setScheduleAt('');
    setScheduleTarget({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      filename: draft.filename,
      caption: draft.caption,
    });
  }, [draft]);

  const closeScheduleDialog = useCallback(() => {
    setScheduleTarget(null);
    setScheduleAt('');
  }, []);

  const confirmSchedule = useCallback(async () => {
    if (!scheduleTarget || !scheduleAt || scheduling) return;

    const scheduledDate = new Date(scheduleAt);
    if (
      Number.isNaN(scheduledDate.getTime()) ||
      scheduledDate.getTime() <= Date.now()
    ) {
      toast.error(t('scheduleInvalidDate'));
      return;
    }

    setScheduling(true);
    try {
      const body =
        scheduleTarget.kind === 'text'
          ? {
              conversation_id: conversationId,
              message_type: 'text',
              content_text: scheduleTarget.text,
              scheduled_at: scheduledDate.toISOString(),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }
          : {
              conversation_id: conversationId,
              message_type: scheduleTarget.kind,
              content_text:
                scheduleTarget.kind === 'audio'
                  ? undefined
                  : scheduleTarget.caption.trim() || undefined,
              media_url: scheduleTarget.mediaUrl,
              filename:
                scheduleTarget.kind === 'document'
                  ? scheduleTarget.filename
                  : undefined,
              scheduled_at: scheduledDate.toISOString(),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            };

      const res = await fetch('/api/whatsapp/scheduled-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('scheduleError'));
        return;
      }

      toast.success(t('scheduleSuccess'));
      if (scheduleTarget.kind === 'text') {
        clearTyping();
        setText('');
        draftCacheRef.current.delete(conversationId);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
      } else {
        // The staged object is now owned by the scheduled row — clear
        // without GC-ing it (mirrors sendDraft's handoff).
        setDraft(null);
      }
      onClearReply?.();
      closeScheduleDialog();
    } catch {
      toast.error(t('scheduleError'));
    } finally {
      setScheduling(false);
    }
  }, [
    scheduleTarget,
    scheduleAt,
    scheduling,
    conversationId,
    t,
    clearTyping,
    onClearReply,
    closeScheduleDialog,
  ]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setText(value);
      adjustHeight();
      if (value.trim()) {
        notifyComposing();
      } else {
        // Draft cleared back to empty — clear right away instead of
        // waiting out the idle timer for a burst that's already over.
        clearTyping();
      }
    },
    [adjustHeight, notifyComposing, clearTyping]
  );

  // Insert at the caret (not just appended) so picking an emoji
  // mid-sentence lands where the agent was actually typing — matches
  // WhatsApp's own picker behaviour. Popover stays open afterwards so
  // multiple emoji can be picked in a row without reopening it.
  const handleEmojiClick = useCallback(
    (emojiData: EmojiClickData) => {
      const el = textareaRef.current;
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? text.length;
      const next = text.slice(0, start) + emojiData.emoji + text.slice(end);
      setText(next);
      adjustHeight();
      notifyComposing();
      const caret = start + emojiData.emoji.length;
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(caret, caret);
      });
    },
    [text, adjustHeight, notifyComposing]
  );

  // Ask the AI assistant for a suggested reply and drop it into the
  // composer for the agent to edit + send. Read-only server-side —
  // nothing is sent until the agent hits Send.
  const handleDraft = useCallback(async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const res = await fetch('/api/ai/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === 'ai_not_configured') {
          toast.error(
            "AI isn't set up yet — enable it in Settings → AI Assistant."
          );
        } else {
          toast.error(data.error ?? "Couldn't draft a reply.");
        }
        return;
      }
      const draftText = typeof data.draft === 'string' ? data.draft.trim() : '';
      if (!draftText) {
        toast.error("The assistant didn't return a reply.");
        return;
      }
      setText(draftText);
      // Let the textarea grow to fit and drop the cursor at the end so
      // the agent can tweak immediately.
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch {
      toast.error("Couldn't reach the AI assistant.");
    } finally {
      setDrafting(false);
    }
  }, [drafting, conversationId, adjustHeight]);

  // ---- Interactive message + quick replies --------------------------

  const openInteractiveBuilder = useCallback(
    (seed?: InteractiveMessagePayload) => {
      setInteractivePayload(seed ?? blankButtonsPayload());
      setInteractiveOpen(true);
    },
    []
  );

  const sendInteractive = useCallback(() => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onSendInteractive(interactivePayload, replyTo?.id);
    setInteractiveOpen(false);
    onClearReply?.();
  }, [interactivePayload, onSendInteractive, replyTo?.id, onClearReply]);

  // Persist the current builder payload as a reusable interactive snippet.
  const saveAsQuickReply = useCallback(async () => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const title = window.prompt(t('quickReplyNamePrompt'))?.trim();
    if (!title) return;
    setSavingQuickReply(true);
    try {
      const res = await fetch('/api/quick-replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          kind: 'interactive',
          interactive_payload: interactivePayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('quickReplySaveError'));
        return;
      }
      toast.success(t('quickReplySaved'));
    } catch {
      toast.error(t('quickReplySaveError'));
    } finally {
      setSavingQuickReply(false);
    }
  }, [interactivePayload, t]);

  // A picked quick reply: text fills the composer; interactive opens the
  // builder pre-filled so the agent can tweak before sending.
  const handlePickQuickReply = useCallback(
    (qr: QuickReply) => {
      setQuickReplyOpen(false);
      if (qr.kind === 'interactive' && qr.interactive_payload) {
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      const body = qr.content_text ?? '';
      // Separate the snippet from any existing draft with a newline so the
      // words don't run together ("Thanks" + "we'll…" → "Thankswe'll…").
      setText((prev) =>
        prev && !/\s$/.test(prev) ? `${prev}\n${body}` : `${prev}${body}`
      );
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    },
    [openInteractiveBuilder, adjustHeight]
  );

  // Upload a captured file to chat-media and stage it as a draft.
  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, file: File) => {
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send.
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — ${kind} limit is ${Math.round(
            max / 1024 / 1024
          )} MB.`
        );
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(
          CHAT_MEDIA_BUCKET,
          file
        );
        // Replacing an existing draft? GC the previous object first.
        removeStaged(draftRef.current?.path);
        setDraft({
          kind,
          mediaUrl: publicUrl,
          path,
          filename: file.name,
          caption: '',
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Upload failed.');
      } finally {
        setBusy(false);
      }
    },
    [removeStaged]
  );

  const handlePicked = useCallback(
    (kind: 'image' | 'video' | 'document', file: File | undefined) => {
      if (file) void stageUpload(kind, file);
    },
    [stageUpload]
  );

  // ---- Paste a screenshot -------------------------------------------

  // Clipboard images arrive nameless ("image.png") and, for a full-screen
  // capture, usually over Meta's 5 MB image cap — rename + re-encode
  // before staging so a plain print-screen just works.
  const stagePastedImage = useCallback(
    async (file: File) => {
      setBusy(true);
      let fitted = file;
      try {
        fitted = await shrinkImageToFit(file, MEDIA_MAX_BYTES_BY_KIND.image);
      } catch {
        // Keep the original — stageUpload reports the size problem.
      } finally {
        setBusy(false);
      }
      await stageUpload(
        'image',
        new File([fitted], clipboardImageName(fitted.type), {
          type: fitted.type,
        })
      );
    },
    [stageUpload]
  );

  // Bound to the document rather than the textarea because the natural
  // gesture is "click the conversation, then Ctrl+V" — focus is often
  // nowhere in particular. Pastes aimed at another field (the search box,
  // an open dialog) are left alone.
  useEffect(() => {
    if (inputsDisabled || recording) return;

    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as Node | null;
      const root = rootRef.current;
      const inComposer = !!root && !!target && root.contains(target);
      const unfocused =
        target === document.body || target === document.documentElement;
      if (!inComposer && !unfocused) return;

      const file = Array.from(e.clipboardData?.files ?? []).find((f) =>
        f.type.startsWith('image/')
      );
      if (!file) return;

      // An image copied from a web page also carries its <img> markup as
      // text/html — without this the URL would land in the textarea too.
      e.preventDefault();

      if (!isPasteableImage(file.type)) {
        toast.error(t('pasteUnsupported'));
        return;
      }
      void stagePastedImage(file);
    };

    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [inputsDisabled, recording, stagePastedImage, t]);

  // ---- Voice recording (client-side Ogg/Opus, no server transcode) ---

  // The encoded Ogg/Opus file from opus-recorder → upload as an audio
  // draft. WhatsApp renders Ogg/Opus as a playable voice note.
  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File(
        [bytes as unknown as BlobPart],
        `voice-${Date.now()}.ogg`,
        {
          type: 'audio/ogg',
        }
      );
      if (file.size === 0) return; // cancelled / empty take
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error('Recording is too long (over 16 MB).');
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(
          CHAT_MEDIA_BUCKET,
          file
        );
        removeStaged(draftRef.current?.path);
        setDraft({
          kind: 'audio',
          mediaUrl: publicUrl,
          path,
          filename: file.name,
          caption: '',
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Upload failed.');
      } finally {
        setBusy(false);
      }
    },
    [removeStaged]
  );

  const startRecording = useCallback(async () => {
    if (inputsDisabled || busy || recording) return;
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === 'undefined'
    ) {
      toast.error("Voice recording isn't supported in this browser.");
      return;
    }
    try {
      // Lazy-load the encoder (≈400 KB worker) only when the user records,
      // keeping it out of the main bundle.
      const { default: Recorder } = await import('opus-recorder');
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the complete file on stop
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        void finalizeRecording(bytes);
      };
      recorderRef.current = recorder;
      await recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(
        () => setRecordSeconds((s) => s + 1),
        1000
      );
      // One call covers the whole take — uazapi's presence lasts up to
      // 5 minutes per call, which happens to match MAX_RECORDING_SECONDS
      // exactly, so there's no mid-recording renewal to manage.
      onPresence?.('recording');
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error('Microphone access denied or unavailable.');
    }
  }, [inputsDisabled, busy, recording, finalizeRecording, onPresence]);

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
    // The take moves to a caption/preview draft, not an immediate send
    // — the recipient shouldn't keep seeing "recording audio…" while
    // the agent is still reviewing it.
    onPresence?.('paused');
  }, [clearTimer, onPresence]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
    onPresence?.('paused');
  }, [clearTimer, onPresence]);

  // Auto-stop at the cap so a forgotten recording can't blow the
  // upload size limit.
  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  // ---- Draft send / discard -----------------------------------------

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    onSendMedia({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      path: draft.path,
      // Audio takes no caption (Meta rejects it). Everything else: the
      // trimmed caption, or undefined when blank.
      caption:
        draft.kind === 'audio' ? undefined : draft.caption.trim() || undefined,
      filename: draft.kind === 'document' ? draft.filename : undefined,
      replyToId: replyTo?.id,
    });
    // The object is now owned by the sent message — clear without GC.
    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  // ---- Render --------------------------------------------------------

  return (
    <div ref={rootRef} className="border-border bg-card border-t p-3">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {sessionExpired && templatesEnabled && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">{t('sessionExpiredHint')}</p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            {t('templates')}
          </Button>
        </div>
      )}

      {/* Hidden file inputs driven by the attach menu. */}
      <input
        ref={imageInputRef}
        type="file"
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          handlePicked('image', e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => {
          handlePicked('video', e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => {
          handlePicked('document', e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
          onSchedule={openScheduleForDraft}
          t={t}
        />
      ) : recording ? (
        // Recording bar — replaces the composer while the mic is live.
        <div className="border-border bg-muted flex items-center gap-3 rounded-xl border px-4 py-2.5">
          <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="text-foreground flex-1 text-sm">
            {t('recording', {
              current: formatDuration(recordSeconds),
              max: formatDuration(MAX_RECORDING_SECONDS),
            })}
          </span>
          <button
            type="button"
            onClick={cancelRecording}
            className="text-muted-foreground hover:bg-card hover:text-foreground rounded-md px-2 py-1 text-xs"
          >
            {t('cancel')}
          </button>
          <Button
            size="sm"
            onClick={stopRecording}
            className="bg-primary hover:bg-primary/90 h-9 w-9 shrink-0 p-0"
            title={t('stopAndAttach')}
          >
            <Square className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          {/* Attach menu — photo / video / document / voice. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled || busy}
              title={
                readOnly
                  ? t('readOnlyTitle')
                  : inputsDisabled
                    ? undefined
                    : t('attachMedia')
              }
              className="text-muted-foreground hover:text-foreground inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                <ImageIcon className="mr-2 h-4 w-4" />
                {t('photo')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                <Video className="mr-2 h-4 w-4" />
                {t('video')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => documentInputRef.current?.click()}
              >
                <FileText className="mr-2 h-4 w-4" />
                {t('document')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* + menu — interactive messages + quick replies. Gated on the
              24h window like free-form text (interactive requires it). */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled}
              title={
                readOnly
                  ? t('readOnlyTitle')
                  : inputsDisabled
                    ? undefined
                    : t('moreActions')
              }
              className="text-muted-foreground hover:text-foreground inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              <DropdownMenuItem onClick={() => openInteractiveBuilder()}>
                <MessageSquareDashed className="mr-2 h-4 w-4" />
                {t('interactiveMessage')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setQuickReplyOpen(true)}>
                <Zap className="mr-2 h-4 w-4" />
                {t('quickReplies')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {templatesEnabled && (
            <GatedButton
              variant="ghost"
              size="sm"
              canAct={!readOnly}
              gateReason="send messages"
              title={readOnly ? undefined : t('sendTemplate')}
              className="text-muted-foreground hover:text-foreground h-9 w-9 shrink-0 p-0"
              onClick={onOpenTemplates}
            >
              <LayoutTemplate className="h-4 w-4" />
            </GatedButton>
          )}

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            disabled={drafting}
            title={readOnly ? undefined : t('draftWithAI')}
            className="text-muted-foreground hover:text-primary h-9 w-9 shrink-0 p-0"
            onClick={handleDraft}
          >
            {drafting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
          </GatedButton>

          <Popover>
            <PopoverTrigger
              disabled={inputsDisabled}
              title={readOnly ? undefined : t('emojiPicker')}
              className="text-muted-foreground hover:text-foreground inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Smile className="h-4 w-4" />
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-auto border-none bg-transparent p-0 shadow-none ring-0"
            >
              <EmojiPicker onEmojiClick={handleEmojiClick} />
            </PopoverContent>
          </Popover>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              readOnly
                ? t('readOnlyPlaceholder')
                : sessionExpired
                  ? t('sessionExpiredPlaceholder')
                  : t('typeMessagePlaceholder')
            }
            disabled={sessionExpired || readOnly}
            rows={1}
            // Textarea keeps its own inline title — the GatedButton
            // wrapping pattern doesn't apply to non-button inputs.
            // The placeholder text also surfaces the read-only state.
            title={readOnly ? t('readOnlyTitle') : undefined}
            className={cn(
              'border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 flex-1 resize-none rounded-xl border px-4 py-2.5 text-sm transition-colors outline-none',
              (sessionExpired || readOnly) && 'cursor-not-allowed opacity-50'
            )}
          />

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            disabled={!text.trim() || sessionExpired}
            title={readOnly ? undefined : t('scheduleSend')}
            onClick={openScheduleForText}
            className="text-muted-foreground hover:text-foreground h-9 w-9 shrink-0 p-0 disabled:opacity-40"
          >
            <Clock className="h-4 w-4" />
          </GatedButton>

          {/* Voice note — its own button right next to Send, same slot
              WhatsApp itself uses, rather than buried in the attach menu. */}
          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            disabled={inputsDisabled || busy}
            title={readOnly ? undefined : t('voiceNote')}
            onClick={() => void startRecording()}
            className="text-muted-foreground hover:text-foreground h-9 w-9 shrink-0 p-0 disabled:opacity-40"
          >
            <Mic className="h-4 w-4" />
          </GatedButton>

          <GatedButton
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            disabled={!text.trim() || sessionExpired || sending}
            onClick={handleSend}
            className="bg-primary hover:bg-primary/90 h-9 w-9 shrink-0 p-0 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </GatedButton>
        </div>
      )}

      {/* Hint sits outside the flex row so its height doesn't push
          `items-end` buttons below the textarea. Indented to line up
          under the textarea left edge. */}
      {!draft && !recording && (
        <p className="text-muted-foreground mt-1 pl-[5.5rem] text-[10px]">
          {t('draftHint')} · {t('pasteHint')}
        </p>
      )}

      {/* Interactive-message builder dialog. */}
      <Dialog open={interactiveOpen} onOpenChange={setInteractiveOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('interactiveMessage')}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto">
            <InteractiveBuilder
              value={interactivePayload}
              onChange={setInteractivePayload}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingQuickReply}
              onClick={saveAsQuickReply}
            >
              {savingQuickReply ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-1 h-4 w-4" />
              )}
              {t('saveAsQuickReply')}
            </Button>
            <Button onClick={sendInteractive}>
              <Send className="mr-1 h-4 w-4" />
              {t('send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick-reply picker. */}
      <QuickReplyPicker
        open={quickReplyOpen}
        onOpenChange={setQuickReplyOpen}
        onPick={handlePickQuickReply}
      />

      {/* Schedule-send dialog — shared by the text row and the media
          draft preview, driven by `scheduleTarget`. */}
      <Dialog
        open={!!scheduleTarget}
        onOpenChange={(open) => {
          if (!open) closeScheduleDialog();
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('scheduleDialogTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">
            {t('scheduleDialogDescription')}
          </p>
          <div>
            <label className="text-muted-foreground mb-1 block text-xs">
              {t('scheduleDateLabel')}
            </label>
            <input
              type="datetime-local"
              value={scheduleAt}
              min={minScheduleValue()}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="border-border bg-muted text-foreground focus:border-primary/50 w-full rounded-lg border px-3 py-2 text-sm transition-colors outline-none"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeScheduleDialog}>
              {t('cancel')}
            </Button>
            <Button
              disabled={!scheduleAt || scheduling}
              onClick={confirmSchedule}
            >
              {scheduling ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Clock className="mr-1 h-4 w-4" />
              )}
              {t('scheduleConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
  onSchedule,
  t,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
  onSchedule: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="border-border bg-muted/40 rounded-xl border p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === 'image' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === 'video' && (
            <video
              src={draft.mediaUrl}
              controls
              className="max-h-40 rounded-lg"
            />
          )}
          {draft.kind === 'audio' && (
            <audio src={draft.mediaUrl} controls className="w-full" />
          )}
          {draft.kind === 'document' && (
            <div className="text-foreground flex items-center gap-2 text-sm">
              <FileText className="text-muted-foreground h-5 w-5 shrink-0" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t('removeAttachment')}
          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded p-1"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        {draft.kind !== 'audio' && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) => onCaptionChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={t('addCaption')}
            className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 flex-1 rounded-xl border px-4 py-2.5 text-sm transition-colors outline-none"
          />
        )}
        <GatedButton
          variant="ghost"
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy}
          title={readOnly ? undefined : t('scheduleSend')}
          onClick={onSchedule}
          className={cn(
            'text-muted-foreground hover:text-foreground h-9 w-9 shrink-0 p-0 disabled:opacity-40',
            draft.kind === 'audio' && 'ml-auto'
          )}
        >
          <Clock className="h-4 w-4" />
        </GatedButton>
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy}
          onClick={onSend}
          className="bg-primary hover:bg-primary/90 h-9 w-9 shrink-0 p-0 disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
        </GatedButton>
      </div>
    </div>
  );
}
