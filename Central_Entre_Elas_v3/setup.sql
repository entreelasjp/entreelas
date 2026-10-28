create table if not exists public.docs (
  coll text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  primary key (coll, id)
);
alter table public.docs enable row level security;
