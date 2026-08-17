-- Account-editable "when should the bot hand off" policy, alongside the
-- existing free-text `system_prompt` (029_ai_reply.sql). Nullable free
-- text, same shape as system_prompt: empty/unset falls back to
-- DEFAULT_HANDOFF_POLICY in application code (src/lib/ai/defaults.ts)
-- rather than a SQL default, so the fallback text can evolve without a
-- migration.
alter table ai_configs
  add column if not exists handoff_policy text;
