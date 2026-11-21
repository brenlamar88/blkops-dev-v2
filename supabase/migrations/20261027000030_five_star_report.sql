-- Org-wide five-star survey report, admin only.
--
-- The five_star_member_read RLS policy limits ordinary reads to a user's own
-- campuses, so no member can read across all facilities. This SECURITY DEFINER
-- function returns one summary row per submission for every facility in the
-- caller's organization(s) — but ONLY for the organizations where the caller is
-- an admin (is_org_admin). A non-admin gets an empty set, never another campus's
-- data. Only the fields the report aggregates are returned (no comments, no
-- patient age): a per-survey average of its 1-5 answers, and a low-score flag
-- (any question rated 1 or 2), matching the FBH support report.

create or replace function five_star_report()
returns table (
  id uuid,
  submitted_on date,
  facility_id uuid,
  facility text,
  survey_type text,
  avg_score numeric,
  low_flag boolean,
  referring_facility text
)
language sql stable security definer set search_path = public as $$
  select s.id,
         s.submitted_at::date,
         s.facility_id,
         f.name,
         s.survey_type,
         round((select avg(v::numeric) from jsonb_each_text(s.ratings) as e(k, v)), 3),
         exists (select 1 from jsonb_each_text(s.ratings) as e(k, v) where v::numeric <= 2),
         nullif(s.source_facility, '')
  from five_star_submissions s
  join facilities f on f.id = s.facility_id
  where f.organization_id in (select my_orgs())
    and is_org_admin(f.organization_id)
$$;

grant execute on function five_star_report() to authenticated;
