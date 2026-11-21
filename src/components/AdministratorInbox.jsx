import { Link } from 'react-router-dom'
import { useApp, useQuery, fetchAll } from '../lib/data'
import { supabase } from '../lib/supabase'
import { Banner, DataTable } from './ui'
export default function AdministratorInbox() {
  const app = useApp()
  const q = useQuery(async () => {
    if (!app.isManager) return { data: [] }
    const definitions = {
      conflicts: () =>
        supabase
          .from('verification_flags')
          .select(
            'id,kind,company:companies!verification_flags_company_id_fkey(name),submitter_initials,submitted_at',
          )
          .eq('facility_id', app.facilityId)
          .eq('status', 'submitted')
          .order('id'),
      prospects: () =>
        supabase
          .from('prospect_import_rows')
          .select(
            'id,record,source_name,row_number,submitter_initials,submitted_at,program:facility_programs(name)',
          )
          .eq('facility_id', app.facilityId)
          .eq('status', 'submitted')
          .order('id'),
      expenses: () =>
        supabase
          .from('expense_submissions')
          .select(
            'id,week_start,submitted_at,account:expense_accounts!inner(facility_id,user_id)',
          )
          .eq('account.facility_id', app.facilityId)
          .is('approved_at', null)
          .order('id'),
      reports: () =>
        supabase
          .from('report_reviews')
          .select('id,starts,ends,sdd_initials,submitted_at')
          .eq('facility_id', app.facilityId)
          .is('approved_at', null)
          .order('id'),
      census: () =>
        supabase
          .from('low_census_windows')
          .select('id,starts,ends,reason,program:facility_programs(name)')
          .eq('facility_id', app.facilityId)
          .is('approved_by', null)
          .order('id'),
    }
    const entries = await Promise.all(
      Object.entries(definitions).map(async ([key, build]) => [
        key,
        await fetchAll(build),
      ]),
    )
    return {
      data: [Object.fromEntries(entries.map(([k, v]) => [k, v.data || []]))],
      error: entries.find(([, v]) => v.error)?.[1].error,
    }
  }, [app.facilityId, app.isManager])
  if (!app.isManager) return null
  const d = q.rows[0] || {},
    items = [
      ...(d.conflicts || []).map((r) => ({
        id: r.id,
        kind: 'Company correction',
        item: r.company?.name,
        source: r.kind,
        initials: r.submitter_initials,
        date: r.submitted_at,
        to: '/verification?row=' + r.id,
      })),
      ...(d.prospects || []).map((r) => ({
        id: r.id,
        kind: 'Prospectus correction',
        item: r.record.name,
        source:
          r.program?.name + ' · ' + r.source_name + ' · row ' + r.row_number,
        initials: r.submitter_initials,
        date: r.submitted_at,
        to: '/verification?section=imports&row=' + r.id,
      })),
      ...(d.expenses || []).map((r) => ({
        id: r.id,
        kind: 'Expense report',
        item: 'Week of ' + r.week_start,
        source: 'Expense approval and receipts',
        date: r.submitted_at,
        to:
          '/weekly-expenses?user=' +
          r.account?.user_id +
          '&week=' +
          r.week_start,
      })),
      ...(d.reports || []).map((r) => ({
        id: r.id,
        kind: 'Team touch review',
        item: r.starts + ' through ' + r.ends,
        source: 'Review below',
        initials: r.sdd_initials,
        date: r.submitted_at,
        to: '#team-review',
      })),
      ...(d.census || []).map((r) => ({
        id: r.id,
        kind: 'Low census request',
        item: r.program?.name,
        source: r.starts + ' through ' + r.ends + ' · ' + r.reason,
        to: '/rotation-schedules',
      })),
    ]
  return (
    <section className="card card-body">
      <h2>Administrator approval inbox</h2>
      <p>
        Submitted corrections, expense reports, team reviews and low-census
        requests for {app.facility?.name}. Open an item to verify and sign it in
        its original workflow.
      </p>
      <button className="btn" onClick={() => q.refresh()}>
        Refresh approval inbox
      </button>
      <Banner kind="error">{q.error}</Banner>
      <DataTable
        loading={q.loading}
        rows={items}
        columns={[
          { key: 'kind', label: 'Approval type' },
          { key: 'item', label: 'Item' },
          { key: 'source', label: 'Location / details' },
          { key: 'initials', label: 'Submitted initials' },
          { key: 'date', label: 'Submitted at' },
          {
            key: 'review',
            label: 'Review',
            render: (r) =>
              r.to.startsWith('#') ? (
                <a href={r.to}>Review below</a>
              ) : (
                <Link to={r.to}>Open for administrator review</Link>
              ),
          },
        ]}
      />
    </section>
  )
}
