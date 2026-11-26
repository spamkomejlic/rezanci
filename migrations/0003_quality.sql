-- Exposure numbers of each photo, as the phone measured them: share of the photo that is pure white,
-- and share that is pure black. They are kept so that the limits can come from real photos.
ALTER TABLE images ADD COLUMN clipped REAL;
ALTER TABLE images ADD COLUMN dark REAL;
