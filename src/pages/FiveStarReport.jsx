import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp, useQuery, fetchAll, today, daysAgo } from '../lib/data'
import { Banner, Empty, Loading, DataTable } from '../components/ui'
import { fmtDate } from '../lib/format'
import { downloadCsv } from '../lib/csv'
import { QUESTIONS, GROUPS } from '../lib/survey'

/* ------------------------------------------------------------------
   Five-star survey report.

   Patients / referral sources submit the public satisfaction survey (the
   Jotform rebuild) with no login; the submit_five_star_survey function writes
   one `five_star_submissions` row per response. Reading is authenticated and
   campus-scoped by RLS, so this screen aggregates whatever the current campus
   has received.

   A row's `ratings` is a JSONB map of field-id → 1-5. The three survey types
   ask different questions, so the field-ids differ per type. The question text
   and the per-type groupings come from src/lib/survey.js — the same source the
   public form renders from, so labels here always match what was asked.
   `details` holds the free-text follow-ups the form collects when a rating
   comes in low; `comments` is the single overall comment box.
------------------------------------------------------------------ */

const SURVEY_TYPES = Object.keys(GROUPS)

const questionLabel = (id) => QUESTIONS[id] || `Field ${id}`

// Mean of a submission's own rating answers (ignoring anything non-numeric).
const rowAvg = (r) => {
  const vals = Object.values(r.ratings ?? {}).map(Number).filter((n) => n >= 1 && n <= 5)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

const Stars = ({ n }) =>
  n ? <span style={{ color: '#f5a623', whiteSpace: 'nowrap' }}>{'★'.repeat(Math.round(n))}</span> : '—'

function Bars({ dist, total }) {
  return (
    <div className="card-body">
      {[5, 4, 3, 2, 1].map((star) => {
        const c = dist[star - 1] || 0
        const pct = total ? Math.round((c / total) * 100) : 0
        return (
          <div key={star} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0' }}>
            <span style={{ width: 34, color: '#f5a623' }}>{star} ★</span>
            <div style={{ flex: 1, background: 'var(--rule, #edf1f5)', borderRadius: 4, height: 14 }}>
              <div style={{ width: `${pct}%`, background: '#f5a623', height: '100%', borderRadius: 4 }} />
            </div>
            <span className="mono" style={{ width: 66, textAlign: 'right', fontSize: 12, color: 'var(--ink-3)' }}>
              {c} · {pct}%
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default function FiveStarReport() {
  const { facilityId, facility } = useApp()
  const [from, setFrom] = useState(daysAgo(90))
  const [to, setTo] = useState(today())
  const [type, setType] = useState('')

  const q = useQuery(
    () =>
      facilityId
        ? fetchAll(() =>
            supabase
              .from('five_star_submissions')
              .select('id, survey_type, respondent_name, source_facility, referred, patient_age, ratings, comments, submitted_at')
              .eq('facility_id', facilityId)
              .gte('submitted_at', from)
              .lte('submitted_at', to + 'T23:59:59.999')
              .order('submitted_at', { ascending: false }),
          )
        : null,
    [facilityId, from, to],
  )

  const rows = useMemo(
    () => q.rows.filter((r) => !type || r.survey_type === type),
    [q.rows, type],
  )

  // Overall stats: mean over EVERY rating answer in scope, plus the 1-5
  // distribution of those answers and the referral split.
  const stats = useMemo(() => {
    let sum = 0, n = 0
    const dist = [0, 0, 0, 0, 0]
    let referredYes = 0, referredKnown = 0
    for (const r of rows) {
      for (const v of Object.values(r.ratings ?? {})) {
        const x = Number(v)
        if (x >= 1 && x <= 5) { sum += x; n++; dist[x - 1]++ }
      }
      if (r.referred === 'Yes') { referredYes++; referredKnown++ }
      else if (r.referred === 'No') referredKnown++
    }
    const fives = dist[4]
    return {
      responses: rows.length,
      answers: n,
      avg: n ? sum / n : 0,
      pct5: n ? Math.round((fives / n) * 100) : 0,
      dist,
      referredPct: referredKnown ? Math.round((referredYes / referredKnown) * 100) : null,
    }
  }, [rows])

  // Count + average by survey type (always over the full loaded set, not the
  // type filter, so the breakdown stays whole).
  const byType = useMemo(() => {
    return SURVEY_TYPES.map((t) => {
      const sub = q.rows.filter((r) => r.survey_type === t)
      let sum = 0, n = 0
      for (const r of sub) for (const v of Object.values(r.ratings ?? {})) {
        const x = Number(v); if (x >= 1 && x <= 5) { sum += x; n++ }
      }
      return { type: t, count: sub.length, avg: n ? sum / n : null }
    }).filter((x) => x.count)
  }, [q.rows])

  // Per-question averages — only meaningful for a single survey type, since the
  // questions differ. Shown when one type is selected.
  const byQuestion = useMemo(() => {
    if (!type) return []
    return (GROUPS[type] ?? []).map((id) => {
      let sum = 0, n = 0
      for (const r of rows) {
        const x = Number(r.ratings?.[id])
        if (x >= 1 && x <= 5) { sum += x; n++ }
      }
      return { id, label: questionLabel(id), count: n, avg: n ? sum / n : null }
    }).filter((x) => x.count)
  }, [rows, type])

  // Referral sources (where the respondent came from), best for the marketers.
  const bySource = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const key = (r.source_facility || '').trim() || '(not given)'
      const a = rowAvg(r)
      const e = m.get(key) || { source: key, count: 0, sum: 0, rated: 0 }
      e.count++
      if (a != null) { e.sum += a; e.rated++ }
      m.set(key, e)
    }
    return [...m.values()]
      .map((e) => ({ source: e.source, count: e.count, avg: e.rated ? e.sum / e.rated : null }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)
  }, [rows])

  // Monthly trend.
  const byMonth = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const key = (r.submitted_at || '').slice(0, 7)
      if (!key) continue
      const a = rowAvg(r)
      const e = m.get(key) || { month: key, count: 0, sum: 0, rated: 0 }
      e.count++
      if (a != null) { e.sum += a; e.rated++ }
      m.set(key, e)
    }
    return [...m.values()]
      .map((e) => ({ month: e.month, count: e.count, avg: e.rated ? e.sum / e.rated : null }))
      .sort((a, b) => a.month.localeCompare(b.month))
  }, [rows])

  const exportCsv = () => {
    const out = rows.map((r) => ({
      date: (r.submitted_at || '').slice(0, 10),
      type: r.survey_type,
      respondent: r.respondent_name || '',
      source: r.source_facility || '',
      referred: r.referred || '',
      age: r.patient_age ?? '',
      avg: rowAvg(r)?.toFixed(2) ?? '',
      comment: r.comments || '',
    }))
    downloadCsv(`five-star-${from}-to-${to}.csv`, [
      { key: 'date', label: 'Date' },
      { key: 'type', label: 'Survey' },
      { key: 'respondent', label: 'Respondent' },
      { key: 'source', label: 'Source facility' },
      { key: 'referred', label: 'Referred' },
      { key: 'age', label: 'Patient age' },
      { key: 'avg', label: 'Avg rating' },
      { key: 'comment', label: 'Comment' },
    ], out)
  }

  const fmtMonth = (ym) =>
    ym ? new Date(ym + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Five-star survey report</h1>
          <p>{facility?.name ?? 'No campus'} — patient and referral-source satisfaction
             from the public survey. Campus-scoped; no login needed on the respondent’s end.</p>
        </div>
        <div className="row-actions">
          <button className="btn" type="button" onClick={() => window.print()}>Print</button>
          <button className="btn btn-primary" type="button" disabled={!rows.length}
                  onClick={exportCsv}>Download CSV</button>
        </div>
      </div>

      <div className="toolbar">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <span style={{ color: 'var(--ink-3)' }}>to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Survey type">
          <option value="">All survey types</option>
          {SURVEY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="spacer" />
        <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 12 }}>
          {q.loading ? '' : `${stats.responses} response${stats.responses === 1 ? '' : 's'}`}
        </span>
      </div>

      {q.error && <Banner kind="error">{q.error}</Banner>}

      {q.loading ? <Loading rows={8} /> : !stats.responses ? (
        <Empty title="No survey responses in this range"
               body="Widen the dates, or share the survey link / QR with the businesses and families you work with — responses will appear here as they come in." />
      ) : (
        <>
          <div className="kpis" style={{ marginBottom: 14 }}>
            <div className="kpi"><span className="l">Responses</span><span className="n">{stats.responses}</span></div>
            <div className="kpi"><span className="l">Average rating</span>
              <span className="n">{stats.answers ? `${stats.avg.toFixed(1)} ★` : '—'}</span></div>
            <div className="kpi"><span className="l">5-star answers</span>
              <span className="n">{stats.answers ? `${stats.pct5}%` : '—'}</span></div>
            <div className="kpi"><span className="l">Referred on</span>
              <span className="n">{stats.referredPct == null ? '—' : `${stats.referredPct}%`}</span></div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head"><h2>Rating distribution</h2>
              <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                {stats.answers} rating{stats.answers === 1 ? '' : 's'}
              </span>
            </div>
            <Bars dist={stats.dist} total={stats.answers} />
          </div>

          {byType.length > 1 && !type && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-head"><h2>By survey type</h2></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Survey type</th><th className="num">Responses</th><th className="num">Avg rating</th></tr></thead>
                  <tbody>
                    {byType.map((t) => (
                      <tr key={t.type}>
                        <td>{t.type}</td>
                        <td className="num">{t.count}</td>
                        <td className="num">{t.avg != null ? <>{t.avg.toFixed(2)} <Stars n={t.avg} /></> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {byQuestion.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-head"><h2>{type} — by question</h2></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Question</th><th className="num">Answers</th><th className="num">Avg</th></tr></thead>
                  <tbody>
                    {byQuestion.map((qq) => (
                      <tr key={qq.id}>
                        <td>{qq.label}</td>
                        <td className="num">{qq.count}</td>
                        <td className="num">{qq.avg != null ? <>{qq.avg.toFixed(2)} <Stars n={qq.avg} /></> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {bySource.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-head"><h2>Top referral sources</h2>
                <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                  by response volume
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Source facility</th><th className="num">Responses</th><th className="num">Avg rating</th></tr></thead>
                  <tbody>
                    {bySource.map((s) => (
                      <tr key={s.source}>
                        <td>{s.source}</td>
                        <td className="num">{s.count}</td>
                        <td className="num">{s.avg != null ? <>{s.avg.toFixed(2)} <Stars n={s.avg} /></> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {byMonth.length > 1 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-head"><h2>Trend</h2></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Month</th><th className="num">Responses</th><th className="num">Avg rating</th></tr></thead>
                  <tbody>
                    {byMonth.map((m) => (
                      <tr key={m.month}>
                        <td>{fmtMonth(m.month)}</td>
                        <td className="num">{m.count}</td>
                        <td className="num">{m.avg != null ? m.avg.toFixed(2) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head"><h2>Responses</h2></div>
            <DataTable
              rows={rows}
              columns={[
                { key: 'submitted_at', label: 'Date',
                  render: (r) => fmtDate((r.submitted_at || '').slice(0, 10)),
                  sortValue: (r) => r.submitted_at || '' },
                { key: 'survey_type', label: 'Survey' },
                { key: 'avg', label: 'Rating', sortable: false,
                  render: (r) => { const a = rowAvg(r); return a != null ? <><Stars n={a} /> <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{a.toFixed(1)}</span></> : '—' } },
                { key: 'respondent_name', label: 'Respondent',
                  render: (r) => r.respondent_name || '—' },
                { key: 'source_facility', label: 'Source facility',
                  render: (r) => r.source_facility || '—' },
                { key: 'referred', label: 'Referred', render: (r) => r.referred || '—' },
                { key: 'comments', label: 'Comment', sortable: false,
                  render: (r) => r.comments || '—' },
              ]}
            />
          </div>
        </>
      )}
    </>
  )
}
