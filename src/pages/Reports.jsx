import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp, useQuery, fetchAll, today, daysAgo } from '../lib/data'
import { DataTable, Empty, Banner, Chip } from '../components/ui'
import { fmtDate, personName } from '../lib/format'
import { downloadCsv } from '../lib/csv'

export default function Reports() {
  const { facilityId, lookups } = useApp()
  const [which, setWhich] = useState('productivity')
  const [from, setFrom] = useState(daysAgo(30))
  const [to, setTo] = useState(today())
  const [preset, setPreset] = useState(30)
  const [unit, setUnit] = useState('')
  const [rep, setRep] = useState('')
  const setRange = (n) => { setFrom(daysAgo(n)); setTo(today()); setPreset(n) }
  const UNIT_OPTS = [['Inpatient Geri', 'Geri'], ['Inpatient Adol', 'Adol'], ['Inpatient Adult', 'Adult'], ['IOP', 'IOP']]

  const nameOf = (uid) => personName((lookups.users ?? []).find((u) => u.id === uid))
  // Contacts are not usernames, so shown as stored (not forced caps).
  const contactOf = (c) => c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() : ''
  // Rep label: the linked user's name (caps, via personName) or, for imported
  // rows with no login, the stored rep name in caps. personName returns '—' for
  // a null user, so branch on the user existing rather than relying on ||.
  const repName = (person, src) => person ? personName(person) : (src ? src.toUpperCase() : '')
  // Booleans export as Yes/No; null (never answered) stays blank.
  const yn = (v) => v === true ? 'Yes' : v === false ? 'No' : ''

  // Rep productivity comes off the revision ledger: one row per save,
  // whether that save created an analysis or edited one.
  const prod = useQuery(() => which !== 'productivity' ? null
    : fetchAll(() => supabase.from('needs_analysis_revisions')
        .select('submitted_by, is_initial, submitted_at, source, id')
        .eq('source', 'user')
        .gte('submitted_at', from).lte('submitted_at', to + 'T23:59:59')
        .order('id')), [which, from, to])

  const acts = useQuery(() => which !== 'activities' || !facilityId ? null
    : fetchAll(() => supabase.from('daily_activities')
        .select(`*, user:profiles(first_name,last_name), company:companies(name),
                 territory:territories(name), stage:service_cycle_stages(short_label),
                 contact:contacts!contact_id(first_name,last_name)`)
        .eq('facility_id', facilityId)
        .gte('activity_date', from).lte('activity_date', to)
        .order('activity_date', { ascending: false }).order('id')),
    [which, facilityId, from, to])

  const refs = useQuery(() => which !== 'referrals' || !facilityId ? null
    : fetchAll(() => {
        let q = supabase.from('referrals')
          .select(`*, submitter:profiles(first_name,last_name), company:companies(name),
                   territory:territories(name), denial:denial_reasons(name),
                   contact:contacts!referral_contact_id(first_name,last_name),
                   category:categories(name), subcat:subcategories(name),
                   prescreen:prescreen_locations(name),
                   pins:payer_sources!primary_insurance_id(name),
                   sins:payer_sources!secondary_insurance_id(name)`)
          .eq('facility_id', facilityId)
          .gte('referral_date', from).lte('referral_date', to)
        if (unit) q = q.eq('referral_unit_type', unit)
        return q.order('referral_date', { ascending: false }).order('id')
      }),
    [which, facilityId, from, to, unit])

  const prodRows = (() => {
    const by = {}
    for (const r of prod.rows) {
      const k = r.submitted_by
      by[k] = by[k] ?? { submitted_by: k, new_analyses: 0, updates: 0, total: 0 }
      if (r.is_initial) by[k].new_analyses++; else by[k].updates++
      by[k].total++
    }
    return Object.values(by).sort((a, b) => b.total - a.total)
  })()

  const UNIT_SHORT = { 'Inpatient Geri': 'Geri', 'Inpatient Adol': 'Adol', 'Inpatient Adult': 'Adult', IOP: 'IOP' }
  const unitLabel = (r) => {
    const u = UNIT_SHORT[r.referral_unit_type] ?? r.referral_unit_type ?? ''
    return u && r.notes?.includes('Unit inferred') ? `${u} (inferred)` : u
  }

  const defs = {
    productivity: {
      label: 'Needs analysis by rep',
      blurb: 'Counts every save — a new analysis and an edit each count as one submission.',
      state: prod, rows: prodRows, file: 'needs-analysis-by-rep',
      repOf: (r) => nameOf(r.submitted_by),
      columns: [
        { key: 'rep', label: 'Rep', csv: (r) => nameOf(r.submitted_by),
          sortValue: (r) => nameOf(r.submitted_by),
          render: (r) => nameOf(r.submitted_by) },
        { key: 'new_analyses', label: 'New', align: 'right' },
        { key: 'updates', label: 'Updates', align: 'right' },
        { key: 'total', label: 'Total submissions', align: 'right' },
      ],
    },
    activities: {
      label: 'Activity log',
      blurb: 'Every logged touch for this campus.',
      state: acts, rows: acts.rows, file: 'activity-log',
      repOf: (r) => repName(r.user, r.source_rep_name),
      // The on-screen table stays curated; the CSV carries every field.
      csvColumns: [
        { label: 'Date', csv: (r) => fmtDate(r.activity_date) },
        { label: 'Time', csv: (r) => r.time_of_activity ?? '' },
        { label: 'Company', csv: (r) => r.company?.name },
        { label: 'Contact', csv: (r) => contactOf(r.contact) },
        { label: 'Territory', csv: (r) => r.territory?.name },
        { label: 'Activity', csv: (r) => r.activity_type },
        { label: 'Contact type', csv: (r) => r.type_of_contact },
        { label: 'Unit', csv: (r) => r.unit_type },
        { label: 'Stage', csv: (r) => r.stage?.short_label },
        { label: 'Touches', csv: (r) => r.number_of_activities },
        { label: 'Medical director', csv: (r) => r.medical_director_name },
        { label: 'Decision maker', csv: (r) => r.decision_maker_name },
        { label: 'Next visit scheduled', csv: (r) => yn(r.scheduled_next_visit) },
        { label: 'Next visit date', csv: (r) => r.next_visit_date ? fmtDate(r.next_visit_date) : '' },
        { label: 'Visit outcome', csv: (r) => r.visit_outcome },
        { label: 'In person', csv: (r) => yn(r.in_person) },
        { label: 'Notes', csv: (r) => r.activity_information },
        { label: 'Rep', csv: (r) => repName(r.user, r.source_rep_name) },
        { label: 'Entry date', csv: (r) => r.created_at ? fmtDate(r.created_at.slice(0, 10)) : '' },
      ],
      columns: [
        { key: 'activity_date', label: 'Date', render: (r) => fmtDate(r.activity_date) },
        { key: 'company', label: 'Company', csv: (r) => r.company?.name,
          sortValue: (r) => r.company?.name ?? '',
          render: (r) => r.company?.name ?? '—' },
        { key: 'contact', label: 'Contact', csv: (r) => contactOf(r.contact),
          sortValue: (r) => contactOf(r.contact),
          render: (r) => contactOf(r.contact) || '—' },
        { key: 'territory', label: 'Territory', csv: (r) => r.territory?.name,
          sortValue: (r) => r.territory?.name ?? '',
          render: (r) => r.territory?.name ?? '—' },
        { key: 'activity_type', label: 'Activity' },
        { key: 'type_of_contact', label: 'Contact type' },
        { key: 'stage', label: 'Stage', csv: (r) => r.stage?.short_label,
          sortValue: (r) => r.stage?.short_label ?? '',
          render: (r) => r.stage?.short_label ?? '—' },
        { key: 'number_of_activities', label: 'Touches', align: 'right' },
        { key: 'user', label: 'Rep', csv: (r) => repName(r.user, r.source_rep_name),
          sortValue: (r) => repName(r.user, r.source_rep_name),
          render: (r) => repName(r.user, r.source_rep_name) || '—' },
        { key: 'activity_information', label: 'Notes' },
      ],
    },
    referrals: {
      label: 'Referral log',
      blurb: 'Referrals with outcome and denial reason.',
      state: refs, rows: refs.rows, file: 'referral-log',
      repOf: (r) => repName(r.submitter, r.source_rep_name),
      // The on-screen table stays curated; the CSV carries every field.
      csvColumns: [
        { label: 'Date', csv: (r) => fmtDate(r.referral_date) },
        { label: 'Time', csv: (r) => r.time_of_submission ?? '' },
        { label: 'Patient', csv: (r) => `${r.patient_first_name ?? ''} ${r.patient_last_initial ?? ''}`.trim() },
        { label: 'Referred by', csv: (r) => r.company?.name },
        { label: 'Contact', csv: (r) => contactOf(r.contact) || r.referral_contact_name },
        { label: 'Territory', csv: (r) => r.territory?.name },
        { label: 'Category', csv: (r) => r.category?.name },
        { label: 'Subcategory', csv: (r) => r.subcat?.name },
        { label: 'Unit referred', csv: unitLabel },
        { label: 'Primary insurance', csv: (r) => r.pins?.name },
        { label: 'Primary insurance (other)', csv: (r) => r.primary_insurance_other },
        { label: 'Secondary insurance', csv: (r) => r.sins?.name },
        { label: 'Secondary insurance (other)', csv: (r) => r.secondary_insurance_other },
        { label: 'Prescreening performed', csv: (r) => yn(r.prescreening_performed) },
        { label: 'Prescreen location', csv: (r) => r.prescreen?.name },
        { label: 'Outcome', csv: (r) => r.admission_status ?? 'Not decided' },
        { label: 'Denial reason', csv: (r) => r.denial?.name },
        { label: 'Decision date', csv: (r) => r.admit_denial_date ? fmtDate(r.admit_denial_date) : '' },
        { label: 'Arrival confirmed', csv: (r) => yn(r.arrival_confirmed) },
        { label: 'Notes', csv: (r) => r.notes },
        { label: 'Rep', csv: (r) => repName(r.submitter, r.source_rep_name) },
        { label: 'Entry date', csv: (r) => r.created_at ? fmtDate(r.created_at.slice(0, 10)) : '' },
      ],
      columns: [
        { key: 'referral_date', label: 'Date', render: (r) => fmtDate(r.referral_date) },
        { key: 'patient', label: 'Patient',
          csv: (r) => `${r.patient_first_name ?? ''} ${r.patient_last_initial ?? ''}`,
          sortValue: (r) => `${r.patient_first_name ?? ''} ${r.patient_last_initial ?? ''}`.trim(),
          render: (r) => `${r.patient_first_name ?? '?'} ${r.patient_last_initial ?? '?'}.` },
        { key: 'company', label: 'Referred by', csv: (r) => r.company?.name,
          sortValue: (r) => r.company?.name ?? '',
          render: (r) => r.company?.name ?? '—' },
        { key: 'contact', label: 'Contact',
          csv: (r) => contactOf(r.contact) || r.referral_contact_name,
          sortValue: (r) => contactOf(r.contact) || r.referral_contact_name || '',
          render: (r) => contactOf(r.contact) || r.referral_contact_name || '—' },
        { key: 'territory', label: 'Territory', csv: (r) => r.territory?.name,
          sortValue: (r) => r.territory?.name ?? '',
          render: (r) => r.territory?.name ?? '—' },
        { key: 'unit', label: 'Unit referred', csv: unitLabel,
          sortValue: (r) => unitLabel(r),
          render: (r) => unitLabel(r) || '—' },
        { key: 'admission_status', label: 'Outcome',
          sortValue: (r) => r.admission_status ?? '',
          render: (r) => r.admission_status ?? 'Not decided' },
        { key: 'denial', label: 'Denial reason', csv: (r) => r.denial?.name,
          sortValue: (r) => r.denial?.name ?? '',
          render: (r) => r.denial?.name ?? '—' },
        { key: 'admit_denial_date', label: 'Decision date',
          render: (r) => r.admit_denial_date ? fmtDate(r.admit_denial_date) : '—' },
        { key: 'submitter', label: 'Rep', csv: (r) => repName(r.submitter, r.source_rep_name),
          sortValue: (r) => repName(r.submitter, r.source_rep_name),
          render: (r) => repName(r.submitter, r.source_rep_name) || '—' },
      ],
    },
  }

  const d = defs[which]
  // Username filter: options come from the current view's rows; the rows the
  // table, CSV and count all use are filtered by the chosen user.
  const repOptions = [...new Set(d.rows.map(d.repOf))].filter(Boolean).sort()
  const rows = rep ? d.rows.filter((r) => d.repOf(r) === rep) : d.rows

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p>Filter, check it on screen, then take it to Excel.</p>
        </div>
        <div className="row-actions">
          <button className="btn" type="button" onClick={() => window.print()}>Print</button>
          <button className="btn btn-primary" type="button" disabled={!rows.length}
                  onClick={() => downloadCsv(`${d.file}-${from}-to-${to}.csv`, d.csvColumns ?? d.columns, rows)}>
            Download CSV
          </button>
        </div>
      </div>

      <div className="toolbar">
        <select value={which} onChange={(e) => { setWhich(e.target.value); setRep('') }}>
          {Object.entries(defs).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}
        </select>
        {[7, 30, 90].map((n) => (
          <button key={n} type="button"
                  className={'btn btn-sm' + (preset === n ? ' btn-primary' : '')}
                  onClick={() => setRange(n)}>{n} days</button>
        ))}
        <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreset(null) }} aria-label="From" />
        <span style={{ color: '#7d8fa1' }}>to</span>
        <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreset(null) }} aria-label="To" />
        {which === 'referrals' && (
          <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit referred">
            <option value="">All units</option>
            {UNIT_OPTS.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
          </select>
        )}
        <select value={rep} onChange={(e) => setRep(e.target.value)} aria-label="Username">
          <option value="">All users</option>
          {repOptions.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <div className="spacer" />
        <span className="mono" style={{ color: '#7d8fa1', fontSize: 12 }}>
          {d.state.loading ? '' : `${rows.length} rows`}
        </span>
      </div>

      <Banner kind="info">{d.blurb}</Banner>

      <div className="card">
        <DataTable columns={d.columns} rows={rows}
          loading={d.state.loading} error={d.state.error}
          empty={<Empty title="Nothing to report yet"
                        body="No records fall inside these filters." />} />
      </div>
    </>
  )
}
