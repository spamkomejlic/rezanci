-- State store for capture sessions. Times are ISO 8601 text in UTC.

CREATE TABLE locations (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE bags (
  id TEXT PRIMARY KEY,
  location_code TEXT NOT NULL REFERENCES locations(code),
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  bag_id TEXT NOT NULL REFERENCES bags(id),
  material TEXT NOT NULL CHECK (material IN ('shredded', 'torn', 'sheets')),
  moderator TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_type TEXT CHECK (close_type IN ('normal', 'forced')),
  force_reason TEXT
);
-- The database enforces the two rules against a mix of bags.
CREATE UNIQUE INDEX one_open_session_per_moderator ON sessions(moderator) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX one_open_session_per_bag ON sessions(bag_id) WHERE closed_at IS NULL;

-- One-time codes from the moderator QR code. Only the hash of a code is stored.
CREATE TABLE enroll_codes (
  code_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- One row per operator phone per session. Only the hash of the session token is stored.
CREATE TABLE enrollments (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  phone_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  baseline_score REAL,
  done_at TEXT,
  removed_at TEXT
);

CREATE TABLE images (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  sha256 TEXT NOT NULL,
  token_hash TEXT NOT NULL REFERENCES enrollments(token_hash),
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  captured_at TEXT,
  blur_score REAL,
  flagged INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'missing')),
  created_at TEXT NOT NULL,
  verified_at TEXT,
  PRIMARY KEY (session_id, sha256)
);

-- Append-only record of each action.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  session_id TEXT,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT
);
