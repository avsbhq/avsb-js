-- Snowflake decision sink: canonical avsb_decisions schema (Snowflake DDL flavour).

CREATE TABLE IF NOT EXISTS {{table}} (
  decision_id     VARCHAR(36)    NOT NULL PRIMARY KEY,
  flag_key        VARCHAR(255)   NOT NULL,
  context_kind    VARCHAR(64)    NOT NULL,
  context_key     VARCHAR(255)   NOT NULL,
  variation_key   VARCHAR(255),
  value           VARIANT,
  source          VARCHAR(32)    NOT NULL,
  rule_id         VARCHAR(64),
  rule_type       VARCHAR(32),
  reasons         ARRAY,
  evaluated_at    TIMESTAMP_NTZ  NOT NULL,
  duration_micros NUMBER(10, 0),
  sdk_key         VARCHAR(255)   NOT NULL,
  sdk_version     VARCHAR(64)    NOT NULL
);

-- Snowflake: clustering keys recommended instead of secondary indexes.
-- ALTER TABLE {{table}} CLUSTER BY (flag_key, evaluated_at);
-- ALTER TABLE {{table}} CLUSTER BY (context_key, evaluated_at);
