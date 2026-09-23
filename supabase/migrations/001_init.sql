-- Basisschema ohne Vektorspalten.
-- Die Embedding-Spalten (vector(N)) und Suchfunktionen stehen in 002_vector_search.sql,
-- weil N vom gewählten Embedding-Modell abhängt (siehe docs/EMBEDDINGS.md).
create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists knowledge_sources(
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('web','upload')),
  title text not null,
  url text,
  checksum text,
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_knowledge_sources_web_url on knowledge_sources(url) where source_type = 'web';

create table if not exists knowledge_chunks(
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references knowledge_sources(id) on delete cascade,
  content text not null,
  chunk_index integer not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_knowledge_chunks_source on knowledge_chunks(source_id);

create table if not exists corrections(
  id uuid primary key default gen_random_uuid(),
  title text not null,
  trigger_text text not null,
  corrected_content text not null,
  rationale text,
  source_url text,
  status text not null default 'draft' check (status in ('draft','review','approved','rejected','archived')),
  valid_from timestamptz,
  valid_until timestamptz,
  created_by text,
  reviewed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_corrections_status on corrections(status);

create table if not exists correction_events(
  id uuid primary key default gen_random_uuid(),
  correction_id uuid not null references corrections(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor text,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists answer_feedback(
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  rating integer check (rating between -1 and 1),
  comment text,
  created_at timestamptz not null default now()
);

-- Zugriff nur serverseitig über den Service-Role-Key (umgeht RLS).
-- Ohne Policies haben anon/authenticated keinen Zugriff.
alter table knowledge_sources enable row level security;
alter table knowledge_chunks enable row level security;
alter table corrections enable row level security;
alter table correction_events enable row level security;
alter table answer_feedback enable row level security;
