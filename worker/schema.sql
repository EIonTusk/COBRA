-- COBRA sync backend — D1 schema (Cloudflare).
-- Apply with:  wrangler d1 execute cobra-sync --remote --file=./schema.sql
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

-- ---------------------------------------------------------------------------
-- Community openings: published, versioned snapshots of a repertoire's TREE.
-- Never holds training progress, mistakes or any sync blob: the Worker
-- rejects a publish that carries anything but moves, comments and idea-card
-- text (see src/community/tree.ts), and none of these tables reference
-- `blobs`.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS publications (
  id              TEXT    PRIMARY KEY,           -- short random slug
  owner_id        TEXT    NOT NULL REFERENCES users(user_id),
  title           TEXT    NOT NULL,
  description     TEXT    NOT NULL DEFAULT '',
  tags            TEXT    NOT NULL DEFAULT '[]', -- JSON array of strings
  color           TEXT    NOT NULL,              -- 'white' | 'black'
  root_fen_key    TEXT    NOT NULL,
  openings        TEXT    NOT NULL DEFAULT '[]', -- JSON [[eco,name],...] the tree reaches
  visibility      TEXT    NOT NULL,              -- 'public' | 'unlisted'
  show_author     INTEGER NOT NULL DEFAULT 1,
  status          TEXT    NOT NULL DEFAULT 'active', -- 'active' | 'hidden' | 'removed'
  status_reason   TEXT,
  reviewed_at     INTEGER,                       -- last admin review; resets the report count
  current_version INTEGER NOT NULL,
  position_count  INTEGER NOT NULL,
  move_count      INTEGER NOT NULL,
  idea_count      INTEGER NOT NULL DEFAULT 0,
  import_count    INTEGER NOT NULL DEFAULT 0,
  forked_from     TEXT,                          -- publication this tree was imported from
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  removed_at      INTEGER,
  CHECK (color IN ('white','black')),
  CHECK (visibility IN ('public','unlisted')),
  CHECK (status IN ('active','hidden','removed'))
) STRICT;

CREATE INDEX IF NOT EXISTS publications_by_owner ON publications (owner_id, created_at);
CREATE INDEX IF NOT EXISTS publications_listed_new ON publications (status, visibility, updated_at);
CREATE INDEX IF NOT EXISTS publications_listed_popular ON publications (status, visibility, import_count);

CREATE TABLE IF NOT EXISTS publication_versions (
  publication_id TEXT    NOT NULL REFERENCES publications(id),
  version        INTEGER NOT NULL,
  tree           TEXT    NOT NULL,   -- canonical CommunityTreeV1 JSON, rebuilt by the Worker
  byte_len       INTEGER NOT NULL,
  content_hash   TEXT    NOT NULL,
  changelog      TEXT    NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (publication_id, version)
) STRICT;

CREATE INDEX IF NOT EXISTS publication_versions_by_time ON publication_versions (created_at);

-- Full-text search over title, description, tags and the opening names the
-- tree reaches. Rows exist only for listed (active + public) publications.
CREATE VIRTUAL TABLE IF NOT EXISTS publication_fts USING fts5(
  publication_id UNINDEXED, title, description, tags, openings
);

-- Position index: which moves community repertoires contain at a position.
-- `owners` counts distinct people, so one person publishing many copies
-- counts once. Only listed publications contribute.
CREATE TABLE IF NOT EXISTS community_moves (
  fen_hash INTEGER NOT NULL,   -- 53-bit hash of the EPD fen key
  san      TEXT    NOT NULL,
  color    TEXT    NOT NULL,   -- repertoire colour: 'white' | 'black'
  owner_id TEXT    NOT NULL,
  refs     INTEGER NOT NULL,   -- how many of the owner's listed publications contain it
  PRIMARY KEY (fen_hash, san, color, owner_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS community_move_counts (
  fen_hash INTEGER NOT NULL,
  san      TEXT    NOT NULL,
  color    TEXT    NOT NULL,
  owners   INTEGER NOT NULL,
  PRIMARY KEY (fen_hash, san, color)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS publication_imports (
  publication_id TEXT    NOT NULL,
  user_id        TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (publication_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS reports (
  publication_id TEXT    NOT NULL,
  reporter_id    TEXT    NOT NULL,
  reason         TEXT    NOT NULL,   -- 'spam' | 'offensive' | 'other'
  note           TEXT    NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (publication_id, reporter_id)
) STRICT, WITHOUT ROWID;

-- When the daily cron last checked a publisher's Lichess account, and
-- whether Lichess has closed it (their publications are then hidden).
CREATE TABLE IF NOT EXISTS community_authors (
  user_id    TEXT    PRIMARY KEY,
  checked_at INTEGER NOT NULL DEFAULT 0,
  closed     INTEGER NOT NULL DEFAULT 0
) STRICT;
