"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Search, ShieldAlert } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface AdminAccountRow {
  id: string;
  name: string;
  ownerEmail: string | null;
  status: "active" | "suspended";
  memberCount: number;
  whatsapp: { provider: string; status: string } | null;
  createdAt: string;
}

/**
 * Platform-admin console — the operator's control plane over every
 * tenant account. Not part of the customer-facing dashboard; the
 * actual authorization happens server-side in `requirePlatformAdmin()`
 * on every `/api/admin/*` call, so a 401/403 here just bounces a
 * non-admin back to their own dashboard.
 */
export default function AdminAccountsPage() {
  const t = useTranslations("Admin.accounts");
  const router = useRouter();

  const [accounts, setAccounts] = useState<AdminAccountRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/accounts${q ? `?q=${encodeURIComponent(q)}` : ""}`
      );
      if (res.status === 401 || res.status === 403) {
        setDenied(true);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("loadError"));
        return;
      }
      setAccounts(data.accounts ?? []);
    } catch {
      toast.error(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load("");
  }, [load]);

  useEffect(() => {
    if (denied) {
      const timer = setTimeout(() => router.replace("/dashboard"), 1500);
      return () => clearTimeout(timer);
    }
  }, [denied, router]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void load(query);
  };

  const toggleSuspend = async (row: AdminAccountRow) => {
    const suspending = row.status === "active";
    if (suspending) {
      const reason = window.prompt(t("suspendReasonPrompt")) ?? undefined;
      if (reason === undefined) return; // cancelled
      setBusyId(row.id);
      try {
        const res = await fetch(`/api/admin/accounts/${row.id}/suspend`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t("actionError"));
          return;
        }
        toast.success(t("suspended"));
        void load(query);
      } finally {
        setBusyId(null);
      }
    } else {
      setBusyId(row.id);
      try {
        const res = await fetch(`/api/admin/accounts/${row.id}/reactivate`, {
          method: "POST",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t("actionError"));
          return;
        }
        toast.success(t("reactivated"));
        void load(query);
      } finally {
        setBusyId(null);
      }
    }
  };

  if (denied) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
        <ShieldAlert className="h-10 w-10 text-destructive" />
        <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>

      <form onSubmit={handleSearch} className="mt-6 flex max-w-sm gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-9"
          />
        </div>
        <Button type="submit" variant="outline">
          {t("search")}
        </Button>
      </form>

      <div className="mt-6 rounded-xl border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !accounts || accounts.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {t("noAccounts")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colOwner")}</TableHead>
                <TableHead>{t("colMembers")}</TableHead>
                <TableHead>{t("colWhatsapp")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead>{t("colCreated")}</TableHead>
                <TableHead className="text-right">{t("colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium text-foreground">
                    <a
                      href={`/admin/accounts/${row.id}`}
                      className="hover:underline"
                    >
                      {row.name}
                    </a>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.ownerEmail ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.memberCount}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.whatsapp
                      ? `${row.whatsapp.provider} · ${row.whatsapp.status}`
                      : t("notConnected")}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={row.status === "active" ? "outline" : "destructive"}
                    >
                      {row.status === "active" ? t("active") : t("suspendedBadge")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(row.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant={row.status === "active" ? "destructive" : "outline"}
                      disabled={busyId === row.id}
                      onClick={() => void toggleSuspend(row)}
                    >
                      {busyId === row.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : row.status === "active" ? (
                        t("suspend")
                      ) : (
                        t("reactivate")
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
