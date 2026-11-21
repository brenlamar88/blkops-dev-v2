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
returns table(id uuid, name text) language sql stable security definer set search_path = '' as $$
  select f.id, f.name from public.facilities f join public.five_star_public_facilities s
  on s.facility_id=f.id where f.active and s.enabled order by f.name
$$;
revoke all on function public.public_five_star_facilities() from public;
grant execute on function public.public_five_star_facilities() to anon, authenticated;

create or replace function public.submit_five_star_survey(
  p_id uuid, p_facility_id uuid, p_survey_type text,
  p_respondent_name text, p_source_facility text, p_referred text,
  p_patient_age integer, p_ratings jsonb, p_details jsonb, p_comments text,
  p_website text default ''
) returns void language plpgsql security definer set search_path = '' as $$
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
    if jsonb_typeof(entry.value)<>'number' or entry.value::text !~ '^[1-5]$'
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
end $$;
revoke all on function public.submit_five_star_survey(uuid,uuid,text,text,text,text,integer,jsonb,jsonb,text,text) from public;
grant execute on function public.submit_five_star_survey(uuid,uuid,text,text,text,text,integer,jsonb,jsonb,text,text) to anon, authenticated;
notify pgrst, 'reload schema';
