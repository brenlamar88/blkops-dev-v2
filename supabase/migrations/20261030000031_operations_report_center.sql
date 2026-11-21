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
