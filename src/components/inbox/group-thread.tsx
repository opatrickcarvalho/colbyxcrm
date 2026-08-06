'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Paperclip, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';

// Same Supabase Storage bucket the inbox composer uses (migration 023).
const CHAT_MEDIA_BUCKET = 'chat-media';

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
  created_at: string;
}

function mimeToMediaKind(mime: string): 'image' | 'video' | 'audio' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Group activity feed — visibility + light moderation, deliberately not
 * a full attendance inbox (no assignment, no unread counts, no
 * automations/flows/AI auto-reply). Shared between the group detail
 * page (`/groups/[id]`) and the inbox's "Grupos" tab so the two never
 * drift apart.
 */
export function GroupThread({
  groupId,
  canManage,
}: {
  groupId: string;
  canManage: boolean;
}) {
  const t = useTranslations('Groups.detail');

  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [composerText, setComposerText] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadMessages = useCallback(async () => {
    setMessagesLoading(true);
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}/messages`, {
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t('loadMessagesError'));
      setMessages(data.data ?? []);
    } catch {
      toast.error(t('loadMessagesError'));
    } finally {
      setMessagesLoading(false);
    }
  }, [groupId, t]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  async function sendGroupMessage(payload: {
    content_type: 'text' | 'image' | 'video' | 'document' | 'audio';
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

  async function handleFilePicked(file: File) {
    const kind = mimeToMediaKind(file.type);
    const max = MEDIA_MAX_BYTES_BY_KIND[kind];
    if (file.size > max) {
      toast.error(
        `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — ${kind} limit is ${Math.round(
          max / 1024 / 1024
        )} MB.`
      );
      return;
    }
    setUploadingAttachment(true);
    try {
      const { publicUrl } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
      await sendGroupMessage({
        content_type: kind,
        media_url: publicUrl,
        filename: kind === 'document' ? file.name : undefined,
      });
    } catch {
      toast.error(t('uploadError'));
    } finally {
      setUploadingAttachment(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-4">
        {messagesLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : messages.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('activityEmpty')}
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <div
                key={m.id}
                // `min-w-0` is load-bearing: without it a flex item won't
                // shrink below its content's intrinsic width, so a long
                // unbroken word/URL pushes the bubble past `max-w-[75%]`
                // below instead of wrapping — same bug already fixed for
                // the 1:1 thread in message-actions.tsx (issue #165).
                className={`flex min-w-0 flex-col ${m.direction === 'outbound' ? 'items-end' : 'items-start'}`}
              >
                <span className="mb-0.5 text-xs text-muted-foreground">
                  {m.direction === 'outbound' ? t('you') : m.sender_name || m.sender_phone || '—'}
                </span>
                <div
                  className={`max-w-[75%] rounded-xl px-3 py-2 text-sm ${
                    m.direction === 'outbound'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  {m.content_type === 'text' ? (
                    <p className="whitespace-pre-wrap break-words">{m.content_text}</p>
                  ) : m.content_type === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={m.media_url ?? undefined}
                      alt={m.content_text ?? ''}
                      className="max-h-52 rounded-lg object-cover"
                    />
                  ) : m.content_type === 'video' ? (
                    <video src={m.media_url ?? undefined} controls className="max-h-52 rounded-lg" />
                  ) : m.content_type === 'audio' ? (
                    <audio src={m.media_url ?? undefined} controls className="w-56" />
                  ) : (
                    <a
                      href={m.media_url ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="break-words underline"
                    >
                      {m.filename || m.content_text || m.content_type}
                    </a>
                  )}
                  {m.content_type !== 'text' && m.content_text && (
                    <p className="mt-1 whitespace-pre-wrap break-words">{m.content_text}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {canManage && (
        <div className="flex items-end gap-2 border-t border-border p-3">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFilePicked(file);
              e.target.value = '';
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            title={t('attach')}
            disabled={uploadingAttachment}
            onClick={() => fileInputRef.current?.click()}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
          >
            {uploadingAttachment ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Paperclip className="h-4 w-4" />
            )}
          </Button>
          <Textarea
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
            className="flex-1 resize-none"
          />
          <Button
            onClick={handleSendText}
            disabled={sendingMessage || !composerText.trim()}
            className="h-9 w-9 shrink-0 p-0"
          >
            {sendingMessage ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
