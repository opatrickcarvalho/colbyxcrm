-- Add Google Gemini as a third BYO-key AI provider option, alongside
-- OpenAI and Anthropic (029_ai_reply.sql). Widens the existing check
-- constraint only — no other schema change, nothing existing breaks.
alter table ai_configs
  drop constraint ai_configs_provider_check;

alter table ai_configs
  add constraint ai_configs_provider_check
  check (provider = any (array['openai'::text, 'anthropic'::text, 'gemini'::text]));

-- Same provider set on the per-call usage log (029_ai_reply.sql).
alter table ai_usage_log
  drop constraint ai_usage_log_provider_check;

alter table ai_usage_log
  add constraint ai_usage_log_provider_check
  check (provider = any (array['openai'::text, 'anthropic'::text, 'gemini'::text]));
