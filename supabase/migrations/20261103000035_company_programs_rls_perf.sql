-- company_programs RLS performance.
--
-- The original ops_read policy was `using(operations_member(facility_id))`, and
-- ops_write was `for all using(operations_admin(facility_id))`. Both are
-- SECURITY DEFINER functions, which Postgres cannot inline, so they were
-- evaluated once PER ROW — and because ops_write was `for all`, a SELECT also
-- OR-ed in operations_admin() per row. Fine at a few hundred rows; once a campus
-- made its full territory eligible (~5k company_programs rows for one campus),
-- the per-row function overhead blew past the authenticated role's 8s statement
-- timeout and the eligibility/rotation loaders failed with "canceling statement
-- due to statement timeout". The raw read is ~50ms — the cost was entirely the
-- per-row RLS calls.
--
-- Fix: the standard Supabase idiom. The read policy now computes the caller's
-- facility set ONCE per query as an uncorrelated, hashed subplan
-- (`facility_id in (select my_facilities())`), with `(select auth.uid())`
-- wrapped so it is an InitPlan. Per-row work drops to a hash probe. Access is
-- identical to operations_member(). Writes stay admin-only but are split into
-- per-command policies so they no longer participate in SELECT.

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
