"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { LogOut } from "lucide-react";

/** Mirrors the non-httpOnly flag cookie set by POST /api/admin/impersonate. */
const FLAG_COOKIE = "wacrm_impersonating";

function readCookie(name: string): string | null {
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : null;
}

/**
 * Persistent bar shown on every dashboard page while a platform admin
 * is impersonating a customer's user. Reads the non-httpOnly
 * `wacrm_impersonating` cookie (set alongside the httpOnly return
 * token by `/api/admin/impersonate`) purely to decide whether to
 * render — ending the session always goes through the server route,
 * which is the only thing that can actually consume the httpOnly
 * return token.
 */
export function ImpersonationBanner() {
  const t = useTranslations("Admin.impersonationBanner");
  const [email, setEmail] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    setEmail(readCookie(FLAG_COOKIE));
  }, []);

  if (!email) return null;

  const handleEnd = async () => {
    setEnding(true);
    try {
      const res = await fetch("/api/admin/impersonate/end", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.redirectUrl) {
        window.location.href = data.redirectUrl;
        return;
      }
      // Return token missing/expired — no way back through this route.
      // Fall back to a normal login, same as the design accepts.
      window.location.href = "/login";
    } catch {
      window.location.href = "/login";
    } finally {
      setEnding(false);
    }
  };

  return (
    <div className="flex items-center justify-center gap-3 bg-amber-500/90 px-4 py-2 text-sm text-amber-950">
      <span>{t("message", { email })}</span>
      <button
        type="button"
        onClick={() => void handleEnd()}
        disabled={ending}
        className="inline-flex items-center gap-1 rounded-md bg-amber-950/10 px-2 py-1 font-medium hover:bg-amber-950/20 disabled:opacity-60"
      >
        <LogOut className="h-3.5 w-3.5" />
        {t("exit")}
      </button>
    </div>
  );
}
