-- BFA gateway: people who sign in with Google, and the link from API keys to their owner.
-- Each user's money is in their own treasury vault on NEAR. The gateway stores only a function-call key that can
-- call the treasury's sign_eip3009 within the vault's on-chain limits, encrypted with BFA_SECRET_KEY.

create table if not exists public.users (
  id                uuid primary key,
  google_sub        text not null unique,
  email             text not null,
  name              text null,
  created_at        timestamptz not null default now(),
  near_account_id   text null unique check (near_account_id ~ '^[0-9a-f]{64}$'),
  agent_public_key  text null,
  agent_secret_enc  text null,
  wallet_status     text not null default 'none' check (wallet_status in ('none','funded','ready'))
);

alter table public.api_keys
  add constraint api_keys_user_fk foreign key (user_id) references public.users(id) on delete restrict;

alter table public.users enable row level security;
revoke all on table public.users from anon, authenticated;

grant select, insert, update, delete on table public.users to service_role;
