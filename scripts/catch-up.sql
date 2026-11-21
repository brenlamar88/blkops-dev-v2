-- =====================================================================
-- Black Ops CRM — catch-up bundle
--
-- Applies every change made after the production baseline:
--   20260731000004  import attribution (nullable rep, source_rep_name, views)
--   20260731000005  territory by city (map, resolver, auto-fill triggers)
--   20260731000006  user management (per-user menu visibility)
--   20260731000007  new campuses (seed territories + creator admin trigger)
--
-- Idempotent: safe to run whether none, some, or all of these are already
-- applied, and safe to run twice. Paste the whole thing into the Supabase
-- SQL editor and run once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 000004  Import attribution
-- ---------------------------------------------------------------------
alter table daily_activities alter column user_id drop not null;
alter table daily_activities add column if not exists source_rep_name text;
alter table referrals alter column submitted_by drop not null;
alter table referrals add column if not exists source_rep_name text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'activity_has_an_actor') then
    alter table daily_activities add constraint activity_has_an_actor
      check (user_id is not null or source_rep_name is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'referral_has_an_actor') then
    alter table referrals add constraint referral_has_an_actor
      check (submitted_by is not null or source_rep_name is not null);
  end if;
end $$;

create index if not exists daily_activities_source_rep_name_idx
  on daily_activities (source_rep_name) where user_id is null;
create index if not exists referrals_source_rep_name_idx
  on referrals (source_rep_name) where submitted_by is null;

create or replace function actor_label(uid uuid, fallback text)
returns text language sql stable as $$
  select coalesce(
    (select nullif(trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), '')
       from profiles p where p.id = uid),
    (select p.email from profiles p where p.id = uid),
    fallback,
    'Unknown')
$$;

create or replace view activity_by_rep as
  select a.facility_id,
         actor_label(a.user_id, a.source_rep_name) as rep,
         a.user_id,
         date_trunc('month', a.activity_date)      as month,
         count(*)                                   as entries,
         sum(a.number_of_activities)                as touches
  from daily_activities a
  group by 1, 2, 3, 4;

create or replace view referral_by_rep as
  select r.facility_id,
         actor_label(r.submitted_by, r.source_rep_name) as rep,
         r.submitted_by,
         date_trunc('month', r.referral_date)           as month,
         count(*)                                        as referrals,
         count(*) filter (where r.admission_status = 'Admit')  as admits,
         count(*) filter (where r.admission_status = 'Denial') as denials
  from referrals r
  group by 1, 2, 3, 4;

-- ---------------------------------------------------------------------
-- 000005  Territory by city
-- ---------------------------------------------------------------------
create table if not exists territory_cities (
  id           uuid primary key default gen_random_uuid(),
  facility_id  uuid not null references facilities(id) on delete cascade,
  city         text not null,
  territory_id uuid not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint territory_cities_city_not_blank check (btrim(city) <> ''),
  foreign key (territory_id, facility_id) references territories(id, facility_id)
);

create unique index if not exists territory_cities_facility_city
  on territory_cities (facility_id, lower(btrim(city)));
create index if not exists territory_cities_territory_id_idx
  on territory_cities (territory_id);

drop trigger if exists touch_territory_cities on territory_cities;
create trigger touch_territory_cities before update on territory_cities
  for each row execute function touch_updated_at();

create or replace function territory_for_city(fid uuid, city_name text)
returns uuid language sql stable as $$
  select tc.territory_id
    from territory_cities tc
   where tc.facility_id = fid
     and lower(btrim(tc.city)) = lower(btrim(coalesce(city_name, '')))
   limit 1
$$;

create or replace function fill_territory_from_city()
returns trigger language plpgsql as $$
declare
  cid   uuid;
  ccity text;
begin
  if NEW.territory_id is not null then
    return NEW;
  end if;
  if TG_TABLE_NAME = 'referrals' then
    cid := NEW.prospect_company_id;
  else
    cid := NEW.company_id;
  end if;
  if cid is null then
    return NEW;
  end if;
  select city into ccity from companies where id = cid;
  NEW.territory_id := territory_for_city(NEW.facility_id, ccity);
  return NEW;
end;
$$;

drop trigger if exists fill_territory on daily_activities;
create trigger fill_territory before insert or update on daily_activities
  for each row execute function fill_territory_from_city();
drop trigger if exists fill_territory on referrals;
create trigger fill_territory before insert or update on referrals
  for each row execute function fill_territory_from_city();
drop trigger if exists fill_territory on facility_companies;
create trigger fill_territory before insert or update on facility_companies
  for each row execute function fill_territory_from_city();

alter table territory_cities enable row level security;
drop policy if exists tc_read on territory_cities;
create policy tc_read on territory_cities for select to authenticated
  using (facility_id in (select my_facilities()));
drop policy if exists tc_write on territory_cities;
create policy tc_write on territory_cities for all to authenticated
  using (is_admin_at(facility_id)) with check (is_admin_at(facility_id));

-- ---------------------------------------------------------------------
-- 000006  User management: per-user menu visibility
-- ---------------------------------------------------------------------
create table if not exists user_menu_visibility (
  user_id    uuid not null references profiles(id) on delete cascade,
  menu_key   text not null,
  hidden     boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, menu_key),
  constraint menu_key_not_dashboard check (menu_key <> '/')
);

create index if not exists user_menu_visibility_user_id_idx
  on user_menu_visibility (user_id) where hidden;

alter table user_menu_visibility enable row level security;
drop policy if exists umv_read_self on user_menu_visibility;
create policy umv_read_self on user_menu_visibility for select to authenticated
  using (user_id = auth.uid());
drop policy if exists umv_admin_all on user_menu_visibility;
create policy umv_admin_all on user_menu_visibility for all to authenticated
  using (exists (select 1 from facility_members fm
                  where fm.user_id = user_menu_visibility.user_id
                    and is_admin_at(fm.facility_id)))
  with check (exists (select 1 from facility_members fm
                  where fm.user_id = user_menu_visibility.user_id
                    and is_admin_at(fm.facility_id)));

drop trigger if exists touch_user_menu_visibility on user_menu_visibility;
create trigger touch_user_menu_visibility before update on user_menu_visibility
  for each row execute function touch_updated_at();


-- ---------------------------------------------------------------------
-- 000007  New campuses: seed territories + creator admin on facility insert
-- ---------------------------------------------------------------------
create or replace function seed_new_facility()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into territories (facility_id, name, sort_order)
  values (new.id, 'Red', 1), (new.id, 'White', 2),
         (new.id, 'Blue', 3), (new.id, 'Gold', 4)
  on conflict (facility_id, name) do nothing;

  if auth.uid() is not null then
    insert into facility_members (facility_id, user_id, role)
    values (new.id, auth.uid(), 'admin')
    on conflict (facility_id, user_id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists on_facility_created on facilities;
create trigger on_facility_created after insert on facilities
  for each row execute function seed_new_facility();

-- =====================================================================
-- Company duplicate detection (soft warning)
--
-- Catches a prospective company that shares an address with an existing one,
-- or whose name is very similar / a likely misspelling, so a rep is warned
-- before creating a near-duplicate. It only *warns*: several physicians can
-- legitimately share a hospital's address, so the caller decides whether to
-- proceed. `companies.merged_into_id` remains the tool for collapsing any
-- duplicates that do get in.
-- =====================================================================

create extension if not exists pg_trgm;

-- Trigram index on the name for fast fuzzy lookups as the table grows.
create index if not exists companies_name_trgm
  on companies using gin (lower(name) gin_trgm_ops);

-- Likely duplicates of a prospective company. Invoker-rights (NOT security
-- definer) so the companies RLS policy still scopes results to the caller's
-- organization. search_path includes extensions because pg_trgm's similarity()
-- lives there on Supabase (and in public locally — a missing schema in the
-- path is simply ignored).
create or replace function find_company_duplicates(
  p_name      text,
  p_address   text default null,
  p_city      text default null,
  p_exclude   uuid default null,
  p_threshold real default 0.4
) returns table (
  id uuid, name text, address_line1 text, city text, phone text,
  score real, same_address boolean
) language sql stable
set search_path = public, extensions as $$
  select c.id, c.name, c.address_line1, c.city, c.phone,
         similarity(lower(c.name), lower(coalesce(p_name, ''))) as score,
         (btrim(coalesce(p_address, '')) <> ''
            and btrim(lower(coalesce(c.address_line1, ''))) = btrim(lower(p_address))
            and btrim(lower(coalesce(c.city, ''))) = btrim(lower(coalesce(p_city, '')))
         ) as same_address
    from companies c
   where c.active and c.merged_into_id is null
     and (p_exclude is null or c.id <> p_exclude)
     and (
       similarity(lower(c.name), lower(coalesce(p_name, ''))) >= p_threshold
       or (btrim(coalesce(p_address, '')) <> ''
           and btrim(lower(coalesce(c.address_line1, ''))) = btrim(lower(p_address))
           and btrim(lower(coalesce(c.city, ''))) = btrim(lower(coalesce(p_city, ''))))
     )
   order by same_address desc, score desc
   limit 8
$$;

grant execute on function find_company_duplicates(text, text, text, uuid, real) to authenticated;

-- Refresh PostgREST's schema cache so the new tables are visible immediately.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 20260731000009_company_status.sql — name-change / closed lifecycle
-- ---------------------------------------------------------------------
alter table companies
  add column if not exists status text not null default 'active',
  add column if not exists former_name text;

alter table companies drop constraint if exists companies_status_check;
alter table companies add constraint companies_status_check
  check (status in ('active', 'name_change', 'closed'));

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 20260731000010_facility_company_prospect_status.sql — per-campus tier
-- ---------------------------------------------------------------------
alter table facility_companies add column if not exists prospect_status text;

alter table facility_companies drop constraint if exists facility_companies_prospect_status_check;
alter table facility_companies add constraint facility_companies_prospect_status_check
  check (prospect_status is null or prospect_status in ('Potential Primary', 'Primary', 'Secondary'));

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 20260731000011_merge_city.sql — fold one city spelling into another
-- ---------------------------------------------------------------------
create or replace function merge_city(p_old text, p_new text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if btrim(coalesce(p_old,'')) = '' or btrim(coalesce(p_new,'')) = '' then
    raise exception 'both old and new city are required';
  end if;
  if not exists (select 1 from facility_members m where m.user_id = auth.uid() and m.role='admin') then
    raise exception 'city merge is admin-only';
  end if;
  update companies c set city = btrim(p_new)
   where upper(btrim(c.city)) = upper(btrim(p_old)) and is_org_admin(c.organization_id);
  get diagnostics n = row_count;
  update facility_companies fc set territory_id = territory_for_city(fc.facility_id, p_new)
    from companies c
   where fc.company_id = c.id and upper(btrim(c.city)) = upper(btrim(p_new))
     and territory_for_city(fc.facility_id, p_new) is not null
     and fc.territory_id is distinct from territory_for_city(fc.facility_id, p_new);
  delete from territory_cities tc
   where upper(btrim(tc.city)) = upper(btrim(p_old)) and tc.facility_id in (select my_facilities())
     and not exists (select 1 from companies c2 join facilities f on f.id = tc.facility_id
                      where upper(btrim(c2.city)) = upper(btrim(tc.city)) and c2.organization_id = f.organization_id);
  return n;
end $$;
grant execute on function merge_city(text, text) to authenticated;
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 20260731000012_referral_contact_name.sql — free-text referral contact
-- ---------------------------------------------------------------------
alter table referrals add column if not exists referral_contact_name text;
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 20260731000013_unit_type_adol.sql — add Inpatient Adol unit type
-- ---------------------------------------------------------------------
alter type unit_type add value if not exists 'Inpatient Adol' after 'Inpatient Geri';

-- ---------------------------------------------------------------------
-- 20260731000014_merge_companies.sql — fold a duplicate company into another
-- ---------------------------------------------------------------------
create or replace function merge_companies(p_loser uuid, p_winner uuid)
returns json language plpgsql security definer set search_path = public as $$
declare o1 uuid; o2 uuid; acts int; refs int; cons int; fcs int; loser_na int;
begin
  if p_loser is null or p_winner is null or p_loser = p_winner then
    raise exception 'pick two different companies';
  end if;
  select organization_id into o1 from companies where id = p_loser;
  select organization_id into o2 from companies where id = p_winner;
  if o1 is null or o2 is null then raise exception 'company not found'; end if;
  if o1 <> o2 then raise exception 'companies are in different organizations'; end if;
  if not is_org_admin(o1) then raise exception 'company merge is admin-only'; end if;
  update daily_activities set company_id = p_winner where company_id = p_loser;
  get diagnostics acts = row_count;
  update referrals set prospect_company_id = p_winner where prospect_company_id = p_loser;
  get diagnostics refs = row_count;
  update contacts set company_id = p_winner where company_id = p_loser;
  get diagnostics cons = row_count;
  update facility_companies fc set company_id = p_winner
   where fc.company_id = p_loser
     and not exists (select 1 from facility_companies w where w.company_id = p_winner and w.facility_id = fc.facility_id);
  get diagnostics fcs = row_count;
  delete from facility_companies where company_id = p_loser;
  update companies set merged_into_id = p_winner where merged_into_id = p_loser;
  select count(*) into loser_na from needs_analysis where company_id = p_loser;
  update companies set merged_into_id = p_winner, active = false, updated_at = now() where id = p_loser;
  return json_build_object('activities_moved', acts, 'referrals_moved', refs, 'contacts_moved', cons, 'facility_links_moved', fcs, 'loser_needs_analysis_left', loser_na);
end $$;
grant execute on function merge_companies(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
-- Public survey configuration exposes only campus IDs/names, never CRM records.
create table if not exists public.five_star_public_facilities (
  facility_id uuid primary key references public.facilities(id),
  enabled boolean not null default true
);
alter table public.five_star_public_facilities enable row level security;
revoke all on public.five_star_public_facilities from anon, authenticated;

-- Activate existing campuses whose names match the original Jotform options.
insert into public.five_star_public_facilities(facility_id)
select id from public.facilities where active and
  lower(regexp_replace(name, '[^a-zA-Z]', '', 'g')) in
  ('bastrop','dequincy','ferriday','greenville','lakecharles','leesville',
   'monroe','magnolia','minden','plainview','villeplatte','westmonroe')
on conflict do nothing;

create table if not exists public.five_star_submissions (
  id uuid primary key,
  facility_id uuid not null references public.facilities(id),
  survey_type text not null check(survey_type in ('Referral','Admission','Discharge')),
  respondent_name text not null default '' check(length(respondent_name)<=200),
  source_facility text not null check(length(trim(source_facility)) between 1 and 300),
  referred text check(referred in ('Yes','No')),
  patient_age integer check(patient_age between 0 and 125),
  ratings jsonb not null,
  details jsonb not null default '{}',
  comments text not null default '' check(length(comments)<=5000),
  form_version text not null default 'jotform-242603376879165-v1',
  submitted_at timestamptz not null default clock_timestamp()
);
create index if not exists five_star_campus_date on public.five_star_submissions(facility_id, submitted_at desc);
alter table public.five_star_submissions enable row level security;
revoke all on public.five_star_submissions from anon, authenticated;
grant select on public.five_star_submissions to authenticated;
do $policy$ begin
 if not exists (select 1 from pg_policies where schemaname='public' and tablename='five_star_submissions' and policyname='five_star_member_read') then
  create policy five_star_member_read on public.five_star_submissions for select to authenticated
   using (facility_id in (select public.my_facilities()));
 end if;
end $policy$;

create or replace function public.public_five_star_facilities()
returns table(id uuid, name text) language sql stable security definer set search_path = '' as $
  select f.id, f.name from public.facilities f join public.five_star_public_facilities s
  on s.facility_id=f.id where f.active and s.enabled order by f.name
$;
revoke all on function public.public_five_star_facilities() from public;
grant execute on function public.public_five_star_facilities() to anon, authenticated;

create or replace function public.submit_five_star_survey(
  p_id uuid, p_facility_id uuid, p_survey_type text,
  p_respondent_name text, p_source_facility text, p_referred text,
  p_patient_age integer, p_ratings jsonb, p_details jsonb, p_comments text,
  p_website text default ''
) returns void language plpgsql security definer set search_path = '' as $
declare
  expected text[];
  entry record;
  rating integer;
  clean_details jsonb := '{}';
  detail_id text;
begin
  if coalesce(p_website,'') <> '' then raise exception 'Invalid submission'; end if;
  if p_id is null or p_facility_id is null or not exists (
    select 1 from public.five_star_public_facilities s join public.facilities f on f.id=s.facility_id
    where s.facility_id=p_facility_id and s.enabled and f.active
  ) then raise exception 'Survey campus is unavailable'; end if;
  expected := case p_survey_type
    when 'Discharge' then array['3','13','14','15','16','17','18']
    when 'Referral' then array['28','29','30','31','32','33','34','35']
    when 'Admission' then array['36','37','38','39','40','41','42']
    else null end;
  if expected is null or jsonb_typeof(p_ratings) is distinct from 'object'
    or jsonb_typeof(p_details) is distinct from 'object'
    or octet_length(p_details::text)>50000 then raise exception 'Invalid answers'; end if;
  if (select count(*) from jsonb_object_keys(p_ratings)) <> cardinality(expected)
    or not p_ratings ?& expected then raise exception 'All survey ratings are required'; end if;
  for entry in select key,value from jsonb_each(p_ratings) loop
    if jsonb_typeof(entry.value)<>'number' or entry.value::text !~ '^[1-5]
      then raise exception 'Ratings must be whole numbers from 1 to 5'; end if;
  end loop;
  -- Retain the original Jotform follow-up mappings, including its shared q43
  -- and its q42 > 4 rule. Hidden/stale text is discarded server-side too.
  for entry in select key,value from jsonb_each(p_details) loop
    if jsonb_typeof(entry.value)<>'string' or length(entry.value #>> '{}')>2000
      then raise exception 'Invalid follow-up'; end if;
    if exists (
      select 1 from (values
       ('3','43'),('13','44'),('14','51'),('15','54'),('16','56'),('17','57'),('18','58'),
       ('28','45'),('29','43'),('30','47'),('31','48'),('32','49'),('33','50'),('34','52'),('35','53'),
       ('36','59'),('37','60'),('38','61'),('39','62'),('40','63'),('41','64')
      ) m(rating_id,followup_id)
      where m.followup_id=entry.key and p_ratings ? m.rating_id and (p_ratings->>m.rating_id)::integer<4
    ) or (entry.key='65' and p_ratings ? '42' and (p_ratings->>'42')::integer>4)
    then clean_details := clean_details || jsonb_build_object(entry.key,entry.value);
    end if;
  end loop;
  if length(coalesce(p_respondent_name,''))>200 or length(trim(coalesce(p_source_facility,''))) not between 1 and 300
    or length(coalesce(p_comments,''))>5000 or (p_referred is not null and p_referred not in ('Yes','No'))
    or (p_patient_age is not null and p_patient_age not between 0 and 125)
    then raise exception 'Invalid respondent information'; end if;
  -- Retries use the same random request ID. Never overwrite an existing survey.
  insert into public.five_star_submissions(id,facility_id,survey_type,respondent_name,source_facility,referred,patient_age,ratings,details,comments)
    values(p_id,p_facility_id,p_survey_type,coalesce(p_respondent_name,''),trim(p_source_facility),p_referred,p_patient_age,p_ratings,clean_details,coalesce(p_comments,''))
    on conflict(id) do nothing;
end $;
revoke all on function public.submit_five_star_survey(uuid,uuid,text,text,text,text,integer,jsonb,jsonb,text,text) from public;
grant execute on function public.submit_five_star_survey(uuid,uuid,text,text,text,text,integer,jsonb,jsonb,text,text) to anon, authenticated;
notify pgrst, 'reload schema';

-- Org-wide five-star report (admin only). See migration 20261027000030.
create or replace function five_star_report()
returns table (
  id uuid, submitted_on date, facility_id uuid, facility text,
  survey_type text, avg_score numeric, low_flag boolean, referring_facility text
)
language sql stable security definer set search_path = public as $$
  select s.id, s.submitted_at::date, s.facility_id, f.name, s.survey_type,
         round((select avg(v::numeric) from jsonb_each_text(s.ratings) as e(k, v)), 3),
         exists (select 1 from jsonb_each_text(s.ratings) as e(k, v) where v::numeric <= 2),
         nullif(s.source_facility, '')
  from five_star_submissions s
  join facilities f on f.id = s.facility_id
  where f.organization_id in (select my_orgs())
    and is_org_admin(f.organization_id)
$$;
grant execute on function five_star_report() to authenticated;
notify pgrst, 'reload schema';

-- Operations reporting foundation for the Report Center. See migration 20261030000031.
-- Operations reporting foundation for the Report Center.
--
-- Curated subset of the blkops-development operations rebuild: only what the
-- Report Center and its useOperations loader read/write, plus the SDD /
-- administrator review RPC. Deliberately omits the dev build's write-path
-- validation triggers (operational_program) so existing activity / referral
-- entry in production is unchanged, and omits the rotation planner, expenses
-- and verification engines. New columns are nullable, so existing rows are
-- untouched.

-- Columns the report snapshot and loader read.
alter table daily_activities add column if not exists program_id uuid;
alter table daily_activities add column if not exists visit_outcome text default 'completed'
  check (visit_outcome in ('completed','closed','unsuccessful','leave_behind'));
alter table daily_activities add column if not exists in_person boolean;
alter table referrals add column if not exists program_id uuid;
alter table referrals add column if not exists admitted_program_id uuid;
alter table referrals add column if not exists arrival_confirmed boolean;

-- Access helpers: campus membership plus role.
create or replace function operations_member(fid uuid) returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and fid in (select my_facilities()) $$;
create or replace function operations_manager(fid uuid) returns boolean language sql stable security definer set search_path=public as $$
  select operations_member(fid) and is_manager_at(fid) $$;
create or replace function operations_admin(fid uuid) returns boolean language sql stable security definer set search_path=public as $$
  select operations_member(fid) and is_admin_at(fid) $$;
create or replace function operations_owner(fid uuid, uid uuid) returns boolean language sql stable security definer set search_path=public as $$
  select operations_member(fid) and (uid=auth.uid() or operations_manager(fid))
    and exists(select 1 from facility_members where facility_id=fid and user_id=uid) $$;
create or replace function operations_territory(fid uuid, tid uuid) returns boolean language sql stable security definer set search_path=public as $$
  select operations_member(fid) and (operations_manager(fid) or exists(
    select 1 from facility_members where facility_id=fid and user_id=auth.uid() and territory_id=tid)) $$;

-- Tables (verbatim shapes from the dev build).
create table if not exists facility_programs (
  id uuid primary key default gen_random_uuid(), facility_id uuid not null references facilities(id),
  code text not null, name text not null, unit_type unit_type not null, active boolean not null default true,
  unique(facility_id,code), unique(id,facility_id)
);
create table if not exists company_programs (
  facility_id uuid not null, program_id uuid not null, company_id uuid not null references companies(id),
  category_id uuid references categories(id), tier text not null default 'Secondary' check(tier in ('Primary','Secondary','Tertiary')),
  medical_director_rounds boolean not null default false, active boolean not null default true,
  distance_miles numeric check(distance_miles>=0),
  primary key(program_id,company_id),
  foreign key(program_id,facility_id) references facility_programs(id,facility_id),
  foreign key(facility_id,company_id) references facility_companies(facility_id,company_id)
);
create table if not exists marketing_goals (
  id uuid primary key default gen_random_uuid(), facility_id uuid not null references facilities(id), user_id uuid references profiles(id),
  program_id uuid, period_start date not null, cadence text not null check(cadence in ('monthly','weekly')),
  metric text not null check(metric in ('referrals','admissions','touches','quality_touches','inservices','adc')),
  check((cadence='monthly' and extract(day from period_start)=1) or (cadence='weekly' and extract(isodow from period_start)=1)),
  target numeric not null check(target>=0), notes text, updated_at timestamptz not null default now(),
  foreign key(program_id,facility_id) references facility_programs(id,facility_id),
  unique nulls not distinct(facility_id,user_id,program_id,period_start,cadence,metric)
);
create table if not exists census_entries (
  facility_id uuid not null, program_id uuid not null, census_date date not null,
  actual integer not null check(actual>=0), planned_discharges integer check(planned_discharges>=0),
  pending_discharges integer check(pending_discharges>=0), pending_admits integer check(pending_admits>=0),
  saved_by uuid not null default auth.uid() references profiles(id), updated_at timestamptz not null default now(),
  primary key(program_id,census_date), foreign key(program_id,facility_id) references facility_programs(id,facility_id)
);
create table if not exists rotation_plans(
  id uuid primary key default gen_random_uuid(), facility_id uuid not null references facilities(id), program_id uuid not null,
  territory_id uuid not null, user_id uuid not null references profiles(id), start_date date not null,
  version integer not null default 1, body jsonb not null, updated_at timestamptz not null default now(),
  foreign key(program_id,facility_id) references facility_programs(id,facility_id),
  foreign key(territory_id,facility_id) references territories(id,facility_id),
  unique(facility_id,program_id,territory_id,start_date)
);
create table if not exists low_census_windows(
  id uuid primary key default gen_random_uuid(), facility_id uuid not null, program_id uuid not null,
  starts date not null, ends date not null check(ends>=starts), requested_by uuid not null default auth.uid() references profiles(id),
  approved_by uuid references profiles(id), initials text, reason text not null,
  foreign key(program_id,facility_id) references facility_programs(id,facility_id),
  check(approved_by is null or length(trim(initials)) between 2 and 8)
);
create table if not exists territory_goal_allocations (
  id uuid primary key default gen_random_uuid(),facility_id uuid not null references facilities(id),program_id uuid not null,territory_id uuid not null,
  period_start date not null check(extract(day from period_start)=1),metric text not null check(metric in ('referrals','admissions')),
  target integer not null check(target>=0),source_target numeric not null check(source_target>=0),unit_target integer not null check(unit_target>=0),
  prospect_count integer not null check(prospect_count>=0),denominator integer not null check(denominator>0),basis text not null,source text not null,
  approved_by uuid not null references profiles(id),initials text not null,approved_at timestamptz not null default clock_timestamp(),
  foreign key(program_id,facility_id) references facility_programs(id,facility_id),foreign key(territory_id,facility_id) references territories(id,facility_id),
  unique(program_id,territory_id,period_start,metric)
);
create table if not exists operations_audit (
  id bigint generated always as identity primary key, facility_id uuid not null references facilities(id),
  entity text not null, entity_id text not null, action text not null, actor_id uuid references profiles(id),
  happened_at timestamptz not null default clock_timestamp(), payload jsonb not null default '{}'
);
create table if not exists report_reviews(
  id uuid primary key default gen_random_uuid(),facility_id uuid not null references facilities(id),starts date not null,ends date not null,
  fingerprint text not null,snapshot jsonb not null,sdd_id uuid not null references profiles(id),sdd_initials text not null,
  submitted_at timestamptz not null default clock_timestamp(),admin_id uuid references profiles(id),admin_initials text,approved_at timestamptz,
  unique(facility_id,starts,ends,fingerprint)
);

-- RLS. Campus-scoped read everywhere; admin write on config tables; census is
-- team-writable by its own saver. Wrapped in do-blocks so re-running is safe.
do $$ declare t text; begin
  foreach t in array array['facility_programs','company_programs','marketing_goals','census_entries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists ops_read on %I', t);
    execute format('create policy ops_read on %I for select to authenticated using(operations_member(facility_id))', t);
    execute format('drop policy if exists ops_write on %I', t);
    execute format('create policy ops_write on %I for all to authenticated using(operations_admin(facility_id)) with check(operations_admin(facility_id))', t);
  end loop;
end $$;
do $$ begin
  execute 'drop policy if exists census_team_write on census_entries';
  execute 'create policy census_team_write on census_entries for all to authenticated using(operations_member(facility_id)) with check(operations_member(facility_id) and saved_by=auth.uid())';
  execute 'alter table rotation_plans enable row level security';
  execute 'drop policy if exists plan_read on rotation_plans';
  execute 'create policy plan_read on rotation_plans for select to authenticated using(operations_territory(facility_id,territory_id))';
  execute 'alter table low_census_windows enable row level security';
  execute 'drop policy if exists low_read on low_census_windows';
  execute 'create policy low_read on low_census_windows for select to authenticated using(operations_member(facility_id))';
  execute 'alter table territory_goal_allocations enable row level security';
  execute 'drop policy if exists allocation_read on territory_goal_allocations';
  execute 'create policy allocation_read on territory_goal_allocations for select to authenticated using(operations_member(facility_id))';
  execute 'alter table operations_audit enable row level security';
  execute 'drop policy if exists audit_read on operations_audit';
  execute 'create policy audit_read on operations_audit for select to authenticated using(operations_manager(facility_id))';
  execute 'alter table report_reviews enable row level security';
  execute 'drop policy if exists reports_read on report_reviews';
  execute 'create policy reports_read on report_reviews for select to authenticated using(operations_member(facility_id))';
end $$;

-- Review workflow: a stable snapshot of the week's source entries, and a
-- two-signature (SDD then administrator) sign-off keyed to its fingerprint.
create or replace function operational_report_snapshot(p_facility uuid,p_start date,p_end date) returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
  if not operations_member(p_facility) or p_end<p_start then raise exception 'Campus scope and valid dates required'; end if;
  return jsonb_build_object('facility_id',p_facility,'start',p_start,'end',p_end,
  'activities',coalesce((select jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'program_id',program_id,'territory_id',territory_id,'date',activity_date,'type',activity_type,'count',number_of_activities,'in_person',in_person,'outcome',visit_outcome,'updated_at',updated_at) order by id) from daily_activities where facility_id=p_facility and activity_date between p_start and p_end),'[]'),
  'referrals',coalesce((select jsonb_agg(jsonb_build_object('id',id,'user_id',submitted_by,'program_id',program_id,'territory_id',territory_id,'referral_date',referral_date,'outcome',admission_status,'decision_date',admit_denial_date,'arrived',arrival_confirmed,'admitted_program_id',admitted_program_id,'updated_at',updated_at) order by id) from referrals where facility_id=p_facility and (referral_date between p_start and p_end or admit_denial_date between p_start and p_end)),'[]'));
end $$;
create or replace function sign_operational_report(p_facility uuid,p_start date,p_end date,p_initials text,p_attest boolean,p_id uuid default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare snap jsonb;fp text;r report_reviews%rowtype;
begin
  if not operations_manager(p_facility) or coalesce(p_initials,'')!~'^[A-Za-z]{2,8}$' or not coalesce(p_attest,false) then raise exception 'SDD/administrator review, initials and attestation required'; end if;
  snap:=operational_report_snapshot(p_facility,p_start,p_end);fp:=md5(snap::text);
  if p_id is null then
    insert into report_reviews(facility_id,starts,ends,fingerprint,snapshot,sdd_id,sdd_initials)
    values(p_facility,p_start,p_end,fp,snap,auth.uid(),p_initials) on conflict do nothing;
    select * into r from report_reviews where facility_id=p_facility and starts=p_start and ends=p_end and fingerprint=fp;
  else
    select * into r from report_reviews where id=p_id for update;
    if not found or r.facility_id<>p_facility or r.starts<>p_start or r.ends<>p_end or not operations_admin(p_facility) then raise exception 'Administrator at this campus required'; end if;
    if r.fingerprint<>fp then raise exception 'Source entries changed. SDD must review the new version'; end if;
    if r.approved_at is null then update report_reviews set admin_id=auth.uid(),admin_initials=p_initials,approved_at=clock_timestamp() where id=p_id; end if;
  end if;
  insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload) values(p_facility,'report_reviews',r.id::text,case when p_id is null then 'SDD reviewed' else 'Administrator approved' end,auth.uid(),jsonb_build_object('fingerprint',fp,'initials',p_initials));
  return r.id;
end $$;
revoke all on function operational_report_snapshot(uuid,date,date),sign_operational_report(uuid,date,date,text,boolean,uuid) from public;
grant execute on function operational_report_snapshot(uuid,date,date),sign_operational_report(uuid,date,date,text,boolean,uuid) to authenticated;
notify pgrst,'reload schema';

-- Rotation schedules: planner engine + flag_company. See migration 20261102000032.
-- Rotation schedules: the rotation planner engine and the company-flagging
-- action it uses. Tables rotation_plans / low_census_windows and their RLS
-- already shipped in 20261030000031; this adds the functions. Also adds the
-- verification_flags table + flag_company (the one verification function the
-- rotation page calls); the rest of the verification subsystem is not ported.

-- Rotation engine (from dev migration 20261026000016).
create or replace function request_low_census(p_facility uuid,p_program uuid,p_start date,p_end date,p_reason text,p_initials text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare result uuid;
begin
 if not operations_member(p_facility) or length(trim(coalesce(p_reason,'')))<5 or p_end<p_start then raise exception 'Valid dates, reason and campus access are required'; end if;
 if p_initials is not null and (not operations_admin(p_facility) or length(trim(p_initials)) not between 2 and 8) then raise exception 'Administrator initials required'; end if;
 insert into low_census_windows(facility_id,program_id,starts,ends,reason,approved_by,initials)
 values(p_facility,p_program,p_start,p_end,p_reason,case when p_initials is not null then auth.uid() end,p_initials) returning id into result;
 insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload) values(p_facility,'low_census',result::text,case when p_initials is null then 'requested' else 'approved' end,auth.uid(),jsonb_build_object('initials',p_initials,'reason',p_reason,'starts',p_start,'ends',p_end));
 return result;
end $$;
create or replace function approve_low_census(p_id uuid,p_initials text) returns void language plpgsql security definer set search_path=public as $$
declare w low_census_windows%rowtype;
begin
 select * into w from low_census_windows where id=p_id for update;
 if not found or not operations_admin(w.facility_id) or length(trim(coalesce(p_initials,''))) not between 2 and 8 then raise exception 'Administrator initials required'; end if;
 update low_census_windows set approved_by=auth.uid(),initials=p_initials where id=p_id;
 insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload) values(w.facility_id,'low_census',p_id::text,'approved',auth.uid(),jsonb_build_object('initials',p_initials));
end $$;
create or replace function rotation_tier(p_program uuid,p_company uuid) returns text language sql stable set search_path=public as $$
 select case when lower(ca.name) in ('eldercare','hospital','hospitals') or cp.medical_director_rounds then 'Primary' else cp.tier end
 from company_programs cp join companies c on c.id=cp.company_id left join categories ca on ca.id=coalesce(cp.category_id,c.category_id)
 where cp.program_id=p_program and cp.company_id=p_company
$$;
create or replace function rotation_spacing_ok(tier text,a date,b date) returns boolean language sql immutable as $$
 select case when tier='Primary' then abs(a-b)>=14 when tier='Tertiary' then greatest(a,b)>=least(a,b)+interval '3 months' else greatest(a,b)>=least(a,b)+interval '1 month' end
$$;
create or replace function save_rotation(p_id uuid,p_expected integer,p_facility uuid,p_program uuid,p_territory uuid,p_user uuid,p_start date,p_body jsonb)
returns rotation_plans language plpgsql security definer set search_path=public as $$
declare old rotation_plans%rowtype; result rotation_plans%rowtype; d jsonb; s jsonb; cid uuid; dt date; tier text; slots integer; k integer;
begin
 if not operations_owner(p_facility,p_user) or not operations_territory(p_facility,p_territory) then raise exception 'Route owner or SDD access required'; end if;
 if not exists(select 1 from facility_members where facility_id=p_facility and user_id=p_user and territory_id=p_territory) then raise exception 'Assign the marketer to this territory in Users first'; end if;
 if p_start is null or p_body is null or extract(isodow from p_start)<>1 or jsonb_typeof(p_body->'days') is distinct from 'array' or jsonb_array_length(p_body->'days')<>25 then raise exception 'A rotation needs 25 weekdays starting Monday'; end if;
 -- Serialize overlapping route saves for this campus, including other programs.
 perform pg_advisory_xact_lock(hashtextextended(p_facility::text,0));
 if p_id is not null then
  select * into old from rotation_plans where id=p_id for update;
  if not found or old.facility_id<>p_facility or old.program_id<>p_program or old.territory_id<>p_territory or old.user_id<>p_user or old.start_date<>p_start or old.version is distinct from p_expected then raise exception 'Route changed. Reload before saving'; end if;
  if exists(select 1 from jsonb_array_elements(old.body->'days') od where (od->>'date')::date < (now() at time zone 'America/Chicago')::date and not exists(select 1 from jsonb_array_elements(p_body->'days') nd where nd=od)) then raise exception 'Past route days are archived and cannot be rewritten'; end if;
 end if;
 if (select count(distinct x->>'date') from jsonb_array_elements(p_body->'days') x)<>25 then raise exception 'Duplicate route dates'; end if;
 for d in select * from jsonb_array_elements(p_body->'days') loop
  dt:=(d->>'date')::date;
  if dt is null or dt<p_start or dt>p_start+32 or extract(isodow from dt)>5 then raise exception 'Invalid route day'; end if;
  slots:=case when extract(isodow from dt)=1 then 12 when exists(select 1 from low_census_windows where facility_id=p_facility and program_id=p_program and approved_by is not null and dt between starts and ends) then 18 else 15 end;
  if (d->>'goal')::int is distinct from slots then raise exception 'Daily goal must follow the approved census window'; end if;
  if jsonb_typeof(d->'stops') is distinct from 'array' then raise exception 'Stops must be an array'; end if;
  if (select count(*) from jsonb_array_elements(d->'stops'))<>(select count(distinct x->>'company_id') from jsonb_array_elements(d->'stops') x) then raise exception 'A company can appear only once per day'; end if;
  for s in select * from jsonb_array_elements(d->'stops') loop
   cid:=(s->>'company_id')::uuid;
   if not exists(select 1 from company_programs cp join facility_companies fc on fc.company_id=cp.company_id and fc.facility_id=cp.facility_id join companies c on c.id=cp.company_id where cp.program_id=p_program and cp.company_id=cid and cp.active and fc.active and fc.territory_id=p_territory and c.active and c.merged_into_id is null and c.status<>'closed') then
    -- Previously saved past stops must survive closure; new/future stops cannot use it.
    if old.id is null or dt>=(now() at time zone 'America/Chicago')::date then raise exception 'Stop is closed or outside this program/territory'; end if;
   end if;
   tier:=rotation_tier(p_program,cid);
   if tier is null then raise exception 'Company program eligibility is required'; end if;
   if coalesce((s->>'minutes')::int,0) not between 15 and 240 then raise exception 'Visit duration must be 15–240 minutes'; end if;
   if exists(select 1 from jsonb_array_elements(p_body->'days') od cross join lateral jsonb_array_elements(od->'stops') os where os->>'company_id'=cid::text and od->>'date'<>dt::text and not exists(select 1 from daily_activities missed where missed.facility_id=p_facility and missed.company_id=cid and missed.activity_date=(od->>'date')::date and missed.visit_outcome in ('closed','unsuccessful','leave_behind') and not exists(select 1 from daily_activities done where done.facility_id=p_facility and done.company_id=cid and done.activity_date=missed.activity_date and done.visit_outcome='completed' and done.in_person=true)) and not rotation_spacing_ok(tier,dt,(od->>'date')::date)) then raise exception 'Contact spacing violation in this rotation'; end if;
   if exists(select 1 from rotation_plans rp cross join lateral jsonb_array_elements(rp.body->'days') od cross join lateral jsonb_array_elements(od->'stops') os where rp.facility_id=p_facility and (p_id is null or rp.id<>p_id) and os->>'company_id'=cid::text and not exists(select 1 from daily_activities missed where missed.facility_id=p_facility and missed.company_id=cid and missed.activity_date=(od->>'date')::date and missed.visit_outcome in ('closed','unsuccessful','leave_behind') and not exists(select 1 from daily_activities done where done.facility_id=p_facility and done.company_id=cid and done.activity_date=missed.activity_date and done.visit_outcome='completed' and done.in_person=true)) and not rotation_spacing_ok(tier,dt,(od->>'date')::date)) then raise exception 'Another saved rotation already schedules this contact inside its cadence'; end if;
   if dt>=(now() at time zone 'America/Chicago')::date and exists(select 1 from daily_activities a where a.facility_id=p_facility and a.company_id=cid and a.activity_date<>dt and a.visit_outcome='completed' and a.in_person=true and not rotation_spacing_ok(tier,dt,a.activity_date)) then raise exception 'A completed visit changed the next eligible visit date'; end if;
  end loop;
 end loop;
 if old.id is null then
 insert into rotation_plans(facility_id,program_id,territory_id,user_id,start_date,body) values(p_facility,p_program,p_territory,p_user,p_start,p_body) returning * into result;
 else update rotation_plans set body=p_body,version=version+1,updated_at=now() where id=p_id returning * into result; end if;
 insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload) values(p_facility,'rotation_plans',result.id::text,'saved',auth.uid(),jsonb_build_object('before',to_jsonb(old),'after',to_jsonb(result)));
 return result;
end $$;
revoke all on function save_rotation(uuid,integer,uuid,uuid,uuid,uuid,date,jsonb),request_low_census(uuid,uuid,date,date,text,text),approve_low_census(uuid,text) from public;
grant execute on function save_rotation(uuid,integer,uuid,uuid,uuid,uuid,date,jsonb),request_low_census(uuid,uuid,date,date,text,text),approve_low_census(uuid,text) to authenticated;

-- Company flagging used by the rotation board (from dev migration 20261026000017).
create table if not exists verification_flags(
 id uuid primary key default gen_random_uuid(), facility_id uuid not null references facilities(id), territory_id uuid,
 company_id uuid not null references companies(id), candidate_id uuid references companies(id), kind text not null,
 conflict text not null, suggestion jsonb not null default '{}', proposed jsonb, evidence text,
 status text not null default 'open' check(status in ('open','submitted','resolved','distinct')),
 reported_by uuid default auth.uid() references profiles(id), version integer not null default 1,
 company_version timestamptz, candidate_version timestamptz,
 created_at timestamptz not null default clock_timestamp(), resolved_at timestamptz, resolved_by uuid references profiles(id), initials text,
 foreign key(territory_id,facility_id) references territories(id,facility_id)
);
create unique index if not exists verification_fingerprint on verification_flags(facility_id,company_id,coalesce(candidate_id,company_id),kind) where status in ('open','submitted');
alter table verification_flags enable row level security;
do $$ begin
  execute 'drop policy if exists verification_read on verification_flags';
  execute 'create policy verification_read on verification_flags for select to authenticated using(operations_territory(facility_id,territory_id))';
end $$;
create or replace function flag_company(p_facility uuid,p_company uuid,p_kind text,p_conflict text)
returns uuid language plpgsql security definer set search_path=public as $$
declare tid uuid; rid uuid; c companies%rowtype;
begin
 select territory_id into tid from facility_companies where facility_id=p_facility and company_id=p_company;
 if not found or not operations_territory(p_facility,tid) then raise exception 'Only your territory or SDD scope may be flagged'; end if;
 if length(trim(coalesce(p_conflict,'')))<5 then raise exception 'Describe what needs verification'; end if;
 select * into c from companies where id=p_company;
 insert into verification_flags(facility_id,territory_id,company_id,kind,conflict,suggestion,company_version)
 values(p_facility,tid,p_company,p_kind,p_conflict,jsonb_build_object('name',c.name,'address_line1',c.address_line1,'city',c.city,'state',c.state,'zip',c.zip,'category_id',c.category_id,'territory_id',tid,'status',case when p_kind='Closed' then 'closed' else c.status end),c.updated_at)
 on conflict do nothing returning id into rid;
 return rid;
end $$;
revoke all on function flag_company(uuid,uuid,text,text) from public;
grant execute on function flag_company(uuid,uuid,text,text) to authenticated;
notify pgrst,'reload schema';

-- Facility street address for Marketing settings. See migration 20261102000033.
alter table facilities add column if not exists street_address text;
notify pgrst,'reload schema';

-- Verification page backend (prospect review + verification RPCs). See migration 20261102000034.
-- Verification page backend (ported from blkops-development migrations 17 + 21).
-- verification_flags + flag_company already shipped in 20261102000032. This adds
-- the prospect-review queue and the final scan/resolve/propose/refresh verification
-- functions. merge_companies is upgraded (now also moves company_programs /
-- rotation_plans) but stays granted to authenticated so the existing Companies
-- merge dialog keeps working.

-- New verification_flags columns (submitter signoff).
alter table verification_flags add column if not exists submitter_initials text, add column if not exists submitted_by uuid references profiles(id), add column if not exists submitted_at timestamptz;

-- Prospect import rows (source review queue).
create table if not exists prospect_import_rows (
 id uuid primary key default gen_random_uuid(),
 facility_id uuid not null references facilities(id), program_id uuid not null,
 source_name text not null, fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 sheet text not null default 'MASTER', row_number int not null check(row_number>1),
 raw jsonb not null, record jsonb not null, research jsonb not null default '[]', territory_id uuid,
 status text not null default 'pending' check(status in ('pending','submitted','linked','excluded')),
 proposed jsonb, evidence text, submitter_initials text, submitted_by uuid references profiles(id), submitted_at timestamptz, company_id uuid references companies(id),
 version int not null default 1, imported_by uuid not null default auth.uid() references profiles(id),
 imported_at timestamptz not null default clock_timestamp(), resolved_at timestamptz,
 resolved_by uuid references profiles(id), initials text,
 foreign key(program_id,facility_id) references facility_programs(id,facility_id),
 foreign key(territory_id,facility_id) references territories(id,facility_id),
 unique(facility_id,program_id,fingerprint,sheet,row_number)
);
create index if not exists prospect_review_scope on prospect_import_rows(facility_id,program_id,status);
alter table prospect_import_rows enable row level security;
drop policy if exists prospect_import_read on prospect_import_rows;
create policy prospect_import_read on prospect_import_rows for select to authenticated
 using(operations_territory(facility_id,territory_id));

-- Enhanced company merge (same signature; moves new relations too).
create or replace function merge_companies(p_loser uuid,p_winner uuid) returns json language plpgsql security definer set search_path=public as $$
declare o1 uuid;o2 uuid;acts int;refs int;cons int;fcs int;loser_na int;r record;
begin
 if p_loser is null or p_winner is null or p_loser=p_winner then raise exception 'pick two different companies'; end if;
 perform 1 from companies where id in(p_loser,p_winner) order by id for update;
 select organization_id into o1 from companies where id=p_loser;
 select organization_id into o2 from companies where id=p_winner and active and merged_into_id is null;
 if o1 is null or o2 is null or o1<>o2 then raise exception 'Choose active companies in the same organization'; end if;
 if not is_org_admin(o1) then raise exception 'company merge is admin-only'; end if;
 update daily_activities set company_id=p_winner where company_id=p_loser; get diagnostics acts=row_count;
 update referrals set prospect_company_id=p_winner where prospect_company_id=p_loser; get diagnostics refs=row_count;
 update contacts set company_id=p_winner where company_id=p_loser; get diagnostics cons=row_count;
 insert into facility_companies(facility_id,company_id,territory_id,active,notes,first_worked)
 select facility_id,p_winner,territory_id,active,notes,first_worked from facility_companies where company_id=p_loser
 on conflict(facility_id,company_id) do nothing; get diagnostics fcs=row_count;
 insert into company_programs(facility_id,program_id,company_id,category_id,tier,medical_director_rounds,active,distance_miles)
 select facility_id,program_id,p_winner,category_id,tier,medical_director_rounds,active,distance_miles from company_programs where company_id=p_loser on conflict do nothing;
 delete from company_programs where company_id=p_loser;
 delete from facility_companies where company_id=p_loser;
 for r in select * from rotation_plans where body::text like '%'||p_loser::text||'%' loop
  insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload) values(r.facility_id,'rotation_plans',r.id::text,'company merge',auth.uid(),jsonb_build_object('before',to_jsonb(r),'loser',p_loser,'winner',p_winner));
  update rotation_plans set body=jsonb_set(body,'{days}',(select jsonb_agg(jsonb_set(day,'{stops}',(select coalesce(jsonb_agg(stop order by pos),'[]') from (select distinct on (stop->>'company_id') stop,pos from jsonb_array_elements(day->'stops') with ordinality x(stop,pos) order by stop->>'company_id',pos) unique_stops)) order by daypos) from jsonb_array_elements(replace(body::text,p_loser::text,p_winner::text)::jsonb->'days') with ordinality d(day,daypos))),version=version+1,updated_at=now() where id=r.id;
 end loop;
 update companies set merged_into_id=p_winner where merged_into_id=p_loser;
 select count(*) into loser_na from needs_analysis where company_id=p_loser;
 update companies set merged_into_id=p_winner,active=false where id=p_loser;
 return json_build_object('activities_moved',acts,'referrals_moved',refs,'contacts_moved',cons,'facility_links_moved',fcs,'loser_needs_analysis_left',loser_na);
end $$;

-- Refresh a stale verification flag.
create or replace function refresh_verification(p_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare v verification_flags%rowtype;
begin
 select * into v from verification_flags where id=p_id for update;
 if not found or not operations_territory(v.facility_id,v.territory_id) then raise exception 'Access required'; end if;
 if v.status not in ('open','submitted') then raise exception 'Resolved history is immutable'; end if;
 insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload) values(v.facility_id,'verification_flags',v.id::text,'refreshed',auth.uid(),to_jsonb(v));
 update verification_flags set company_version=(select updated_at from companies where id=v.company_id),candidate_version=(select updated_at from companies where id=v.candidate_id),version=version+1,status='open' where id=p_id;
end $$;

-- Prospectus staging + review RPCs.
create or replace function stage_prospectus(p_facility uuid,p_program uuid,p_source text,p_fingerprint text,p_rows jsonb)
returns int language plpgsql security definer set search_path=public as $$
declare r jsonb; tid uuid; added int:=0; n int;
begin
 if not operations_admin(p_facility) then raise exception 'Administrator access required to import a prospectus'; end if;
 if not exists(select 1 from facility_programs where id=p_program and facility_id=p_facility and active) then raise exception 'Choose an active campus program'; end if;
 if nullif(trim(p_source),'') is null or p_fingerprint !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 100 then raise exception 'Invalid source or import batch (maximum 100 rows)'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  if jsonb_typeof(r->'record')<>'object' or jsonb_typeof(r->'raw')<>'object' or coalesce(r->>'sheet','MASTER')<>'MASTER' then raise exception 'Each source row must include its MASTER record and original values'; end if;
  select id into tid from territories where facility_id=p_facility and active and upper(trim(name))=upper(trim(r#>>'{record,territory}'));
  insert into prospect_import_rows(facility_id,program_id,source_name,fingerprint,sheet,row_number,raw,record,research,territory_id)
  values(p_facility,p_program,p_source,p_fingerprint,'MASTER',(r->>'row_number')::int,r->'raw',r->'record',coalesce(r->'research','[]'),tid)
  on conflict(facility_id,program_id,fingerprint,sheet,row_number) do nothing;
  get diagnostics n=row_count;added:=added+n;
 end loop;
 insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload)
 values(p_facility,'prospect_import',p_fingerprint,'staged',auth.uid(),jsonb_build_object('program',p_program,'source',p_source,'added',added));
 return added;
end $$;
create or replace function propose_prospect_row(p_id uuid,p_version int,p_values jsonb,p_evidence text,p_initials text,p_attest boolean)
returns void language plpgsql security definer set search_path=public as $$
declare r prospect_import_rows%rowtype;
begin
 select * into r from prospect_import_rows where id=p_id for update;
 if not found or not operations_territory(r.facility_id,r.territory_id) then raise exception 'Territory or SDD access required'; end if;
 if r.status not in ('pending','submitted') or r.version is distinct from p_version then raise exception 'Source row changed. Reload before saving'; end if;
 if length(trim(coalesce(p_evidence,'')))<5 or coalesce(p_initials,'')!~'^[A-Za-z]{2,8}$' or not coalesce(p_attest,false) then raise exception 'Record evidence, your initials and verification confirmation'; end if;
 update prospect_import_rows set proposed=p_values,evidence=p_evidence,submitter_initials=p_initials,submitted_by=auth.uid(),submitted_at=clock_timestamp(),status='submitted',version=version+1 where id=p_id;
 insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload) values(r.facility_id,'prospect_import_rows',r.id::text,'proposed',auth.uid(),jsonb_build_object('before',to_jsonb(r),'values',p_values,'evidence',p_evidence));
end $$;
create or replace function resolve_prospect_row(
 p_id uuid,p_version int,p_values jsonb,p_action text,p_company uuid,p_company_version timestamptz,
 p_evidence text,p_initials text,p_attest boolean,p_restate boolean default false)
returns uuid language plpgsql security definer set search_path=public as $$
declare r prospect_import_rows%rowtype;c companies%rowtype;oid uuid;tid uuid;cat uuid;target uuid;fc facility_companies%rowtype;cp company_programs%rowtype;tier_value text;needs_shared_edit boolean;
begin
 select * into r from prospect_import_rows where id=p_id for update;
 if not found or not operations_admin(r.facility_id) then raise exception 'Administrator access required'; end if;
 if r.status not in ('pending','submitted') or r.version is distinct from p_version then raise exception 'Source row changed. Reload before saving'; end if;
 if p_action is null or p_action not in ('create','link','correct_link','exclude') then raise exception 'Choose a resolution'; end if;
 if not coalesce(p_attest,false) or coalesce(p_initials,'')!~'^[A-Za-z]{2,8}$' or length(trim(coalesce(p_evidence,'')))<5 then raise exception 'Administrator initials, evidence and confirmation are required'; end if;
 select organization_id into oid from facilities where id=r.facility_id;
 -- Serialize campus imports so two reviews cannot create the same exact company concurrently.
 perform pg_advisory_xact_lock(hashtext(oid::text));
 if p_action<>'exclude' then
  tid:=nullif(p_values->>'territory_id','')::uuid;cat:=nullif(p_values->>'category_id','')::uuid;
  if not exists(select 1 from territories where id=tid and facility_id=r.facility_id and active) then raise exception 'Choose a campus territory'; end if;
  if not exists(select 1 from categories where id=cat and organization_id=oid and active) then raise exception 'Choose a configured program category'; end if;
  tier_value:=coalesce(nullif(p_values->>'tier',''),'Secondary');
  if tier_value not in ('Primary','Secondary','Tertiary') then raise exception 'Choose a valid cadence'; end if;
  if p_action='create' then
   if exists(select 1 from companies where organization_id=oid and active and merged_into_id is null
    and lower(regexp_replace(name,'[^a-zA-Z0-9]','','g'))=lower(regexp_replace(p_values->>'name','[^a-zA-Z0-9]','','g'))
    and lower(trim(coalesce(address_line1,'')))=lower(trim(coalesce(p_values->>'address_line1','')))
    and lower(trim(coalesce(city,'')))=lower(trim(coalesce(p_values->>'city','')))
    and lower(trim(coalesce(state,'')))=lower(trim(coalesce(p_values->>'state','')))) then
    raise exception 'An exact company/location already exists. Link it instead of creating a duplicate';
   end if;
   if not coalesce((p_values->>'new_company_confirmed')::boolean,false) then raise exception 'Confirm that this is a new company/location after checking the suggested matches'; end if;
   insert into companies(organization_id,name,category_id,created_by)
   values(oid,trim(p_values->>'name'),cat,auth.uid()) returning id into target;
  else
   select * into c from companies where id=p_company and organization_id=oid and active and merged_into_id is null for update;
   if not found then raise exception 'Choose an active company in this organization'; end if;
   if c.updated_at is distinct from p_company_version then raise exception 'Company changed. Reload and compare again'; end if;
   if not coalesce((p_values->>'same_location')::boolean,false) then raise exception 'Confirm the same company AND physical location'; end if;
   target:=c.id;
  end if;
  select * into fc from facility_companies where facility_id=r.facility_id and company_id=target for update;
  select * into cp from company_programs where program_id=r.program_id and company_id=target for update;
  if p_action in ('create','correct_link') then
   if nullif(trim(p_values->>'name'),'') is null or nullif(trim(p_values->>'address_line1'),'') is null or nullif(trim(p_values->>'city'),'') is null or coalesce(p_values->>'state','')!~'^[A-Za-z]{2}$' then raise exception 'Verified name, address, city and two-letter state are required'; end if;
   if p_action='correct_link' and exists(select 1 from facility_companies where company_id=target and not operations_admin(facility_id)) then raise exception 'A corporate administrator with access to every affected campus must correct shared company details'; end if;
   if nullif(trim(p_values->>'phone'),'') is not null and (regexp_replace(p_values->>'phone','[^0-9]','','g') ~ '^([0-9])\1{5}' or regexp_replace(p_values->>'phone','[^0-9]','','g') !~ '^(1)?[2-9][0-9]{2}[2-9][0-9]{6}$') then raise exception 'Enter a verified phone or leave it blank; placeholder/invalid numbers cannot be approved'; end if;
   if nullif(trim(p_values->>'phone'),'') is not null and (regexp_replace(p_values->>'phone','[^0-9]','','g') ~ '^([0-9])\1{5}' or regexp_replace(p_values->>'phone','[^0-9]','','g') !~ '^(1)?[2-9][0-9]{2}[2-9][0-9]{6}$') then raise exception 'Enter a verified phone or leave it blank; placeholder/invalid numbers cannot be approved'; end if;
   update companies set name=trim(p_values->>'name'),address_line1=trim(p_values->>'address_line1'),city=trim(p_values->>'city'),state=upper(trim(p_values->>'state')),zip=nullif(trim(p_values->>'zip'),''),phone=nullif(trim(p_values->>'phone'),''),fax=nullif(trim(p_values->>'fax'),'') where id=target;
  end if;
  insert into facility_companies(facility_id,company_id,territory_id,active)
   values(r.facility_id,target,tid,true)
   on conflict(facility_id,company_id) do update set territory_id=excluded.territory_id,active=true;
  insert into company_programs(facility_id,program_id,company_id,category_id,tier)
   values(r.facility_id,r.program_id,target,cat,tier_value)
   on conflict(program_id,company_id) do update set category_id=excluded.category_id,tier=excluded.tier,active=true;
  if p_restate then
   insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload)
    select r.facility_id,'referral_correction',id::text,'before prospectus restatement',auth.uid(),jsonb_build_object('source_row',r.id,'category_id',category_id,'territory_id',territory_id)
    from referrals where facility_id=r.facility_id and prospect_company_id=target;
   insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload)
    select r.facility_id,'activity_correction',id::text,'before prospectus restatement',auth.uid(),jsonb_build_object('source_row',r.id,'territory_id',territory_id)
    from daily_activities where facility_id=r.facility_id and company_id=target;
   update referrals set territory_id=tid,category_id=case when program_id=r.program_id then cat else category_id end where facility_id=r.facility_id and prospect_company_id=target;
   update daily_activities set territory_id=tid where facility_id=r.facility_id and company_id=target;
  end if;
 end if;
 update prospect_import_rows set status=case when p_action='exclude' then 'excluded' else 'linked' end,company_id=target,proposed=p_values,evidence=p_evidence,initials=p_initials,resolved_by=auth.uid(),resolved_at=clock_timestamp(),version=version+1 where id=r.id;
 insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload)
 values(r.facility_id,'prospect_import_rows',r.id::text,p_action,auth.uid(),jsonb_build_object('source_before',to_jsonb(r),'company_before',to_jsonb(c),'campus_before',to_jsonb(fc),'program_before',to_jsonb(cp),'values',p_values,'target',target,'evidence',p_evidence,'initials',p_initials,'restated',p_restate));
 return target;
end $$;
revoke all on function stage_prospectus(uuid,uuid,text,text,jsonb),propose_prospect_row(uuid,int,jsonb,text,text,boolean),resolve_prospect_row(uuid,int,jsonb,text,uuid,timestamptz,text,text,boolean,boolean) from public;
grant execute on function stage_prospectus(uuid,uuid,text,text,jsonb),propose_prospect_row(uuid,int,jsonb,text,text,boolean),resolve_prospect_row(uuid,int,jsonb,text,uuid,timestamptz,text,text,boolean,boolean) to authenticated;
notify pgrst,'reload schema';

-- Final resolve/scan/propose verification RPCs.
create or replace function resolve_verification(p_id uuid,p_version int,p_values jsonb,p_action text,p_evidence text,p_initials text,p_attest boolean,p_restate boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v verification_flags%rowtype;c companies%rowtype;dest companies%rowtype;result jsonb:='{}';n int; target uuid; tid uuid;
begin
 select * into v from verification_flags where id=p_id for update;
 if not found or not operations_admin(v.facility_id) then raise exception 'Administrator access required'; end if;
 if v.version is distinct from p_version or v.status not in ('open','submitted') then raise exception 'Flag changed. Reload before resolving'; end if;
 if not coalesce(p_attest,false) or coalesce(p_initials,'')!~'^[A-Za-z]{2,8}$' or length(trim(coalesce(p_evidence,'')))<5 then raise exception 'Initials, evidence and verification confirmation required'; end if;
 select * into c from companies where id=v.company_id for update;
 if c.updated_at is distinct from v.company_version then raise exception 'Company changed since scan. Rescan this item before resolving'; end if;
 target:=c.id;
 if v.candidate_id is not null then
  select * into dest from companies where id=v.candidate_id for update;
  if dest.updated_at is distinct from v.candidate_version then raise exception 'Candidate changed since scan'; end if;
 end if;
 if p_action is null or p_action not in ('correct','merge','distinct') then raise exception 'Select a valid resolution'; end if;
 if p_action<>'distinct' and exists(select 1 from facility_companies where company_id in(c.id,v.candidate_id) and not operations_admin(facility_id)) then raise exception 'A corporate administrator with access to every affected campus must apply this shared correction'; end if;
 if p_action='merge' then
  if dest.id is null or not coalesce((p_values->>'same_location')::boolean,false) then raise exception 'Confirm these are the same company and physical location'; end if;
  result:=merge_companies(c.id,dest.id)::jsonb; target:=dest.id;
 end if;
 if p_action<>'distinct' then
  if nullif(trim(p_values->>'name'),'') is null then raise exception 'Company name is required'; end if;
  if nullif(p_values->>'category_id','') is not null and not exists(select 1 from categories where id=(p_values->>'category_id')::uuid and organization_id=c.organization_id) then raise exception 'Category outside organization'; end if;
  tid:=nullif(p_values->>'territory_id','')::uuid;
  update companies set name=trim(p_values->>'name'),address_line1=p_values->>'address_line1',city=p_values->>'city',state=p_values->>'state',zip=p_values->>'zip',
   phone=case when p_values ? 'phone' then nullif(trim(p_values->>'phone'),'') else phone end,fax=case when p_values ? 'fax' then nullif(trim(p_values->>'fax'),'') else fax end,category_id=nullif(p_values->>'category_id','')::uuid,status=coalesce(nullif(p_values->>'status',''),'active') where id=target;
  update facility_companies set territory_id=tid where facility_id=v.facility_id and company_id=target;
  if p_restate then
   insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload)
   select v.facility_id,'referral_correction',id::text,'before restatement',auth.uid(),jsonb_build_object('flag',v.id,'category_id',category_id,'territory_id',territory_id) from referrals where facility_id=v.facility_id and prospect_company_id=target;
   insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload)
   select v.facility_id,'activity_correction',id::text,'before restatement',auth.uid(),jsonb_build_object('flag',v.id,'territory_id',territory_id) from daily_activities where facility_id=v.facility_id and company_id=target;
   update referrals set category_id=nullif(p_values->>'category_id','')::uuid,territory_id=tid where facility_id=v.facility_id and prospect_company_id=target;
   get diagnostics n=row_count; result:=result||jsonb_build_object('referrals_restated',n);
   update daily_activities set territory_id=tid where facility_id=v.facility_id and company_id=target;
   get diagnostics n=row_count; result:=result||jsonb_build_object('activities_restated',n);
  end if;
 end if;
 update verification_flags set status=case when p_action='distinct' then 'distinct' else 'resolved' end,proposed=p_values,evidence=p_evidence,initials=p_initials,resolved_by=auth.uid(),resolved_at=clock_timestamp(),version=version+1 where id=p_id;
 insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload)
 values(v.facility_id,'verification_flags',v.id::text,p_action,auth.uid(),jsonb_build_object('flag_before',to_jsonb(v),'company_before',to_jsonb(c),'candidate_before',to_jsonb(dest),'after',p_values,'impact',result,'evidence',p_evidence,'initials',p_initials,'restated',p_restate));
 return result;
end $$;

create or replace function scan_verification(p_facility uuid) returns integer language plpgsql security definer set search_path=public,extensions as $$
declare c record; d record; total integer:=0; n integer;
begin
 if not operations_member(p_facility) then raise exception 'Campus access required'; end if;
 for c in select x.*,fc.territory_id from facility_companies fc join companies x on x.id=fc.company_id where fc.facility_id=p_facility and fc.active and x.active and x.merged_into_id is null and operations_territory(p_facility,fc.territory_id) loop
  if nullif(trim(c.address_line1),'') is null or nullif(trim(c.city),'') is null or nullif(trim(c.phone),'') is null or regexp_replace(c.phone,'[^0-9]','','g') ~ '^([0-9])\1{5}' or c.category_id is null or c.territory_id is null then
   insert into verification_flags(facility_id,territory_id,company_id,kind,conflict,suggestion,company_version)
   values(p_facility,c.territory_id,c.id,'Incomplete company','Address, city, category, territory or phone needs verification. A repeated-digit phone may be a placeholder.',jsonb_build_object('name',c.name,'address_line1',c.address_line1,'city',c.city,'state',c.state,'zip',c.zip,'category_id',c.category_id,'territory_id',c.territory_id,'status',c.status,'phone',c.phone,'fax',c.fax),c.updated_at) on conflict do nothing;
   get diagnostics n=row_count; total:=total+n;
  end if;
  for d in select x.* from companies x where x.organization_id=c.organization_id and x.id>c.id and x.active and x.merged_into_id is null
   and (lower(trim(x.name))=lower(trim(c.name)) or similarity(lower(x.name),lower(c.name))>=0.8 or (lower(trim(coalesce(x.city,'')))=lower(trim(coalesce(c.city,''))) and similarity(lower(x.name),lower(c.name))>=0.65) or (nullif(trim(x.address_line1),'') is not null and lower(trim(x.address_line1))=lower(trim(c.address_line1)) and similarity(lower(x.name),lower(c.name))>=0.4))
   and not exists(select 1 from verification_flags v where v.facility_id=p_facility and v.company_id=c.id and v.candidate_id=x.id and v.kind='Possible duplicate' and v.status='distinct')
   order by x.name loop
    insert into verification_flags(facility_id,territory_id,company_id,candidate_id,kind,conflict,suggestion,company_version,candidate_version)
    values(p_facility,c.territory_id,c.id,d.id,'Possible duplicate','Similar company names or shared address. Compare name, address, city, category and campus territory; confirm the same physical location before merging.',jsonb_build_object('name',d.name,'address_line1',d.address_line1,'city',d.city,'state',d.state,'zip',d.zip,'category_id',d.category_id,'territory_id',c.territory_id,'status',d.status,'phone',d.phone,'fax',d.fax),c.updated_at,d.updated_at) on conflict do nothing;
    get diagnostics n=row_count; total:=total+n;
  end loop;
 end loop;
 return total;
end $$;
create or replace function propose_verification(p_id uuid,p_version int,p_values jsonb,p_evidence text,p_initials text,p_attest boolean)
returns void language plpgsql security definer set search_path=public as $$
declare v verification_flags%rowtype;
begin
 select * into v from verification_flags where id=p_id for update;
 if not found or not operations_territory(v.facility_id,v.territory_id) then raise exception 'Territory or SDD access required'; end if;
 if v.version is distinct from p_version or v.status not in ('open','submitted') then raise exception 'Flag changed. Reload'; end if;
 if length(trim(coalesce(p_evidence,'')))<5 or coalesce(p_initials,'')!~'^[A-Za-z]{2,8}$' or not coalesce(p_attest,false) then raise exception 'Evidence, your initials and verification confirmation are required'; end if;
 update verification_flags set proposed=p_values,evidence=p_evidence,submitter_initials=p_initials,submitted_by=auth.uid(),submitted_at=clock_timestamp(),status='submitted',version=version+1 where id=p_id;
 insert into operations_audit(facility_id,entity,entity_id,action,actor_id,payload) values(v.facility_id,'verification_flags',v.id::text,'proposed',auth.uid(),jsonb_build_object('before',to_jsonb(v),'values',p_values,'evidence',p_evidence));
end $$;

-- Additional program categories (guarded).
insert into categories(organization_id,name,sort_order)
 select o.id,n.name,n.ord from organizations o cross join (values
 ('Schools / School Counselors',70),('MCOs / DCFS',80),('Judges / Courts / Law Enforcement',90),('Office of Juvenile Justice (OJJ)',100)) n(name,ord)
 where o.slug='fbh' on conflict(organization_id,name) do nothing;

-- Grants.
grant execute on function merge_companies(uuid,uuid) to authenticated;
grant execute on function refresh_verification(uuid) to authenticated;
grant execute on function scan_verification(uuid) to authenticated;
grant execute on function resolve_verification(uuid,int,jsonb,text,text,text,boolean,boolean) to authenticated;
grant execute on function propose_verification(uuid,int,jsonb,text,text,boolean) to authenticated;
notify pgrst,'reload schema';

-- company_programs RLS performance: read policy computes membership once per
-- query (hashed subplan) instead of a per-row SECURITY DEFINER call; writes
-- split off SELECT. Idempotent. (20261103000035)
do $$
begin
  execute 'drop policy if exists ops_read on company_programs';
  execute 'create policy ops_read on company_programs for select to authenticated
           using ((select auth.uid()) is not null and facility_id in (select my_facilities()))';
  execute 'drop policy if exists ops_write on company_programs';
  execute 'drop policy if exists ops_write_ins on company_programs';
  execute 'drop policy if exists ops_write_upd on company_programs';
  execute 'drop policy if exists ops_write_del on company_programs';
  execute 'create policy ops_write_ins on company_programs for insert to authenticated
           with check (operations_admin(facility_id))';
  execute 'create policy ops_write_upd on company_programs for update to authenticated
           using (operations_admin(facility_id)) with check (operations_admin(facility_id))';
  execute 'create policy ops_write_del on company_programs for delete to authenticated
           using (operations_admin(facility_id))';
end $$;
notify pgrst,'reload schema';

-- Store user names in upper case at creation, matching the all-caps display.
-- Idempotent (create or replace). (20261118000036)
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

-- Add service-cycle stage "aware and open to referring, no prior referral" at
-- rank 4 (shifting later ranks up). Idempotent, guarded by name. (20261118000037)
do $$
declare org uuid;
begin
  select id into org from organizations limit 1;
  if not exists (
    select 1 from service_cycle_stages
    where organization_id = org
      and name = 'Contact is aware of our services and open to referring. No prior referral.'
  ) then
    update service_cycle_stages set rank = rank + 1000 where organization_id = org and rank >= 4;
    insert into service_cycle_stages (organization_id, name, short_label, rank)
    values (org,
            'Contact is aware of our services and open to referring. No prior referral.',
            'Open, no prior referral', 4);
    update service_cycle_stages set rank = rank - 999 where organization_id = org and rank >= 1004;
  end if;
end $$;
