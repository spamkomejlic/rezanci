-- Photo upload: counters per phone, the phone queue report, the manifest state of a session.

-- Counters per phone. The moderator screen reads one row per phone and not each image record.
ALTER TABLE enrollments ADD COLUMN images INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrollments ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrollments ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
-- Photos that the phone holds and that are not in the archive, as the phone reported it.
ALTER TABLE enrollments ADD COLUMN queue_len INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrollments ADD COLUMN seen_at TEXT;

-- Time at which the manifest file of a closed session was written to the archive.
ALTER TABLE sessions ADD COLUMN manifest_at TEXT;

-- The database keeps the counters, in the same transaction as the change of the image record.
CREATE TRIGGER image_added AFTER INSERT ON images BEGIN
  UPDATE enrollments SET images = images + 1, flagged = flagged + NEW.flagged WHERE token_hash = NEW.token_hash;
END;

-- An image record becomes "verified" one time. The event record gets its line at the same moment.
CREATE TRIGGER image_verified AFTER UPDATE OF state ON images WHEN NEW.state = 'verified' AND OLD.state <> 'verified' BEGIN
  UPDATE enrollments SET verified = verified + 1 WHERE token_hash = NEW.token_hash;
  INSERT INTO events (at, session_id, actor, type, detail)
    SELECT NEW.verified_at, NEW.session_id, 'operator:' || operator_name, 'verify', json_object('sha256', NEW.sha256, 'bytes', NEW.bytes)
    FROM enrollments WHERE token_hash = NEW.token_hash;
END;
