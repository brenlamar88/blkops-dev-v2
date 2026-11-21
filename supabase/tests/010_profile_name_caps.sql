-- =====================================================================
-- handle_new_user stores profile names in upper case.
-- Plain SQL, one rolled-back transaction (same shape as 001/003).
-- =====================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
begin;

create or replace function assert(cond boolean, label text)
returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', label; end if;
  raise notice '  pass  %', label;
end $$;

\echo '--- profile name casing ---'

-- A mixed-case name in the signup metadata is stored upper-cased.
insert into auth.users (id, email, raw_user_meta_data) values
  ('44444444-4444-4444-4444-444444444444', 'caps@freedomhc.com',
   '{"first_name":"Melody","last_name":"Johnson"}'::jsonb);

select assert(
  (select first_name = 'MELODY' and last_name = 'JOHNSON'
     from profiles where id='44444444-4444-4444-4444-444444444444'),
  'handle_new_user upper-cases first and last name');

-- No name metadata at all stores NULL, not an empty string.
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'noname@freedomhc.com');

select assert(
  (select first_name is null and last_name is null
     from profiles where id='55555555-5555-5555-5555-555555555555'),
  'missing name metadata stores null, not an empty string');

rollback;
