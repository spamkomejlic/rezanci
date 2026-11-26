-- Contents of a bag: the option "sheets" is gone, the option "crosscut" (paper in small pieces) is new.
-- The sessions table had the list of options in a CHECK rule, and SQLite cannot change a CHECK rule.
-- This file makes the table again with the same rows and with no such rule: the list is in the Worker code
-- (MATERIALS in src/api.js), so a later change of the list needs no new table.
-- Other tables point at sessions(id). defer_foreign_keys lets the old table go while its rows move.

PRAGMA defer_foreign_keys = true;

CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  bag_id TEXT NOT NULL REFERENCES bags(id),
  material TEXT NOT NULL,
  moderator TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_type TEXT CHECK (close_type IN ('normal', 'forced')),
  force_reason TEXT,
  manifest_at TEXT
);
INSERT INTO sessions_new (id, bag_id, material, moderator, opened_at, closed_at, close_type, force_reason, manifest_at)
  SELECT id, bag_id, material, moderator, opened_at, closed_at, close_type, force_reason, manifest_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

-- The indexes of the old table went with it. The first two are the rules against a mix of bags.
CREATE UNIQUE INDEX one_open_session_per_moderator ON sessions(moderator) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX one_open_session_per_bag ON sessions(bag_id) WHERE closed_at IS NULL;
CREATE INDEX sessions_by_bag ON sessions(bag_id);

PRAGMA defer_foreign_keys = false;
