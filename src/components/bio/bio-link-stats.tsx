// ============================================================
// Simple performance dashboard for the bio-link editor
// (src/app/(dashboard)/bio-link/page.tsx) — page views, total
// clicks, click-through rate, and a per-button leaderboard.
//
// Entirely derived from data the page already loads (bio_pages.
// view_count via GET /api/bio-page, bio_page_links.click_count via
// GET /api/bio-page/links) — no separate stats endpoint needed.
// ============================================================

import { Eye, MousePointerClick, Trophy } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import type { BioLinkType } from '@/lib/bio/link-types';

export interface BioLinkStatsLink {
  id: string;
  type: BioLinkType;
  label: string;
  click_count: number;
  active: boolean;
}

export function BioLinkStats({
  viewCount,
  links,
}: {
  viewCount: number;
  links: BioLinkStatsLink[];
}) {
  const totalClicks = links.reduce((sum, l) => sum + l.click_count, 0);
  const ctr = viewCount > 0 ? (totalClicks / viewCount) * 100 : 0;
  const ranked = [...links]
    .filter((l) => l.click_count > 0)
    .sort((a, b) => b.click_count - a.click_count);
  const maxClicks = ranked[0]?.click_count ?? 0;

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="grid grid-cols-3 gap-3 text-center">
          <Metric
            icon={<Eye className="h-4 w-4" />}
            label="Visualizações"
            value={viewCount}
          />
          <Metric
            icon={<MousePointerClick className="h-4 w-4" />}
            label="Cliques"
            value={totalClicks}
          />
          <Metric
            icon={<Trophy className="h-4 w-4" />}
            label="Taxa de cliques"
            value={`${ctr.toFixed(1)}%`}
          />
        </div>

        <div className="space-y-2">
          <p className="text-muted-foreground text-xs font-medium">
            Cliques por botão
          </p>
          {ranked.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              Nenhum clique registrado ainda.
            </p>
          ) : (
            <div className="space-y-2">
              {ranked.map((link, i) => (
                <div key={link.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-foreground flex min-w-0 items-center gap-1.5 truncate">
                      {i === 0 && (
                        <Trophy
                          className="h-3.5 w-3.5 shrink-0 text-amber-400"
                          aria-label="Botão mais clicado"
                        />
                      )}
                      <span className="truncate">{link.label}</span>
                      {!link.active && (
                        <span className="text-muted-foreground shrink-0 text-xs">
                          (inativo)
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {link.click_count}
                    </span>
                  </div>
                  <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full rounded-full"
                      style={{
                        width: `${maxClicks > 0 ? (link.click_count / maxClicks) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <div className="bg-muted/50 rounded-lg p-3">
      <div className="text-muted-foreground flex items-center justify-center gap-1.5 text-[10px] font-medium tracking-wider uppercase">
        {icon}
        <span>{label}</span>
      </div>
      <p className="text-foreground mt-1 text-lg font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}
