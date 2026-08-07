-- ============================================================
-- 047_contact_presence.sql — best-effort "last seen"/online status
-- for a contact, fed by UAZAPI's `presence` webhook event.
--
-- Explicitly best-effort: UAZAPI's OpenAPI spec lists `presence` as a
-- subscribable webhook event but documents no payload schema for it
-- (unlike `current_presence`, which is the INSTANCE's own state, not
-- a contact's). Most WhatsApp numbers also restrict who can see their
-- last-seen at all, so these columns may simply stay null for a given
-- contact — the UI must treat that as "unknown", never render a
-- placeholder that implies "never online".
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS presence_status TEXT
    CHECK (presence_status IN ('available', 'unavailable')),
  ADD COLUMN IF NOT EXISTS presence_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
