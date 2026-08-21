"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  getCapabilities,
  type ProviderCapabilities,
} from "@/lib/whatsapp/providers/capabilities";
import { isProviderId } from "@/lib/whatsapp/providers/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageThread } from "@/components/inbox/message-thread";
import {
  TemplatePicker,
  type TemplateSendValues,
} from "@/components/inbox/template-picker";
import { MessageSquare, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { Contact, Conversation, Message, MessageTemplate } from "@/types";

interface DealConversationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: Contact | null;
  /** `deal.conversation_id` — may be null for deals created before that
   *  field was populated, in which case we fall back to a by-contact
   *  lookup (same fallback `deal-form.tsx` already uses). */
  conversationId: string | null;
}

/**
 * Lets a Kanban card open its contact's WhatsApp thread without leaving the
 * board. Deliberately thin: it doesn't reimplement conversation-list,
 * filters, or unread counts — just resolves one Conversation and renders
 * `MessageThread`, which already does its own message fetch + realtime
 * subscription and persists status/assignment changes itself (see
 * `onStatusChange`/`onAssignChange` below — this modal only mirrors local
 * state, the same way the full /inbox page does).
 */
export function DealConversationModal({
  open,
  onOpenChange,
  contact,
  conversationId,
}: DealConversationModalProps) {
  const t = useTranslations("Pipelines.conversationModal");
  const supabase = createClient();
  const { accountId } = useAuth();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [startText, setStartText] = useState("");
  const [starting, setStarting] = useState(false);

  const resolveConversation = useCallback(async () => {
    if (!contact) {
      setConversation(null);
      return;
    }
    setLoading(true);
    setMessages([]);

    if (conversationId) {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .eq("id", conversationId)
        .maybeSingle();
      if (data) {
        setConversation(data as Conversation);
        setLoading(false);
        return;
      }
    }
    // Fallback for deals created before `conversation_id` was populated —
    // newest conversation for this contact, same lookup `deal-form.tsx` uses.
    const { data } = await supabase
      .from("conversations")
      .select("*")
      .eq("contact_id", contact.id)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setConversation((data as Conversation | null) ?? null);
    setLoading(false);
  }, [contact, conversationId, supabase]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    resolveConversation();
  }, [open, resolveConversation]);

  // Provider capabilities decide which "start conversation" affordance to
  // show: Meta requires a pre-approved template; UAZAPI has no 24h-session
  // restriction and can just send a plain first message.
  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("whatsapp_config")
        .select("provider")
        .eq("account_id", accountId)
        .maybeSingle();
      if (cancelled) return;
      setCapabilities(
        getCapabilities(isProviderId(data?.provider) ? data.provider : "meta"),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, accountId, supabase]);

  async function sendStartMessage(payload: Record<string, unknown>) {
    const res = await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contact?.id, ...payload }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body?.error || t("toastFailedSend"));
      return false;
    }
    await resolveConversation();
    return true;
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues,
  ) {
    if (!contact) return;
    await sendStartMessage({
      message_type: "template",
      template_name: template.name,
      template_language: template.language,
      template_message_params: {
        body: values.body,
        headerText: values.headerText,
        buttonParams: values.buttonParams,
      },
      template_params: values.body,
    });
  }

  async function handleSendText() {
    if (!contact || !startText.trim()) return;
    setStarting(true);
    const ok = await sendStartMessage({
      message_type: "text",
      content_text: startText.trim(),
    });
    setStarting(false);
    if (ok) setStartText("");
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex h-[80vh] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>
              {contact?.name || contact?.phone || t("title")}
            </DialogTitle>
          </DialogHeader>

          <div className="min-h-0 flex-1">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : conversation && contact ? (
              <MessageThread
                conversation={conversation}
                contact={contact}
                messages={messages}
                onMessagesLoaded={(_id, msgs) => setMessages(msgs)}
                onNewMessage={(m) => setMessages((prev) => [...prev, m])}
                onUpdateMessage={(id, updates) =>
                  setMessages((prev) =>
                    prev.map((m) => (m.id === id ? { ...m, ...updates } : m)),
                  )
                }
                onStatusChange={(id, status) =>
                  setConversation((prev) =>
                    prev && prev.id === id ? { ...prev, status } : prev,
                  )
                }
                onAssignChange={(id, agentId) =>
                  setConversation((prev) =>
                    prev && prev.id === id
                      ? { ...prev, assigned_agent_id: agentId ?? undefined }
                      : prev,
                  )
                }
                session24hEnabled={capabilities?.session24h ?? false}
                templatesEnabled={capabilities?.templates ?? false}
                presenceEnabled={capabilities?.presence ?? false}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <MessageSquare className="h-8 w-8 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t("noConversationTitle")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("noConversationDesc")}
                  </p>
                </div>

                {capabilities?.templates ? (
                  <Button
                    size="sm"
                    disabled={!contact}
                    onClick={() => setTemplatePickerOpen(true)}
                  >
                    {t("startConversation")}
                  </Button>
                ) : (
                  <div className="flex w-full max-w-sm gap-2">
                    <Textarea
                      value={startText}
                      onChange={(e) => setStartText(e.target.value)}
                      placeholder={t("textPlaceholder")}
                      rows={2}
                      className="resize-none text-sm"
                    />
                    <Button
                      size="sm"
                      onClick={handleSendText}
                      disabled={!contact || !startText.trim() || starting}
                    >
                      {starting ? t("sending") : t("send")}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <TemplatePicker
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
        onSelect={handleSendTemplate}
      />
    </>
  );
}
