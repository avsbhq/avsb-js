-- ClickHouse decision sink: canonical avsb_decisions schema (ClickHouse DDL flavour).

CREATE TABLE IF NOT EXISTS {{table}} (
  decision_id     String        NOT NULL,
  flag_key        String        NOT NULL,
  context_kind    String        NOT NULL,
  context_key     String        NOT NULL,
  variation_key   Nullable(String),
  value           String,
  source          String        NOT NULL,
  rule_id         Nullable(String),
  rule_type       Nullable(String),
  reasons         Array(String),
  evaluated_at    DateTime64(3) NOT NULL,
  duration_micros UInt32,
  sdk_key         String        NOT NULL,
  sdk_version     String        NOT NULL
)
ENGINE = MergeTree()
ORDER BY (flag_key, evaluated_at);
-- ClickHouse ORDER BY is the primary index; no separate CREATE INDEX needed.
-- For context_key-first queries add a projection:
-- ALTER TABLE {{table}} ADD PROJECTION proj_context_key
--   (SELECT * ORDER BY (context_key, evaluated_at));
