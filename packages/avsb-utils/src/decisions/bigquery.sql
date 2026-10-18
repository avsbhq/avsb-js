-- BigQuery decision sink: canonical avsb_decisions schema (BigQuery DDL flavour).

CREATE TABLE IF NOT EXISTS {{table}} (
  decision_id     STRING         NOT NULL,
  flag_key        STRING         NOT NULL,
  context_kind    STRING         NOT NULL,
  context_key     STRING         NOT NULL,
  variation_key   STRING,
  value           JSON,
  source          STRING         NOT NULL,
  rule_id         STRING,
  rule_type       STRING,
  reasons         ARRAY<STRING>,
  evaluated_at    TIMESTAMP      NOT NULL,
  duration_micros INT64,
  sdk_key         STRING         NOT NULL,
  sdk_version     STRING         NOT NULL
)
-- BigQuery: no CREATE INDEX; use partitioning + clustering instead.
PARTITION BY DATE(evaluated_at)
CLUSTER BY flag_key, context_key;
