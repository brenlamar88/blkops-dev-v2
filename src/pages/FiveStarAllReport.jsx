import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp, useQuery } from '../lib/data'
import { Banner, Empty, Loading } from '../components/ui'
import { downloadCsv } from '../lib/csv'

/* ------------------------------------------------------------------
   Five-star survey report — all facilities, admins only.

   A port of the FBH support "5 Star Survey by facility" report onto Black Ops'
   five_star_submissions. Ordinary members only read their own campuses (RLS),
   so this reads through the five_star_report() SECURITY DEFINER function, which
   returns org-wide summary rows ONLY to org admins — a non-admin gets nothing.

   Per the source report:
   - Average rating: mean of a survey's answered 1-5 questions, then averaged
     across surveys. Unrated surveys are counted but not averaged.
   - Low-score survey: any question on it rated 1 or 2. Low-score % is of rated.
   - Weeks start Monday, labelled by that Monday.
------------------------------------------------------------------ */

const ALL = 'All facilities'
const COLOR = '#185FA5', BAD = '#A32D2D'
const METRIC = { surveys: 'Survey count', avg: 'Average rating', low: 'Low-score surveys' }
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December']

const utc = (s) => new Date(s + 'T00:00:00Z')
const iso = (d) => d.toISOString().slice(0, 10)
const mondayOf = (s) => { const d = utc(s); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d) }
const fmtInt = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'))
const fmt2 = (n) => (n == null ? '' : Number(n).toFixed(2))
const fmtVal = (m, v) => (v == null ? '' : m === 'avg' ? fmt2(v) : fmtInt(v))
const niceDate = (s) => { const d = utc(s); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear() }
const label = (g, p) => {
  if (g === 'year') return p
  if (g === 'month') return MON[+p.slice(5, 7) - 1] + " '" + p.slice(2, 4)
  const d = utc(p); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + p.slice(2, 4)
}
const longLabel = (g, p) => {
  if (g === 'year') return p
  if (g === 'month') return MONL[+p.slice(5, 7) - 1] + ' ' + p.slice(0, 4)
  const d = utc(p); return 'Week of ' + MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + p.slice(0, 4)
}

const bucket = () => ({ surveys: 0, scored: 0, sum: 0, low: 0, referral: 0, discharge: 0, admission: 0, unspecified: 0 })
const add = (b, r) => {
  b.surveys++
  if (r.avg_score != null) { b.scored++; b.sum += r.avg_score }
  if (r.low_flag) b.low++
  const t = (r.survey_type || '').toLowerCase()
  if (t === 'referral' || t === 'discharge' || t === 'admission') b[t]++; else b.unspecified++
}
const fin = (b) => (b && { ...b, avg: b.scored ? b.sum / b.scored : null, lowPct: b.scored ? b.low / b.scored : null })

function aggregate(rows) {
  const keyFns = { year: (r) => r.date.slice(0, 4), month: (r) => r.date.slice(0, 7), week: (r) => mondayOf(r.date) }
  const out = { year: new Map(), month: new Map(), week: new Map(), facility: new Map(), total: bucket() }
  for (const r of rows) {
    add(out.total, r)
    for (const f of [r.facility, ALL]) {
      if (f !== ALL) { if (!out.facility.has(f)) out.facility.set(f, bucket()); add(out.facility.get(f), r) }
      for (const g of ['year', 'month', 'week']) {
        const k = f + '|' + keyFns[g](r)
        if (!out[g].has(k)) out[g].set(k, bucket())
        add(out[g].get(k), r)
      }
    }
  }
  out.facilities = [...out.facility.entries()]
    .sort((a, b) => b[1].surveys - a[1].surveys).map(([f]) => f)
  out.years = [...new Set(rows.map((r) => r.date.slice(0, 4)))].sort()
  out.first = rows.reduce((m, r) => (!m || r.date < m ? r.date : m), null)
  out.last = rows.reduce((m, r) => (!m || r.date > m ? r.date : m), null)
  return out
}

const valueOf = (b, m) => (!b ? null : m === 'surveys' ? b.surveys : m === 'low' ? b.low : b.avg)

function periodsFor(g, year, agg, rows) {
  if (g === 'year') return agg.years.slice()
  let a = agg.first, b = agg.last
  if (year !== 'all') {
    const inYear = rows.filter((r) => r.date.slice(0, 4) === year).map((r) => r.date).sort()
    if (!inYear.length) return []
    a = inYear[0]; b = inYear[inYear.length - 1]
  }
  const out = []
  if (g === 'month') {
    let y = +a.slice(0, 4), m = +a.slice(5, 7)
    const ey = +b.slice(0, 4), em = +b.slice(5, 7)
    while (y < ey || (y === ey && m <= em)) { out.push(y + '-' + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++ } }
  } else {
    const d = utc(mondayOf(a)), end = utc(mondayOf(b))
    while (d <= end) { out.push(iso(d)); d.setUTCDate(d.getUTCDate() + 7) }
  }
  return out
}

/* Responsive SVG trend chart (fixed internal coordinate space, scaled to width).
   Line for average rating, bars for counts. Native <title> tooltips per point. */
function TrendChart({ grain, metric, periods, cellFor }) {
  const W = 820, H = 260, mt = 12, mb = 28, ml = 46, mr = 8
  if (!periods.length) return <Empty title="Nothing to chart" body="Widen the year or pick another facility." />
  const vals = periods.map((p) => { const b = cellFor(p); return { p, b, v: valueOf(b, metric) } })
  const nums = vals.map((d) => d.v).filter((v) => v != null)
  let lo = 0, hi = Math.max(1, ...nums, 1)
  if (metric === 'avg') { lo = Math.min(3, Math.floor(Math.min(...(nums.length ? nums : [5]), 3))); hi = 5 }
  else { const step = Math.pow(10, Math.floor(Math.log10(hi))) / 2 || 0.5; hi = Math.ceil(hi / step) * step }
  const y = (v) => mt + (H - mb - mt) * (1 - (v - lo) / (hi - lo || 1))
  const step = (W - ml - mr) / periods.length
  const bw = Math.min(34, step * 0.72)
  const xc = (i) => ml + step * i + step / 2
  const ticks = []; for (let i = 0; i <= 4; i++) ticks.push(lo + (hi - lo) * i / 4)
  const tf = (t) => (metric === 'avg' ? t.toFixed(1) : (Number.isInteger(t) ? fmtInt(t) : ''))
  const every = Math.max(1, Math.ceil(periods.length / 14))
  const tip = (d) => `${longLabel(grain, d.p)}\nSurveys: ${fmtInt(d.b ? d.b.surveys : 0)}`
    + `\nAvg rating: ${d.b && d.b.avg != null ? fmt2(d.b.avg) : '—'}`
    + `\nLow-score: ${fmtInt(d.b ? d.b.low : 0)}`

  let linePath = '', pen = false
  if (metric === 'avg') vals.forEach((d, i) => { if (d.v == null) { pen = false; return } linePath += (pen ? 'L' : 'M') + xc(i) + ',' + y(d.v); pen = true })

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }} role="img" aria-label="Trend chart">
      {ticks.map((t, i) => tf(t) && (
        <g key={i}>
          <line x1={ml} x2={W - mr} y1={y(t)} y2={y(t)} stroke="var(--rule, #eee)" />
          <text x={ml - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--ink-3, #888)">{tf(t)}</text>
        </g>
      ))}
      <line x1={ml} x2={W - mr} y1={y(lo)} y2={y(lo)} stroke="var(--rule, #ccc)" />
      {metric === 'avg' ? (
        <>
          <path d={linePath} fill="none" stroke={COLOR} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          {vals.map((d, i) => d.v != null && (
            <circle key={i} cx={xc(i)} cy={y(d.v)} r="3.5" fill={d.v < 4 ? BAD : COLOR}><title>{tip(d)}</title></circle>
          ))}
        </>
      ) : (
        vals.map((d, i) => d.v ? (
          <rect key={i} x={xc(i) - bw / 2} width={bw} y={y(d.v)} height={y(0) - y(d.v)}
                rx={Math.min(4, bw / 2)} fill={metric === 'low' ? BAD : COLOR}><title>{tip(d)}</title></rect>
        ) : null)
      )}
      {periods.map((p, i) => ((periods.length - 1 - i) % every ? null : (
        <text key={p} x={xc(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--ink-3, #888)">{label(grain, p)}</text>
      )))}
    </svg>
  )
}

export default function FiveStarAllReport() {
  const { memberships } = useApp()
  const isOrgAdmin = (memberships ?? []).some((m) => m.role === 'admin')

  const { rows: raw, loading, error } = useQuery(
    () => (isOrgAdmin ? supabase.rpc('five_star_report') : null),
    [isOrgAdmin],
  )
  const rows = useMemo(
    () => (raw ?? []).map((r) => ({
      ...r,
      date: String(r.submitted_on).slice(0, 10),
      avg_score: r.avg_score == null ? null : Number(r.avg_score),
      low_flag: !!r.low_flag,
    })),
    [raw],
  )

  const [grain, setGrain] = useState('month')
  const [metric, setMetric] = useState('surveys')
  const [year, setYear] = useState('')
  const [facility, setFacility] = useState(ALL)

  const agg = useMemo(() => (rows.length ? aggregate(rows) : null), [rows])
  const activeYear = !agg ? '' : (year && agg.years.includes(year) ? year : agg.years[agg.years.length - 1])
  const yr = grain === 'year' ? 'all' : activeYear
  const periods = useMemo(() => (agg ? periodsFor(grain, yr, agg, rows) : []), [agg, grain, yr, rows])
  const cellFor = (f) => (p) => fin(agg[grain].get(f + '|' + p))

  if (!isOrgAdmin) {
    return (
      <>
        <div className="page-head"><div><h1>Five-star report — all facilities</h1></div></div>
        <Empty title="Admins only"
               body="The all-facility five-star report is available to organization admins. Your campus-level results are on the Five-star surveys screen." />
      </>
    )
  }

  const T = agg && fin(agg.total)
  const named = agg ? agg.facilities : []
  const top = named[0]
  const best = agg && named.map((f) => [f, fin(agg.facility.get(f))])
    .filter(([, b]) => b.scored >= 15).sort((a, b) => b[1].avg - a[1].avg)[0]
  const span = yr === 'all' ? 'all years' : yr

  const exportCsv = () => {
    const out = [...agg.facilities, ALL].map((f) => {
      const b = fin(f === ALL ? agg.total : agg.facility.get(f))
      return {
        facility: f, surveys: b.surveys, avg: b.avg == null ? '' : b.avg.toFixed(2),
        low: b.low, lowpct: b.lowPct == null ? '' : (b.lowPct * 100).toFixed(1) + '%',
        referral: b.referral, discharge: b.discharge, admission: b.admission, notype: b.unspecified,
      }
    })
    downloadCsv(`five-star-by-facility-${iso(new Date())}.csv`, [
      { key: 'facility', label: 'Facility' }, { key: 'surveys', label: 'Surveys' },
      { key: 'avg', label: 'Avg rating' }, { key: 'low', label: 'Low-score' },
      { key: 'lowpct', label: 'Low-score %' }, { key: 'referral', label: 'Referral' },
      { key: 'discharge', label: 'Discharge' }, { key: 'admission', label: 'Admission' },
      { key: 'notype', label: 'No type' },
    ], out)
  }

  const avgClass = (v) => (v == null ? '' : v < 4 ? 'fsr-bad' : v < 4.5 ? 'fsr-warn' : '')
  let heatMax = 1
  if (agg && metric !== 'avg') for (const f of agg.facilities) for (const p of periods) {
    const v = valueOf(fin(agg[grain].get(f + '|' + p)), metric); if (v != null) heatMax = Math.max(heatMax, v)
  }
  const heat = (f, v) => (f === ALL || metric === 'avg' || !v ? undefined
    : (metric === 'low' ? 'rgba(163,45,45,' : 'rgba(24,95,165,') + (0.08 + 0.42 * v / heatMax).toFixed(2) + ')')

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Five-star report — all facilities</h1>
          {T ? (
            <p className="fsr-take">
              <b>{fmtInt(T.surveys)}</b> surveys from {niceDate(agg.first)} to {niceDate(agg.last)}.
              {top && <> <b>{top}</b> has the most responses ({fmtInt(agg.facility.get(top).surveys)})</>}
              {best ? <>; <b>{best[0]}</b> rates highest at {fmt2(best[1].avg)} (facilities with 15+ rated surveys).</> : '.'}
            </p>
          ) : <p>Organization-wide patient and referral-source satisfaction, every campus.</p>}
        </div>
        <div className="row-actions">
          <button className="btn" type="button" onClick={() => window.print()}>Print</button>
          <button className="btn btn-primary" type="button" disabled={!rows.length} onClick={exportCsv}>Download CSV</button>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? <Loading rows={10} /> : !rows.length ? (
        <Empty title="No survey data yet"
               body="Responses submitted through the public survey will appear here across every campus." />
      ) : (
        <>
          <div className="kpis" style={{ marginBottom: 14 }}>
            <div className="kpi"><span className="l">Surveys · all time</span><span className="n">{fmtInt(T.surveys)}</span></div>
            <div className="kpi"><span className="l">Average rating</span><span className="n">{T.avg == null ? '—' : fmt2(T.avg)}</span></div>
            <div className="kpi"><span className="l">Low-score surveys</span><span className="n">{fmtInt(T.low)}</span>
              {T.lowPct != null && <span className="sub" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{(T.lowPct * 100).toFixed(1)}% of rated</span>}</div>
            <div className="kpi"><span className="l">Facilities reporting</span><span className="n">{fmtInt(named.length)}</span></div>
          </div>

          <div className="toolbar">
            <div className="seg">
              {['week', 'month', 'year'].map((g) => (
                <button key={g} type="button" className={grain === g ? 'on' : ''} onClick={() => setGrain(g)}>
                  {g[0].toUpperCase() + g.slice(1)}</button>
              ))}
            </div>
            <div className="seg">
              {Object.entries(METRIC).map(([k, v]) => (
                <button key={k} type="button" className={metric === k ? 'on' : ''} onClick={() => setMetric(k)}>{v}</button>
              ))}
            </div>
            <select value={grain === 'year' ? 'all' : activeYear} disabled={grain === 'year'}
                    onChange={(e) => setYear(e.target.value)} aria-label="Year">
              <option value="all">All years</option>
              {agg.years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select value={facility} onChange={(e) => setFacility(e.target.value)} aria-label="Facility">
              <option value={ALL}>{ALL}</option>
              {agg.facilities.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <h2>{{ week: 'Weekly', month: 'Monthly', year: 'Yearly' }[grain]} {METRIC[metric].toLowerCase()} · {facility} · {span}</h2>
            </div>
            <div className="card-body">
              <TrendChart grain={grain} metric={metric} periods={periods} cellFor={cellFor(facility)} />
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head"><h2>{METRIC[metric]} by facility, by {grain} · {span}</h2></div>
            <p className="note" style={{ padding: '0 14px', color: 'var(--ink-3)', fontSize: 12 }}>Click a facility to chart it.</p>
            <div className="matrix-scroll">
              <table className="pivot scorecard">
                <thead>
                  <tr>
                    <th>Facility</th>
                    <th className="num tot">{yr === 'all' ? 'All time' : yr + ' total'}</th>
                    {periods.map((p) => <th key={p} className="num" title={longLabel(grain, p)}>{label(grain, p)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[...agg.facilities, ALL].map((f) => {
                    const totB = yr === 'all' ? fin(f === ALL ? agg.total : agg.facility.get(f)) : fin(agg.year.get(f + '|' + yr))
                    const tv = valueOf(totB, metric)
                    return (
                      <tr key={f} className={f === facility ? 'sel' : ''} style={{ cursor: 'pointer' }}
                          onClick={() => setFacility(f)}>
                        <td>{f}</td>
                        <td className={'num tot ' + (metric === 'avg' ? avgClass(tv) : '')}>{fmtVal(metric, tv)}</td>
                        {periods.map((p) => {
                          const v = valueOf(fin(agg[grain].get(f + '|' + p)), metric)
                          return (
                            <td key={p} className={'num ' + (metric === 'avg' ? avgClass(v) : '')}
                                style={{ background: heat(f, v) }}>{fmtVal(metric, v)}</td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head"><h2>Facility totals · all time</h2></div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Facility</th><th className="num">Surveys</th><th className="num">Avg rating</th>
                    <th className="num">Low-score</th><th className="num">Low-score %</th>
                    <th className="num">Referral</th><th className="num">Discharge</th>
                    <th className="num">Admission</th><th className="num">No type</th>
                  </tr>
                </thead>
                <tbody>
                  {[...agg.facilities, ALL].map((f) => {
                    const b = fin(f === ALL ? agg.total : agg.facility.get(f))
                    return (
                      <tr key={f} style={f === ALL ? { fontWeight: 600 } : undefined}>
                        <td>{f}</td>
                        <td className="num">{fmtInt(b.surveys)}</td>
                        <td className={'num ' + avgClass(b.avg)}>{fmt2(b.avg)}</td>
                        <td className="num">{fmtInt(b.low)}</td>
                        <td className="num">{b.lowPct == null ? '' : (b.lowPct * 100).toFixed(1) + '%'}</td>
                        <td className="num">{fmtInt(b.referral)}</td>
                        <td className="num">{fmtInt(b.discharge)}</td>
                        <td className="num">{fmtInt(b.admission)}</td>
                        <td className="num">{fmtInt(b.unspecified)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>How these are counted</h2></div>
            <div className="card-body">
              <ul style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.7, paddingLeft: 18 }}>
                <li>Average rating: the mean of every 1–5 question answered on a survey, then averaged across surveys. Surveys with no ratings are counted but not rated.</li>
                <li>Low-score survey: any question on the survey rated 1 or 2. Low-score % is of rated surveys.</li>
                <li>Weeks start on Monday and are labelled by that Monday's date. Periods with no surveys show blank.</li>
                <li>This report spans every campus in your organization and is visible to admins only.</li>
              </ul>
            </div>
          </div>
        </>
      )}
    </>
  )
}
