-- Store user names in upper case at creation.
--
-- The app already displays every rep / user name in all caps; this keeps the
-- stored values consistent too, so raw database reads and external exports
-- match what the UI shows. Covers normal sign-ups and the create-user Edge
-- Function alike, because both insert into auth.users and fire this trigger.
-- nullif(...,'') stores NULL rather than an empty string when no name was given.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into profiles (id, email, first_name, last_name)
  values (new.id, new.email,
          upper(nullif(new.raw_user_meta_data ->> 'first_name', '')),
          upper(nullif(new.raw_user_meta_data ->> 'last_name', '')))
  on conflict (id) do nothing;
  return new;
end;
$$;
