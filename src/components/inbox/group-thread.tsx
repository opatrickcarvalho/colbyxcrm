'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  FileText,
  Image as ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  Send,
  Square,
  Video,
  X,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import {
  deleteAccountMedia,
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';
import { collectMediaGallery } from '@/lib/media/gallery';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MediaLightbox } from './media-lightbox';
import { GroupMessageBubble } from './group-message-bubble';

// Same Supabase Storage bucket the inbox composer uses (migration 023).
const CHAT_MEDIA_BUCKET = 'chat-media';
const PAGE_SIZE = 50;
const MAX_RECORDING_SECONDS = 5 * 60;
const OPUS_ENCODER_PATH = '/opus/encoderWorker.min.js';

const PICKER_ACCEPT: Record<'image' | 'video' | 'document', string> = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/3gpp',
  document:
    'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain',
};

export interface GroupMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  sender_jid: string | null;
  sender_phone: string | null;
  sender_name: string | null;
  content_type: 'text' | 'image' | 'document' | 'audio' | 'video';
  content_text: string | null;
  media_url: string | null;
  filename: string | null;
  /** uazapi's wamid — needed to send a "played" receipt for an inbound
   *  voice note (see mark-played below). Null on rows saved before this
   *  column started being populated. */
  provider_message_id?: string | null;
  created_at: string;
}

type MediaKind = 'image' | 'video' | 'document' | 'audio';

interface MediaDraft {
  kind: MediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

function formatRecordingTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Group activity feed — visibility + light moderation, deliberately not
 * a full attendance inbox (no assignment, no unread counts, no
 * automations/flows/AI auto-reply — see migration 043). What IS shared
 * with the 1:1 inbox on purpose: the same media players, the same
 * lightbox, realtime updates, pagination, and voice notes — so agents
 * aren't working two different-feeling chat UIs. What's still
 * deliberately absent: reply/quote and reactions (no columns for either
 * on `whatsapp_group_messages`; that's a schema decision, not a
 * rendering one).
 */
export function GroupThread({
  groupId,
  canManage,
}: {
  groupId: string;
  canManage: boolean;
}) {
  const t = useTranslations('Groups.detail');
  const tComposer = useTranslations('Inbox.composer');

  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const messagesRef = useRef<GroupMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const [composerText, setComposerText] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const [mediaMessageId, setMediaMessageId] = useState<string | null>(null);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollModeRef = useRef<'bottom' | 'preserve'>('bottom');
  const prevScrollHeightRef = useRef(0);

  // ---- Load + paginate -------------------------------------------------

  const loadMessages = useCallback(async () => {
    setMessagesLoading(true);
    try {
      const res = await fetch(
        `/api/whatsapp/groups/${groupId}/messages?limit=${PAGE_SIZE}`,
        { cache: 'no-store' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t('loadMessagesError'));
      const rows: GroupMessage[] = data.data ?? [];
      pendingScrollModeRef.current = 'bottom';
      setMessages(rows);
      setHasMoreOlder(rows.length >= PAGE_SIZE);
    } catch {
      toast.error(t('loadMessagesError'));
    } finally {
      setMessagesLoading(false);
    }
  }, [groupId, t]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  // Fetch the page just before what's loaded and prepend it, preserving
  // scroll position — same technique message-thread.tsx uses for the 1:1
  // inbox. Triggered by scrolling near the top (see onScroll below).
  const loadOlderMessages = useCallback(async () => {
    if (!hasMoreOlder || loadingOlder) return;
    const oldest = messagesRef.current[0];
    if (!oldest) return;

    setLoadingOlder(true);
    try {
      const res = await fetch(
        `/api/whatsapp/groups/${groupId}/messages?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest.created_at)}`,
        { cache: 'no-store' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const rows: GroupMessage[] = data.data ?? [];
      setHasMoreOlder(rows.length >= PAGE_SIZE);
      if (rows.length === 0) return;

      if (scrollRef.current) {
        prevScrollHeightRef.current = scrollRef.current.scrollHeight;
      }
      pendingScrollModeRef.current = 'preserve';
      setMessages((prev) => [...rows, ...prev]);
    } finally {
      setLoadingOlder(false);
    }
  }, [groupId, hasMoreOlder, loadingOlder]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < 100) void loadOlderMessages();
  }, [loadOlderMessages]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pendingScrollModeRef.current === 'preserve') {
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
    } else {
      el.scrollTop = el.scrollHeight;
    }
    pendingScrollModeRef.current = 'bottom';
  }, [messages]);

  // ---- Realtime ----------------------------------------------------
  // Its own channel per group (like the 1:1 thread's reactions channel)
  // rather than piped through the account-wide `useRealtime` hook — this
  // component is self-contained and shouldn't require its host page to
  // also wire up group events centrally.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`group-messages:${groupId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'whatsapp_group_messages',
          filter: `group_id=eq.${groupId}`,
        },
        (payload) => {
          const row = payload.new as GroupMessage;
          setMessages((prev) => {
            // An outbound send already appended itself optimistically
            // from the POST response — this dedupes that echo.
            if (prev.some((m) => m.id === row.id)) return prev;
            return [...prev, row];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [groupId]);

  // ---- Send ----------------------------------------------------------

  async function sendGroupMessage(payload: {
    content_type: 'text' | MediaKind;
    content_text?: string;
    media_url?: string;
    filename?: string;
  }) {
    const res = await fetch(`/api/whatsapp/groups/${groupId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? t('sendMessageError'));
      return false;
    }
    setMessages((prev) => [...prev, data.data]);
    return true;
  }

  async function handleSendText() {
    const text = composerText.trim();
    if (!text || sendingMessage) return;
    setSendingMessage(true);
    try {
      const ok = await sendGroupMessage({ content_type: 'text', content_text: text });
      if (ok) setComposerText('');
    } finally {
      setSendingMessage(false);
    }
  }

  // Best-effort GC of a staged object the agent never sent.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  async function handleFilePicked(kind: 'image' | 'video' | 'document', file: File | undefined) {
    if (!file) return;
    const max = MEDIA_MAX_BYTES_BY_KIND[kind];
    if (file.size > max) {
      toast.error(
        `${(file.size / 1024 / 1024).toFixed(1)} MB — ${kind} limit is ${Math.round(max / 1024 / 1024)} MB.`
      );
      return;
    }
    setBusy(true);
    try {
      const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
      setDraft({ kind, mediaUrl: publicUrl, path, filename: file.name, caption: '' });
    } catch {
      toast.error(t('uploadError'));
    } finally {
      setBusy(false);
    }
  }

  const sendDraft = useCallback(async () => {
    if (!draft || sendingMessage) return;
    setSendingMessage(true);
    try {
      const ok = await sendGroupMessage({
        content_type: draft.kind,
        media_url: draft.mediaUrl,
        // Audio carries no caption (matches the 1:1 composer/Meta's own rule).
        content_text: draft.kind === 'audio' ? undefined : draft.caption.trim() || undefined,
        filename: draft.kind === 'document' ? draft.filename : undefined,
      });
      if (ok) setDraft(null);
    } finally {
      setSendingMessage(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, sendingMessage]);

  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

  // ---- Voice recording (client-side Ogg/Opus, no server transcode) ---

  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import('opus-recorder').default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimer();
      void recorderRef.current?.stop().catch(() => {});
      removeStaged(draftRef.current?.path);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finalizeRecording = useCallback(async (bytes: Uint8Array) => {
    const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
      type: 'audio/ogg',
    });
    if (file.size === 0) return; // cancelled / empty take
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
      toast.error('Recording is too long (over 16 MB).');
      return;
    }
    setBusy(true);
    try {
      const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
      setDraft({ kind: 'audio', mediaUrl: publicUrl, path, filename: file.name, caption: '' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (busy || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
      toast.error("Voice recording isn't supported in this browser.");
      return;
    }
    try {
      const { default: Recorder } = await import('opus-recorder');
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false,
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
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error('Microphone access denied or unavailable.');
    }
  }, [busy, recording, finalizeRecording]);

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) stopRecording();
  }, [recording, recordSeconds, stopRecording]);

  // ---- Media lightbox --------------------------------------------------

  const mediaGallery = useMemo(
    () =>
      collectMediaGallery(messages, (m) =>
        m.direction === 'outbound' ? t('you') : m.sender_name || m.sender_phone || '—'
      ),
    [messages, t]
  );

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4"
      >
        {messagesLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="text-primary h-5 w-5 animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t('activityEmpty')}
          </p>
        ) : (
          <div className="space-y-3">
            {loadingOlder && (
              <div className="flex justify-center py-1">
                <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
              </div>
            )}
            {messages.map((m) => (
              <GroupMessageBubble
                key={m.id}
                message={m}
                senderLabel={
                  m.direction === 'outbound' ? t('you') : m.sender_name || m.sender_phone || '—'
                }
                onOpenMedia={
                  m.content_type === 'image' || m.content_type === 'video'
                    ? () => setMediaMessageId(m.id)
                    : undefined
                }
                onFirstAudioPlay={
                  m.direction === 'inbound'
                    ? () => {
                        void fetch(
                          `/api/whatsapp/groups/${groupId}/messages/${m.id}/mark-played`,
                          { method: 'POST' }
                        ).catch((err) => {
                          console.error('[group-thread] mark-played failed:', err);
                        });
                      }
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>

      <MediaLightbox
        items={mediaGallery}
        activeId={mediaMessageId}
        onActiveIdChange={setMediaMessageId}
      />

      {canManage && (
        <div className="border-border border-t p-3">
          {/* Hidden file inputs driven by the attach menu. */}
          <input
            ref={imageInputRef}
            type="file"
            accept={PICKER_ACCEPT.image}
            className="hidden"
            onChange={(e) => {
              void handleFilePicked('image', e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <input
            ref={videoInputRef}
            type="file"
            accept={PICKER_ACCEPT.video}
            className="hidden"
            onChange={(e) => {
              void handleFilePicked('video', e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <input
            ref={documentInputRef}
            type="file"
            accept={PICKER_ACCEPT.document}
            className="hidden"
            onChange={(e) => {
              void handleFilePicked('document', e.target.files?.[0]);
              e.target.value = '';
            }}
          />

          {draft ? (
            <div className="border-border bg-muted flex items-center gap-3 rounded-xl border px-3 py-2">
              {draft.kind === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={draft.mediaUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
              ) : draft.kind === 'video' ? (
                <Video className="text-muted-foreground h-8 w-8 shrink-0" />
              ) : draft.kind === 'audio' ? (
                <Mic className="text-muted-foreground h-8 w-8 shrink-0" />
              ) : (
                <FileText className="text-muted-foreground h-8 w-8 shrink-0" />
              )}
              {draft.kind === 'audio' ? (
                <span className="text-muted-foreground flex-1 truncate text-sm">
                  {draft.filename}
                </span>
              ) : (
                <input
                  value={draft.caption}
                  onChange={(e) => setDraft((d) => (d ? { ...d, caption: e.target.value } : d))}
                  placeholder={tComposer('addCaption')}
                  className="text-foreground placeholder-muted-foreground flex-1 bg-transparent text-sm outline-none"
                />
              )}
              <button
                type="button"
                onClick={discardDraft}
                aria-label={tComposer('removeAttachment')}
                title={tComposer('removeAttachment')}
                className="text-muted-foreground hover:text-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
              >
                <X className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void sendDraft()}
                disabled={sendingMessage}
                aria-label={tComposer('send')}
                title={tComposer('send')}
                className="bg-primary text-primary-foreground hover:bg-primary/90 flex h-8 w-8 shrink-0 items-center justify-center rounded-full disabled:opacity-40"
              >
                {sendingMessage ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
          ) : recording ? (
            <div className="border-border bg-muted flex items-center gap-3 rounded-xl border px-4 py-2.5">
              <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
              <span className="text-foreground flex-1 text-sm">
                {tComposer('recording', {
                  current: formatRecordingTime(recordSeconds),
                  max: formatRecordingTime(MAX_RECORDING_SECONDS),
                })}
              </span>
              <button
                type="button"
                onClick={cancelRecording}
                className="text-muted-foreground hover:bg-card hover:text-foreground rounded-md px-2 py-1 text-xs"
              >
                {tComposer('cancel')}
              </button>
              <button
                type="button"
                onClick={stopRecording}
                title={tComposer('stopAndAttach')}
                className="bg-primary hover:bg-primary/90 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-primary-foreground"
              >
                <Square className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-end gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={busy}
                  title={tComposer('attachMedia')}
                  className="text-muted-foreground hover:text-foreground inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Paperclip className="h-4 w-4" />
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="border-border bg-popover">
                  <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                    <ImageIcon className="mr-2 h-4 w-4" />
                    {tComposer('photo')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                    <Video className="mr-2 h-4 w-4" />
                    {tComposer('video')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => documentInputRef.current?.click()}>
                    <FileText className="mr-2 h-4 w-4" />
                    {tComposer('document')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <textarea
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendText();
                  }
                }}
                placeholder={t('typeMessage')}
                rows={1}
                className={cn(
                  'border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 flex-1 resize-none rounded-xl border px-4 py-2.5 text-sm transition-colors outline-none'
                )}
              />

              {/* Voice note — its own button next to Send, same slot the
                  1:1 composer uses (not buried in the attach menu). */}
              <button
                type="button"
                onClick={() => void startRecording()}
                disabled={busy}
                title={tComposer('voiceNote')}
                className="text-muted-foreground hover:text-foreground inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Mic className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={handleSendText}
                disabled={sendingMessage || !composerText.trim()}
                className="bg-primary hover:bg-primary/90 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-primary-foreground disabled:opacity-40"
              >
                {sendingMessage ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
