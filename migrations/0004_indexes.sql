-- Look-ups by session and by bag. The moderator screen reads the phones of one session at each poll,
-- and the bag overview reads the sessions of each bag.
CREATE INDEX enrollments_by_session ON enrollments(session_id);
CREATE INDEX sessions_by_bag ON sessions(bag_id);
