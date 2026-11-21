import { useEffect } from 'react'
import { supabase } from './supabase'
import { useApp, useQuery, fetchAll } from './data'
import { categoryName } from './operations-core'
export async function rpc(name, args) {
  const r = await supabase.rpc(name, args)
  if (r.error) throw Error(r.error.message)
  return r.data
}
export function useOperations() {
  const { facilityId } = useApp()
  const q = useQuery(async () => {
    if (!facilityId) return { data: [] }
    const defs = {
      programs: () =>
        supabase
          .from('facility_programs')
          .select('*')
          .eq('facility_id', facilityId)
          .order('code'),
      members: () =>
        supabase
          .from('facility_members')
          .select('*,profile:profiles(id,first_name,last_name,email)')
          .eq('facility_id', facilityId)
          .order('user_id'),
      companies: () =>
        supabase
          .from('facility_companies')
          .select('*,company:companies(*,category:categories(name))')
          .eq('facility_id', facilityId)
          .order('company_id'),
      eligibility: () =>
        supabase
          .from('company_programs')
          .select('*,category:categories(name)')
          .eq('facility_id', facilityId)
          .order('company_id')
          .order('program_id'),
      activities: () =>
        supabase
          .from('daily_activities')
          .select(
            'id,facility_id,user_id,source_rep_name,company_id,territory_id,activity_date,unit_type,program_id,activity_type,type_of_contact,number_of_activities,in_person,visit_outcome,medical_director_name,updated_at',
          )
          .eq('facility_id', facilityId)
          .order('id'),
      referrals: () =>
        supabase
          .from('referrals')
          .select(
            'id,submitted_by,prospect_company_id,territory_id,referral_date,referral_unit_type,program_id,admitted_program_id,admission_status,admit_denial_date,arrival_confirmed,category_id,primary_insurance_id,denial_reason_id,updated_at',
          )
          .eq('facility_id', facilityId)
          .order('id'),
      goals: () =>
        supabase
          .from('marketing_goals')
          .select('*')
          .eq('facility_id', facilityId)
          .order('id'),
      allocations: () =>
        supabase
          .from('territory_goal_allocations')
          .select('*')
          .eq('facility_id', facilityId)
          .order('id'),
      needs: () =>
        supabase
          .from('needs_analysis_revisions')
          .select('id,submitted_by,submitted_at,source,facility_id')
          .eq('facility_id', facilityId)
          .eq('source', 'user')
          .order('id'),
      census: () =>
        supabase
          .from('census_entries')
          .select('*')
          .eq('facility_id', facilityId)
          .order('program_id')
          .order('census_date'),
      plans: () =>
        supabase
          .from('rotation_plans')
          .select('*')
          .eq('facility_id', facilityId)
          .order('id'),
      low: () =>
        supabase
          .from('low_census_windows')
          .select('*')
          .eq('facility_id', facilityId)
          .order('id'),
    }
    const unavailable = []
    const pairs = await Promise.all(
      Object.entries(defs).map(async ([k, make]) => {
        const r = await fetchAll(make)
        if (k === 'allocations' && r.error?.code === 'PGRST205') {
          unavailable.push(k)
          return [k, []]
        }
        if (r.error) throw Error(k + ': ' + r.error.message)
        return [k, r.data]
      }),
    )
    return { data: [{ ...Object.fromEntries(pairs), unavailable }] }
  }, [facilityId])
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') q.refresh()
    }, 30000)
    const f = () => q.refresh()
    window.addEventListener('focus', f)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', f)
    }
  }, [facilityId])
  return { ...q, data: q.rows[0] }
}
export function programPool(data, program, territory = '') {
  if (!data) return []
  return data.eligibility
    .filter((e) => e.program_id === program && e.active)
    .flatMap((e) => {
      const fc = data.companies.find((x) => x.company_id === e.company_id),
        c = fc?.company
      return c &&
        fc.active &&
        (!territory || fc.territory_id === territory) &&
        c.active &&
        !c.merged_into_id &&
        c.status !== 'closed'
        ? [
            {
              ...c,
              ...e,
              id: c.id,
              company_id: c.id,
              name: c.name,
              city: c.city || '',
              address_line1: c.address_line1,
              territory_id: fc.territory_id,
              prospect_status: fc.prospect_status || e.tier,
              category: categoryName(e.category?.name || c.category?.name),
            },
          ]
        : []
    })
}
