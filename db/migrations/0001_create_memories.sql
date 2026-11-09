CREATE TABLE IF NOT EXISTS public.ultron_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  category text NOT NULL DEFAULT 'general'
    CHECK (category IN ('preference', 'personal', 'project', 'routine', 'general')),
  tags text[] NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'agent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ultron_memories_created_at_idx
  ON public.ultron_memories (created_at DESC);

CREATE INDEX IF NOT EXISTS ultron_memories_search_idx
  ON public.ultron_memories USING GIN (
    to_tsvector('simple'::regconfig, content)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ultron_memories TO ultron_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ultron_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ultron_app;
