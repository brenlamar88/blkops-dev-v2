import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useApp, useQuery, fetchAll, today } from '../lib/data'
import { Banner, Loading, TerritoryChip } from './ui'
import { MiniPanel, NoData } from './charts'
import { fmtDate } from '../lib/format'
import { downloadCsv } from '../lib/csv'

/* ------------------------------------------------------------------
   M.I.S. visit report — every daily activity logged with Type of Contact
   "Missing in Service (M.I.S.) Visit", for the selected campus and date
   range. Shows how M.I.S. compares with every other type of contact, then
   breaks the M.I.S. visits down by activity type, rep, service-cycle stage
   and unit, and lists each visit. Has its own Print and CSV so it can be
   handed out without the cold-sources worklist underneath it.

   Scoped to facilityId like every transactional view.
------------------------------------------------------------------ */

export const MIS_CONTACT = 'Missing in Service (M.I.S.) Visit'
const PER_PAGE = 12   // the visit list is paged to keep it short on screen

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const PRESETS = [
  ['month', 'This month', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), 1)), today()] }],
  ['last-month', 'Last month', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), iso(new Date(n.getFullYear(), n.getMonth(), 0))] }],
  ['90', 'Last 90 days', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 89)), today()] }],
  ['ytd', 'Year to date', () => [iso(new Date(new Date().getFullYear(), 0, 1)), today()]],
]

const repOf = (person, fallback) => {
  const n = person ? [person.first_name, person.last_name].filter(Boolean).join(' ') : ''
  return (n || fallback || 'Unknown').toUpperCase()
}
const contactOf = (c) => c ? [c.first_name, c.last_name].filter(Boolean).join(' ').trim() : ''

const countBy = (rows, keyFn) => {
  const m = new Map()
  for (const r of rows) { const k = keyFn(r) || 'Not set'; m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)
}

const pct = (n, d) => d ? `${(Math.round((1000 * n) / d) / 10).toFixed(1)}%` : '—'

function CountTable({ title, keyLabel, rows, total, highlight }) {
  return (
    <MiniPanel title={title}>
      {rows.length ? (
        <table className="mini">
          <thead><tr><th>{keyLabel}</th><th className="num">Count</th><th className="num">Share</th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.label} className={highlight && highlight === d.label ? 'mis-hl' : undefined}>
                <td>{d.label}</td><td className="num">{d.value}</td><td className="num">{pct(d.value, total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <NoData />}
    </MiniPanel>
  )
}

const Stat = ({ label, value, sub }) => (
  <div className="stat">
    <span className="l">{label}</span>
    <span className="n">{value}</span>
    {sub && <span className="mis-stat-sub">{sub}</span>}
  </div>
)

// Print just this report: hide the rest of the page for the print, then restore.
function printSection(cls) {
  document.body.classList.add(cls)
  const done = () => { document.body.classList.remove(cls); window.removeEventListener('afterprint', done) }
  window.addEventListener('afterprint', done)
  window.print()
  setTimeout(done, 1000)
}

export default function MisVisitReport() {
  const { facilityId, facility, lookups } = useApp()
  const [[from, to], setRange] = useState(PRESETS[0][2])
  const [preset, setPreset] = useState('month')
  const pick = (key, fn) => { setRange(fn()); setPreset(key) }
  const setFrom = (v) => { if (v) { setRange([v, to]); setPreset(null) } }
  const setTo = (v) => { if (v) { setRange([from, v]); setPreset(null) } }

  const terrName = useMemo(() => {
    const m = {}; for (const t of lookups.territories ?? []) m[t.id] = t.name; return m
  }, [lookups.territories])

  // Every activity in range — only its type of contact, for the comparison.
  const allQ = useQuery(() => facilityId ? fetchAll(() => supabase.from('daily_activities')
    .select('id, type_of_contact')
    .eq('facility_id', facilityId)
    .gte('activity_date', from).lte('activity_date', to)
    .order('id')) : null, [facilityId, from, to])

  // The M.I.S. visits themselves, with what the list and breakdowns show.
  const misQ = useQuery(() => facilityId ? fetchAll(() => supabase.from('daily_activities')
    .select(`id, activity_date, activity_type, unit_type, territory_id, next_visit_date, source_rep_name,
             user:profiles(first_name,last_name), company:companies(id,name,city),
             contact:contacts(first_name,last_name), stage:service_cycle_stages(short_label,rank)`)
    .eq('facility_id', facilityId)
    .eq('type_of_contact', MIS_CONTACT)
    .gte('activity_date', from).lte('activity_date', to)
    .order('activity_date', { ascending: false }).order('id')) : null, [facilityId, from, to])

  const visits = useMemo(() => misQ.rows.map((r) => ({
    id: r.id, date: r.activity_date, rep: repOf(r.user, r.source_rep_name),
    territory: terrName[r.territory_id] ?? '', companyId: r.company?.id, company: r.company?.name ?? '',
    city: r.company?.city ?? '', contact: contactOf(r.contact), activity: r.activity_type ?? '',
    unit: r.unit_type ?? '', stage: r.stage?.short_label ?? '', nextVisit: r.next_visit_date ?? '',
  })), [misQ.rows, terrName])

  const total = allQ.rows.length
  const byContact = useMemo(() => countBy(allQ.rows, (r) => r.type_of_contact), [allQ.rows])
  const byActivity = useMemo(() => countBy(visits, (v) => v.activity), [visits])
  const byRep = useMemo(() => countBy(visits, (v) => v.rep), [visits])
  const byStage = useMemo(() => countBy(visits, (v) => v.stage), [visits])
  const byUnit = useMemo(() => countBy(visits, (v) => v.unit), [visits])
  const companies = useMemo(() => new Set(visits.map((v) => v.companyId).filter(Boolean)).size, [visits])

  const loading = allQ.loading || misQ.loading
  const err = allQ.error || misQ.error

  // Page the visit list, 12 at a time; reset to page 1 on any campus/range
  // change. Off-page rows are hidden with a class (not sliced) so Print and the
  // CSV still carry every visit.
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [facilityId, from, to])
  const pageCount = Math.max(1, Math.ceil(visits.length / PER_PAGE))
  const safePage = Math.min(page, pageCount)
  const start = (safePage - 1) * PER_PAGE
  const pgHidden = (i) => i < start || i >= start + PER_PAGE

  const exportCsv = () => {
    const columns = [
      { key: 'date', label: 'Date' }, { key: 'rep', label: 'Rep' }, { key: 'territory', label: 'Territory' },
      { key: 'company', label: 'Referral source' }, { key: 'city', label: 'City' }, { key: 'contact', label: 'Contact' },
      { key: 'activity', label: 'Activity type' }, { key: 'unit', label: 'Unit' },
      { key: 'stage', label: 'Service cycle stage' }, { key: 'nextVisit', label: 'Next visit' },
    ]
    downloadCsv(`mis-visits-${facility?.slug ?? 'campus'}-${from}-to-${to}.csv`, columns, visits)
  }

  return (
    <section className="mis-report">
      <div className="mis-section-head">
        <div>
          <h2>M.I.S. Visits</h2>
          <p>{facility?.name ?? 'No campus'} — activities logged with Type of Contact
             “Missing in Service (M.I.S.) Visit”.</p>
          <p className="print-only">Date range: {fmtDate(from)} – {fmtDate(to)}</p>
        </div>
        <div className="row-actions">
          <button className="btn" type="button" onClick={() => printSection('print-mis-report')}>Print</button>
          <button className="btn btn-primary" type="button" disabled={!visits.length}
                  onClick={exportCsv}>Download CSV</button>
        </div>
      </div>

      <div className="toolbar">
        {PRESETS.map(([key, label, fn]) => (
          <button key={key} type="button" className={'btn btn-sm' + (preset === key ? ' btn-primary' : '')}
                  onClick={() => pick(key, fn)}>{label}</button>
        ))}
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <span style={{ color: 'var(--ink-3)' }}>to</span>
        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <div className="spacer" />
        <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 12 }}>
          {loading ? '' : `${visits.length} M.I.S. ${visits.length === 1 ? 'visit' : 'visits'} · ${fmtDate(from)} – ${fmtDate(to)}`}
        </span>
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      {loading ? <Loading rows={6} /> : (
        <>
          <div className="mis-stats">
            <Stat label="M.I.S. visits" value={visits.length} />
            <Stat label="Share of all activity" value={pct(visits.length, total)} sub={`of ${total} activities logged`} />
            <Stat label="Reps logging M.I.S." value={byRep.length} />
            <Stat label="Referral sources visited" value={companies} />
          </div>

          <div className="dash-grid mis-grid">
            <CountTable title="All activity by type of contact" keyLabel="Type of contact"
                        rows={byContact} total={total} highlight={MIS_CONTACT} />
            <CountTable title="M.I.S. by activity type" keyLabel="Activity type" rows={byActivity} total={visits.length} />
            <CountTable title="M.I.S. by rep" keyLabel="Rep" rows={byRep} total={visits.length} />
            <CountTable title="M.I.S. by service cycle stage" keyLabel="Stage" rows={byStage} total={visits.length} />
            <CountTable title="M.I.S. by unit" keyLabel="Unit" rows={byUnit} total={visits.length} />
          </div>

          <div className="card">
            <div className="card-head"><h2>Every M.I.S. visit</h2></div>
            {visits.length ? (
              <div className="matrix-scroll">
                <table className="pivot scorecard">
                  <thead>
                    <tr>
                      <th>Date</th><th>Rep</th><th>Territory</th><th>Referral source</th><th>Contact</th>
                      <th>Activity type</th><th>Unit</th><th>Stage</th><th>Next visit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visits.map((v, i) => (
                      <tr key={v.id} className={pgHidden(i) ? 'pg-hide' : undefined}>
                        <td>{fmtDate(v.date)}</td>
                        <td>{v.rep}</td>
                        <td>{v.territory ? <TerritoryChip name={v.territory} /> : '—'}</td>
                        <td>{v.companyId ? <Link to={`/companies/${v.companyId}`}>{v.company}</Link> : (v.company || '—')}</td>
                        <td>{v.contact || '—'}</td>
                        <td>{v.activity || '—'}</td>
                        <td>{v.unit || '—'}</td>
                        <td>{v.stage || '—'}</td>
                        <td>{v.nextVisit ? fmtDate(v.nextVisit) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <NoData />}
            {pageCount > 1 && (
              <div className="pager">
                <button className="btn btn-sm" type="button" disabled={safePage <= 1}
                        onClick={() => setPage(safePage - 1)}>‹ Prev</button>
                <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                  {start + 1}–{Math.min(start + PER_PAGE, visits.length)} of {visits.length} · page {safePage}/{pageCount}
                </span>
                <button className="btn btn-sm" type="button" disabled={safePage >= pageCount}
                        onClick={() => setPage(safePage + 1)}>Next ›</button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}

export { printSection }
