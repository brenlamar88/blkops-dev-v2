-- Marketing settings lets an admin record each campus's hospital street address
-- (the Monday route-start point for rotations). Nullable; existing rows untouched.
alter table facilities add column if not exists street_address text;
notify pgrst,'reload schema';
