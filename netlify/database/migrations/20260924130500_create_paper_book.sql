CREATE TABLE paper_book (
  id text PRIMARY KEY,
  book jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
