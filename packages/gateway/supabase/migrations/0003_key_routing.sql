-- Route preferences per API key: listings (or "provider:<name>") the agent should try first when it asks by query.
-- Safe to run more than once. Keys created before this migration keep working; they simply have no routing.
alter table public.api_keys
  add column if not exists routing jsonb not null default '{"prefer": [], "strict": false}'::jsonb;
