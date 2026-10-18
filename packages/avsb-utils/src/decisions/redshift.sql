-- Redshift decision sink: canonical avsb_decisions schema (Redshift DDL flavour).

CREATE TABLE IF NOT EXISTS {{table}} (
  decision_id     VARCHAR(36)  NOT NULL PRIMARY KEY,
  flag_key        VARCHAR(255) NOT NULL,
  context_kind    VARCHAR(64)  NOT NULL,
  context_key     VARCHAR(255) NOT NULL,
  variation_key   VARCHAR(255),
  value           SUPER,
  source          VARCHAR(32)  NOT NULL,
  rule_id         VARCHAR(64),
  rule_type       VARCHAR(32),
  reasons         SUPER,
  evaluated_at    TIMESTAMP    NOT NULL,
  duration_micros BIGINT,
  sdk_key         VARCHAR(255) NOT NULL,
  sdk_version     VARCHAR(64)  NOT NULL
)
SORTKEY (flag_key, evaluated_at);

-- Secondary sort recommendation: for context_key-first queries consider an
-- interleaved sort key or a second table projection:
-- INTERLEAVED SORTKEY (flag_key, evaluated_at, context_key);
