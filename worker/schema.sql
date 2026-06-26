-- COBRA sync backend — D1 schema (Cloudflare).
-- Apply with:  wrangler d1 execute cobra-sync --file=./schema.sql
-- See ../docs/sync-backend-plan.md §3.3 for the rationale.

-- Per-user housekeeping + quota. user_id is the Lichess account id, established
-- server-side by verifying the bearer token against GET /api/account.
CREATE TABLE IF NOT EXISTS users (
  user_id    TEXT PRIMARY KEY,
  username   TEXT,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  bytes_used INTEGER NOT NULL DEFAULT 0
) STRICT;

-- One row per (user, sync scope). A scope is one revisioned blob — the unit
-- the Lichess study modelled as a chapter.
--   kind='global'        rep_id=''     -> settings (+ rep tombstone list)
--   kind='rep-core'      rep_id=<uuid> -> rep meta + nodes + cards + idea_cards
--   kind='rep-telemetry' rep_id=<uuid> -> mistakes + gaps + spar_games + wdl
CREATE TABLE IF NOT EXISTS blobs (
  user_id      TEXT    NOT NULL REFERENCES users(user_id),
  kind         TEXT    NOT NULL,
  rep_id       TEXT    NOT NULL DEFAULT '',

  revision     INTEGER NOT NULL,
  device_id    TEXT    NOT NULL,
  pushed_at    INTEGER NOT NULL,

  blob         TEXT,
  r2_key       TEXT,
  byte_len     INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,

  deleted_at   INTEGER,

  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,

  PRIMARY KEY (user_id, kind, rep_id),
  CHECK (kind IN ('global','rep-core','rep-telemetry')),
  CHECK (deleted_at IS NOT NULL OR (blob IS NULL) <> (r2_key IS NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS blobs_by_user_updated ON blobs (user_id, updated_at);
