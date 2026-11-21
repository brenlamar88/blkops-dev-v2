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
