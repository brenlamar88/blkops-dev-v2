-- Add a service-cycle stage: a contact who is aware and open to referring but
-- has not referred yet. It sits after "Uses a competitor" (rank 3) and before
-- "Lapsed 6+ months" (rank 4), so later ranks shift up by one.
--
-- (organization_id, rank) is unique, so the shift is done via a large temporary
-- offset to avoid a transient duplicate during the update. Guarded by name so
-- the whole thing is idempotent.

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
