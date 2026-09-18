-- ============================================================
-- 076_bio_page_link_group_pool_claims.sql
--
-- One-row-per-link claim table guarding the whatsapp_group_pool
-- auto-expansion added to src/lib/bio/whatsapp-group-pool.ts: when
-- every group in a bio-link's pool is full, that module creates a
-- brand-new WhatsApp group cloned from the pool's template.
--
-- That clone involves several sequential UAZAPI round trips (read the
-- template, create the group, mirror its settings), so it's slow
-- enough that a visitor who doesn't see the page navigate right away
-- clicks the button again. Without a claim, that second click reads
-- the same "pool exhausted" snapshot and starts its own clone —
-- exactly what happened in production: two people-ready groups
-- appeared from one over-eager double click.
--
-- The fix is a plain INSERT racing on this table's PRIMARY KEY: only
-- one concurrent request can insert a row for a given link_id, so
-- only one clone proceeds. The loser returns null immediately
-- (same "pool exhausted" fallback as before) instead of also
-- cloning — the winner's new group lands in the pool within a few
-- seconds and the very next click finds it through the normal
-- candidate scan.
--
-- `claimed_at` exists purely so a claim that never got released (the
-- process crashed mid-clone) doesn't wedge that link's pool shut
-- forever — the module deletes anything older than a couple of
-- minutes before treating a conflict as "someone else is actively
-- cloning right now".
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS bio_page_link_group_pool_claims (
  link_id UUID PRIMARY KEY REFERENCES bio_page_links(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bio_page_link_group_pool_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bio_page_link_group_pool_claims_select ON bio_page_link_group_pool_claims;

-- Read-only visibility for account members (useful when debugging a
-- stuck expansion from the dashboard); every write — insert, delete —
-- comes from the public /b/{slug}/go/{linkId} route via
-- supabaseAdmin() (service role), which bypasses RLS by design, same
-- posture as bio_page_link_clicks/bio_page_views.
CREATE POLICY bio_page_link_group_pool_claims_select ON bio_page_link_group_pool_claims FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bio_page_links l
      WHERE l.id = bio_page_link_group_pool_claims.link_id
        AND is_account_member(l.account_id)
    )
  );
