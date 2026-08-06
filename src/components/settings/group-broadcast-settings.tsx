"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Timer, Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Group-broadcast pacing — the delay (seconds) staggered between one
 * group send and the next inside a campaign. This is a suggestion the
 * account can tune, not a WhatsApp-enforced rule: the platform
 * publishes no rate limits for this (UAZAPI-only) channel, so the app
 * only offers a sane starting point.
 */
export function GroupBroadcastSettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations("Settings.groupBroadcasts");

  const [delaySeconds, setDelaySeconds] = useState<string>("");
  const [savedDelaySeconds, setSavedDelaySeconds] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/whatsapp/group-broadcasts/settings", {
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        const value = String(data?.data?.delay_seconds ?? 8);
        setDelaySeconds(value);
        setSavedDelaySeconds(value);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = delaySeconds !== savedDelaySeconds;
  const parsed = Number(delaySeconds);
  const valid = Number.isFinite(parsed) && parsed >= 1;

  async function handleSave() {
    if (!valid || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch("/api/whatsapp/group-broadcasts/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delay_seconds: parsed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("saveFailed"));
        return;
      }
      setSavedDelaySeconds(String(parsed));
      toast.success(t("saveSuccess"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Timer className="size-4 text-primary" />
            {t("delayLabel")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("delayHint")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">{t("delayFieldLabel")}</Label>
            <Input
              type="number"
              min={1}
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(e.target.value)}
              disabled={!canEditSettings || loading}
            />
            {!canEditSettings && (
              <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>
            )}
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSave}
              disabled={saving || loading || !dirty || !valid}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
