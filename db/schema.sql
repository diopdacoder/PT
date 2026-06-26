-- Cached Gmail messages with Claude-generated metadata.
-- Keyed by Gmail's stable message id so we never summarize the same email twice.
CREATE TABLE IF NOT EXISTS gmail_messages (
  id              TEXT        PRIMARY KEY,            -- Gmail message id
  thread_id       TEXT        NOT NULL,
  from_addr       TEXT        NOT NULL,
  subject         TEXT        NOT NULL,
  date_header     TEXT,                                 -- raw RFC 2822 date string from Gmail
  snippet         TEXT,
  summary         TEXT,                                 -- Claude one-line summary
  classification  TEXT,                                 -- e.g. 'important' | 'personal' | 'promotional' | 'notification'
  priority        INT,                                  -- 1 (highest) - 4 (lowest), nullable
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summarized_at   TIMESTAMPTZ,
  classified_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS gmail_messages_fetched_at_idx ON gmail_messages (fetched_at DESC);
CREATE INDEX IF NOT EXISTS gmail_messages_classification_idx ON gmail_messages (classification);
