-- Black Ops — rotation scheduler deploy bundle.
-- Paste into the Supabase SQL Editor (prod project hhycqqtwhdofwbxmnbsr) and Run.
-- Idempotent and safe to re-run. Applies migrations 20261102000032 + 20261102000033.

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

-- Marketing settings lets an admin record each campus's hospital street address
-- (the Monday route-start point for rotations). Nullable; existing rows untouched.
alter table facilities add column if not exists street_address text;
notify pgrst,'reload schema';
