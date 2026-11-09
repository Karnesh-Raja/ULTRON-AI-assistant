CREATE TABLE IF NOT EXISTS public.ultron_google_accounts (
  email text PRIMARY KEY,
  google_subject text NOT NULL UNIQUE,
  refresh_token_enc text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ultron_google_accounts TO ultron_app;
