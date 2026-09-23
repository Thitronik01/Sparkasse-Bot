-- ============================================================================
-- GENERIERT durch `npm run db:vector-migration` aus supabase/templates/vector_search.sql.tpl
-- Nicht von Hand editieren – Template ändern und neu generieren.
--
-- Embedding-Dimension: {{DIM}}
-- Diese Zahl MUSS exakt ANYMIZE_EMBEDDING_DIMENSION entsprechen (siehe docs/EMBEDDINGS.md).
-- Wechsel von Modell oder Dimension => Migration neu generieren und ALLE Embeddings neu berechnen.
-- ============================================================================

-- Vorhandene Embedding-Spalten mit abweichender Dimension ersetzen (z. B. altes vector(1536)).
-- Achtung: Dabei gehen die gespeicherten Vektoren verloren; sie passen ohnehin nicht zum neuen Modell.
do $$
declare
  t text;
  current_type text;
begin
  foreach t in array array['knowledge_chunks', 'corrections'] loop
    select format_type(a.atttypid, a.atttypmod) into current_type
    from pg_attribute a
    where a.attrelid = format('public.%I', t)::regclass and a.attname = 'embedding' and not a.attisdropped;
    if current_type is not null and current_type <> 'vector({{DIM}})' then
      raise notice 'Ersetze %.embedding (%) durch vector({{DIM}})', t, current_type;
      execute format('alter table public.%I drop column embedding', t);
    end if;
  end loop;
end $$;

alter table knowledge_chunks add column if not exists embedding vector({{DIM}});
alter table knowledge_chunks add column if not exists embedding_model text;
alter table corrections add column if not exists embedding vector({{DIM}});
alter table corrections add column if not exists embedding_model text;

-- HNSW unterstützt bei Typ `vector` maximal 2000 Dimensionen.
create index if not exists idx_knowledge_chunks_embedding on knowledge_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists idx_corrections_embedding on corrections using hnsw (embedding vector_cosine_ops);
create index if not exists idx_knowledge_chunks_embedding_model on knowledge_chunks(embedding_model);

drop function if exists match_knowledge_chunks(vector, text, integer, double precision);
drop function if exists match_corrections(vector, text, integer, double precision);

-- Similarity = 1 - Kosinus-Distanz. Es werden nur Vektoren desselben Embedding-Modells verglichen.
create function match_knowledge_chunks(
  query_embedding vector({{DIM}}),
  p_embedding_model text,
  match_count integer default 8,
  min_similarity double precision default 0.5
)
returns table (
  chunk_id uuid,
  source_id uuid,
  content text,
  chunk_index integer,
  metadata jsonb,
  similarity double precision,
  source_type text,
  source_title text,
  source_url text,
  fetched_at timestamptz
)
language sql stable
set search_path = public, extensions
as $$
  select c.id, c.source_id, c.content, c.chunk_index, c.metadata,
         1 - (c.embedding <=> query_embedding) as similarity,
         s.source_type, s.title, s.url, s.fetched_at
  from knowledge_chunks c
  join knowledge_sources s on s.id = c.source_id
  where c.embedding is not null
    and c.embedding_model = p_embedding_model
    and 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Nur Korrekturen, die im Chat berücksichtigt werden dürfen (approved/review/draft) und aktuell gültig sind.
create function match_corrections(
  query_embedding vector({{DIM}}),
  p_embedding_model text,
  match_count integer default 5,
  min_similarity double precision default 0.6
)
returns table (
  correction_id uuid,
  title text,
  trigger_text text,
  corrected_content text,
  rationale text,
  source_url text,
  status text,
  valid_from timestamptz,
  valid_until timestamptz,
  updated_at timestamptz,
  similarity double precision
)
language sql stable
set search_path = public, extensions
as $$
  select k.id, k.title, k.trigger_text, k.corrected_content, k.rationale, k.source_url, k.status,
         k.valid_from, k.valid_until, k.updated_at,
         1 - (k.embedding <=> query_embedding) as similarity
  from corrections k
  where k.embedding is not null
    and k.embedding_model = p_embedding_model
    and k.status in ('approved', 'review', 'draft')
    and (k.valid_from is null or k.valid_from <= now())
    and (k.valid_until is null or k.valid_until > now())
    and 1 - (k.embedding <=> query_embedding) >= min_similarity
  order by k.embedding <=> query_embedding
  limit match_count;
$$;

revoke all on function match_knowledge_chunks(vector, text, integer, double precision) from public, anon, authenticated;
revoke all on function match_corrections(vector, text, integer, double precision) from public, anon, authenticated;
grant execute on function match_knowledge_chunks(vector, text, integer, double precision) to service_role;
grant execute on function match_corrections(vector, text, integer, double precision) to service_role;
