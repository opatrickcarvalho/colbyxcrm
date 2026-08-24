'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link2, Plus, Loader2 } from 'lucide-react';

interface AdCampaignRow {
  id: string;
  name: string;
  code: string;
  active: boolean;
  created_at: string;
  click_count: number;
  conversation_count: number;
  won_count: number;
}

export default function AdLinksPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<AdCampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/ad-campaigns', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? 'Failed to load ad links');
        if (!cancelled) setCampaigns(data.data ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load ad links');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Ad Links</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Links de rastreamento para saber de qual anúncio/campanha cada lead do WhatsApp veio.
          </p>
        </div>
        <Button
          onClick={() => router.push('/ad-links/new')}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Nova campanha
        </Button>
      </div>

      {campaigns.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Link2 className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">Nenhuma campanha ainda</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Crie uma campanha para gerar um link de rastreamento.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">Nome</TableHead>
                <TableHead className="text-muted-foreground">Código</TableHead>
                <TableHead className="text-muted-foreground">Status</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">Cliques</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">Conversas</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">Ganhos</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">Criada em</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((c) => (
                <TableRow
                  key={c.id}
                  className="cursor-pointer border-border hover:bg-muted/50"
                  onClick={() => router.push(`/ad-links/${c.id}`)}
                >
                  <TableCell className="font-medium text-foreground">{c.name}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">{c.code}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
                        c.active
                          ? 'border-green-500/30 bg-green-500/10 text-green-400'
                          : 'border-border bg-muted text-muted-foreground'
                      }`}
                    >
                      {c.active ? 'Ativa' : 'Inativa'}
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
                    {c.click_count}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
                    {c.conversation_count}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
                    {c.won_count}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {new Date(c.created_at).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
