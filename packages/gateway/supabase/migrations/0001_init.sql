-- BFA gateway: API keys and receipts.
-- Only the gateway (service role) reads or writes these tables. RLS is on with no policies, so the anon and
-- authenticated roles see nothing; the service role bypasses RLS.

create table if not exists public.api_keys (
  id               text primary key check (id ~ '^key_[0-9A-Za-z]{16}$'),
  -- Owner, for the per-user accounts that come later. Null for keys created by the operator CLI.
  user_id          uuid null,
  name             text not null check (char_length(name) between 1 and 100),
  -- First 16 characters of the secret, for display. The secret itself is never stored.
  prefix           text not null check (char_length(prefix) = 16),
  sha256           text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz null,
  -- All APIs combined, per UTC day.
  daily_limit_usd  numeric(20,6) not null check (daily_limit_usd >= 0),
  -- [{ "listing_id": "...", "kind": "usd", "value": "0.50" } | { "listing_id": "...", "kind": "calls", "value": 200 }]
  per_api_limits   jsonb not null default '[]'::jsonb check (jsonb_typeof(per_api_limits) = 'array'),
  scopes           text[] not null default array['run','receipts']::text[]
                   check (cardinality(scopes) > 0 and scopes <@ array['run','receipts','topups']::text[]),
  -- { "mode": "all" | "allow" | "block", "listing_ids": [...] }
  listing_access   jsonb not null default '{"mode":"all","listing_ids":[]}'::jsonb
                   check (listing_access->>'mode' in ('all','allow','block')
                          and jsonb_typeof(listing_access->'listing_ids') = 'array')
);

create index if not exists api_keys_user_id_idx on public.api_keys (user_id) where user_id is not null;

create table if not exists public.receipts (
  receipt_id       text primary key,
  key_id           text null references public.api_keys(id) on delete restrict,
  listing_id       text not null,
  status           text not null check (status in ('paid_ok','paid_empty','paid_error','free_ok','unpaid_error','dry_run')),
  price_usd        numeric(20,6) not null check (price_usd >= 0),
  started_at       timestamptz not null,
  idempotency_key  text not null,
  -- The full receipt as returned to the agent.
  payload          jsonb not null
);

-- "Spend today by key": key_id = $1 and started_at >= <00:00 UTC> (and status in the charged set).
create index if not exists receipts_key_started_idx
  on public.receipts (key_id, started_at)
  include (listing_id, status, price_usd);

-- Idempotency lookups per key.
create index if not exists receipts_key_idempotency_idx on public.receipts (key_id, idempotency_key);

-- Recent receipts across all keys (provider health).
create index if not exists receipts_started_idx on public.receipts (started_at desc);

alter table public.api_keys enable row level security;
alter table public.receipts enable row level security;

-- No policies on purpose. Also drop the default grants to the client roles.
revoke all on table public.api_keys from anon, authenticated;
revoke all on table public.receipts from anon, authenticated;

-- The gateway connects as service_role. Grant it explicitly so this works with the Supabase project setting
-- "Automatically expose new tables" turned off.
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.api_keys to service_role;
grant select, insert, update, delete on table public.receipts to service_role;
