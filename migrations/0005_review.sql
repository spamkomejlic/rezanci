-- Photo check by the moderator: a decision per photo, counters per phone.

-- Decision of the moderator for one photo. No value means that nobody checked the photo.
ALTER TABLE images ADD COLUMN review TEXT CHECK (review IN ('approved', 'rejected'));
ALTER TABLE images ADD COLUMN reviewed_by TEXT;
ALTER TABLE images ADD COLUMN reviewed_at TEXT;

-- Counters per phone. flags_open: flagged photos in the archive that have no decision. They block a normal close.
ALTER TABLE enrollments ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrollments ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrollments ADD COLUMN flags_open INTEGER NOT NULL DEFAULT 0;
UPDATE enrollments SET flags_open =
  (SELECT COUNT(*) FROM images i WHERE i.token_hash = enrollments.token_hash AND i.flagged = 1 AND i.state = 'verified');

-- The same trigger as in migration 0002, and a flagged photo that reaches the archive now counts as an open flag.
DROP TRIGGER image_verified;
CREATE TRIGGER image_verified AFTER UPDATE OF state ON images WHEN NEW.state = 'verified' AND OLD.state <> 'verified' BEGIN
  UPDATE enrollments SET verified = verified + 1, flags_open = flags_open + NEW.flagged WHERE token_hash = NEW.token_hash;
  INSERT INTO events (at, session_id, actor, type, detail)
    SELECT NEW.verified_at, NEW.session_id, 'operator:' || operator_name, 'verify', json_object('sha256', NEW.sha256, 'bytes', NEW.bytes)
    FROM enrollments WHERE token_hash = NEW.token_hash;
END;

-- A decision changes the counters and writes its line in the event record, in the same transaction.
CREATE TRIGGER image_reviewed AFTER UPDATE OF review ON images BEGIN
  UPDATE enrollments SET
    approved = approved + (NEW.review IS 'approved') - (OLD.review IS 'approved'),
    rejected = rejected + (NEW.review IS 'rejected') - (OLD.review IS 'rejected'),
    flags_open = flags_open + NEW.flagged * ((NEW.review IS NULL) - (OLD.review IS NULL))
  WHERE token_hash = NEW.token_hash;
  INSERT INTO events (at, session_id, actor, type, detail)
    VALUES (NEW.reviewed_at, NEW.session_id, NEW.reviewed_by, 'review', json_object('sha256', NEW.sha256, 'decision', NEW.review));
END;
