"use client";

import type { Deal, PipelineStage } from "@/types";
import { Calendar, Check, Link2, MessageSquare, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";
import { ContactAvatar } from "@/components/inbox/contact-avatar";
import { Badge } from "@/components/ui/badge";
import { DealNotePopover } from "./deal-note-popover";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  onOpenConversation?: (deal: Deal) => void;
  isOverlay?: boolean;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function DealCard({
  deal,
  stage,
  onEdit,
  onOpenConversation,
  isOverlay,
}: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const contactLabel = deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;

  return (
    // A plain <div role="button"> rather than a <button> — the quick-action
    // icons below are real <button>s, and a <button> can't legally contain
    // another one. `onKeyDown` restores the same Enter/Space activation a
    // native button would give for free.
    <div
      role="button"
      tabIndex={isOverlay ? -1 : 0}
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      onKeyDown={(e) => {
        if (isOverlay) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onEdit(deal);
        }
      }}
      className={`group relative w-full cursor-pointer rounded-xl border border-border/50 bg-muted/70 pl-4 pr-3 py-3 text-left shadow-sm transition-all ${
        isOverlay
          ? "shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-lg"
      }`}
    >
      {/* 4px left accent bar using stage color */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
      />

      <div className="flex items-start justify-between gap-2">
        <h4 className="flex-1 text-sm font-semibold leading-snug text-foreground break-words">
          {deal.title}
        </h4>
        {deal.status === "won" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
            <Check className="h-3 w-3" />
            {t("won")}
          </span>
        )}
        {deal.status === "lost" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
            <X className="h-3 w-3" />
            {t("lost")}
          </span>
        )}
      </div>

      {/* Contact row */}
      <div className="mt-2 flex items-center gap-2">
        <ContactAvatar
          avatarUrl={deal.contact?.avatar_url}
          name={contactLabel}
          wrapperClassName="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground overflow-hidden"
          imgClassName="h-5 w-5 rounded-full object-cover"
        />
        <span className="truncate text-xs text-muted-foreground">{contactLabel}</span>
      </div>

      {deal.contact?.lead_source_campaign_name && (
        <Badge variant="outline" className="mt-2 max-w-full">
          <Link2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{deal.contact.lead_source_campaign_name}</span>
        </Badge>
      )}

      <div className="mt-2 flex items-center justify-between">
        <span className="text-sm font-bold text-primary">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        {deal.expected_close_date && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Calendar className="h-3 w-3" />
            {formatDate(deal.expected_close_date)}
          </span>
        )}
      </div>

      {!isOverlay && (
        <div className="mt-2 flex items-center justify-between border-t border-border/40 pt-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t("openConversation")}
              title={t("openConversation")}
              disabled={!onOpenConversation}
              onClick={(e) => {
                e.stopPropagation();
                onOpenConversation?.(deal);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </button>
            <DealNotePopover contactId={deal.contact_id ?? null} />
          </div>

          {assigneeLabel && (
            <div title={assigneeLabel}>
              <ContactAvatar
                avatarUrl={deal.assignee?.avatar_url}
                name={assigneeLabel}
                wrapperClassName="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary overflow-hidden"
                imgClassName="h-5 w-5 rounded-full object-cover"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
