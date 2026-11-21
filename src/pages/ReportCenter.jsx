import AdministratorInbox from '../components/AdministratorInbox'
import { useState, useEffect } from 'react'

import { Link, useParams } from 'react-router-dom'

import { useApp, useQuery, save } from '../lib/data'

import { supabase } from '../lib/supabase'

import { useOperations, rpc } from '../lib/operations'

import { OpsHead, OpsState, PersonPick } from '../components/Operations'

import { Banner, DataTable } from '../components/ui'

import {
  chicagoToday,
  monday,
  plusDays,
  activityTotals,
  admissions,
} from '../lib/operations-core'

import { reportText } from '../lib/report-text'

const cards = [
  [
    'am',
    'AM NetSphere report',
    'Census, pending movement and monthly team KPI progress.',
  ],

  [
    'pm',
    'End-of-day PM report',
    'Activities, touches, referrals and confirmed admissions, ready to copy.',
  ],

  [
    'weekly',
    'Weekly reporting',
    "SDD end-of-week summary and each marketer's planned versus actual.",
  ],

  [
    'monthly',
    'Monthly reporting',
    'Individual KPI results against the approved budget.',
  ],

  [
    'review',
    'Team touch review',
    'SDD checkoff, administrator verification and corporate export.',
  ],
]

export default function ReportCenter() {
  const app = useApp(),
    q = useOperations(),
    data = q.data,
    { kind } = useParams(),
    [date, setDate] = useState(chicagoToday()),
    [user, setUser] = useState(app.profile.id),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [census, setCensus] = useState({}),
    [initials, setInitials] = useState(''),
    [attest, setAttest] = useState(false),
    [copyStatus, setCopyStatus] = useState('')

  const from = plusDays(monday(date), -7),
    to = plusDays(from, 6)

  const reviews = useQuery(
    () =>
      kind === 'review'
        ? supabase
            .from('report_reviews')
            .select('*')
            .eq('facility_id', app.facilityId)
            .eq('starts', from)
            .eq('ends', to)
            .order('submitted_at', { ascending: false })
        : null,
    [kind, app.facilityId, from, to],
  )

  useEffect(() => {
    setUser(app.profile.id)
    setCensus({})
  }, [app.facilityId, date])

  async function action(fn) {
    setError('')
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const text =
    data && ['am', 'pm'].includes(kind)
      ? reportText({
          kind,
          data,
          date,
          user,
          facility: app.facility.name,
          territories: app.lookups.territories || [],
        })
      : ''

  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value)
      setCopyStatus('Copied. Ready to paste into NetSphere.')
    } catch {
      setCopyStatus('Select the text in the report and copy it.')
    }
  }

  const summary =
    data?.members.map((m) => {
      const acts = data.activities.filter(
          (a) =>
            a.user_id === m.user_id &&
            a.activity_date >= from &&
            a.activity_date <= to,
        ),
        tot = activityTotals(acts)
      return {
        id: m.user_id,
        rep: [m.profile?.first_name, m.profile?.last_name]
          .filter(Boolean)
          .join(' '),
        touches: tot.touches,
        quality: tot.byType['Quality Touch'] || 0,
        inservices:
          (tot.byType['In-Service'] || 0) + (tot.byType.Luncheon || 0),
        referrals: data.referrals.filter(
          (r) =>
            r.submitted_by === m.user_id &&
            r.referral_date >= from &&
            r.referral_date <= to,
        ).length,
        admissions: admissions(
          data.referrals.filter((r) => r.submitted_by === m.user_id),
          from,
          to,
        ).length,
      }
    }) || []

  if (!data)
    return (
      <>
        <OpsHead title="Report Center" />
        <OpsState query={q} />
      </>
    )

  return (
    <>
      <OpsHead title={cards.find((c) => c[0] === kind)?.[1] || 'Report Center'}>
        <Link className="btn" to="/reports/logs">
          Existing data / CSV reports
        </Link>
        <button className="btn" onClick={() => window.print()}>
          Print
        </button>
      </OpsHead>
      <OpsState query={q}>
        <Banner>
          Activities, referrals and outcomes automatically populate these
          reports. Correct the source entry once. Census actuals are the
          phase-one manual count until the enterprise connection is available.
        </Banner>

        <div className="toolbar">
          <label className="ops-field">
            Report date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          {app.isManager ? (
            <PersonPick data={data} value={user} onChange={setUser} />
          ) : (
            <span>
              {app.profile.first_name} {app.profile.last_name}
            </span>
          )}
          <Link className="btn" to="/marketing-settings">
            Programs &amp; goals
          </Link>
        </div>
        <Banner kind="error">{error}</Banner>

        {!kind && (
          <div className="ops-two">
            {cards.map(([id, title, desc]) => (
              <section className="card card-body" key={id}>
                <h2>{title}</h2>
                <p>{desc}</p>
                <Link className="btn btn-primary" to={'/reports/' + id}>
                  Open report
                </Link>
              </section>
            ))}
          </div>
        )}

        {['am', 'pm'].includes(kind) && (
          <>
            <section className="card card-body">
              <h2>Daily census actuals</h2>
              <div className="ops-two">
                {data?.programs
                  .filter((p) => p.active)
                  .map((p) => (
                    <label className="ops-field" key={p.id}>
                      {p.name}
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={
                          census[p.id] ??
                          data.census.find(
                            (c) =>
                              c.program_id === p.id && c.census_date === date,
                          )?.actual ??
                          ''
                        }
                        placeholder="Not recorded"
                        onChange={(e) =>
                          setCensus({ ...census, [p.id]: e.target.value })
                        }
                      />
                    </label>
                  ))}
              </div>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    for (const [pid, raw] of Object.entries(census)) {
                      if (!/^\d+$/.test(raw))
                        throw Error('Census must be a nonnegative whole number')
                      const r = await supabase.from('census_entries').upsert(
                        {
                          facility_id: app.facilityId,
                          program_id: pid,
                          census_date: date,
                          actual: Number(raw),
                          saved_by: app.profile.id,
                          updated_at: new Date().toISOString(),
                        },
                        { onConflict: 'program_id,census_date' },
                      )
                      if (r.error) throw r.error
                    }
                    setCensus({})
                    q.refresh()
                  })
                }
              >
                Save census and refresh
              </button>
            </section>
            <textarea
              className="ops-report-text"
              aria-label="Generated NetSphere report"
              readOnly
              value={text}
            />
            <button className="btn btn-primary" onClick={() => copy(text)}>
              Copy report for NetSphere
            </button>
            <p role="status">{copyStatus}</p>
          </>
        )}

        {['weekly', 'review'].includes(kind) && (
          <>
            <section className="card card-body">
              <h2>
                {from} through {to}
              </h2>
              <DataTable
                rows={summary}
                columns={[
                  'rep',
                  'touches',
                  'quality',
                  'inservices',
                  'referrals',
                  'admissions',
                ].map((key) => ({ key, label: key.toUpperCase() }))}
              />
              <Link className="btn" to="/rotation-schedules">
                Planned versus actual / missed stops
              </Link>{' '}
              <Link className="btn" to="/touch-analysis">
                Existing touch analysis
              </Link>
            </section>
            {kind === 'review' && (
              <section className="card card-body">
                <AdministratorInbox />
                <h2 id="team-review">SDD and administrator review</h2>
                <p>
                  Review original entries for omissions before signing. A source
                  change makes earlier approval stale; prior versions remain in
                  history.
                </p>
                {app.isManager && (
                  <>
                    <input
                      aria-label="Reviewer initials"
                      placeholder="Initials"
                      maxLength={8}
                      value={initials}
                      onChange={(e) => setInitials(e.target.value)}
                    />
                    <label className="ops-check">
                      <input
                        type="checkbox"
                        checked={attest}
                        onChange={(e) => setAttest(e.target.checked)}
                      />
                      I checked the entries for completeness and accuracy.
                    </label>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        action(async () => {
                          await rpc('sign_operational_report', {
                            p_facility: app.facilityId,
                            p_start: from,
                            p_end: to,
                            p_initials: initials,
                            p_attest: attest,
                            p_id: null,
                          })
                          reviews.refresh()
                        })
                      }
                    >
                      SDD checkoff / send for review
                    </button>
                  </>
                )}
                <Banner kind="error">{reviews.error}</Banner>
                {reviews.rows.map((r) => (
                  <div className="card-body" key={r.id}>
                    {r.submitted_at} · SDD {r.sdd_initials} ·{' '}
                    {r.approved_at
                      ? 'Administrator ' + r.admin_initials
                      : 'Awaiting administrator'}{' '}
                    {app.isAdmin && !r.approved_at && (
                      <button
                        className="btn"
                        onClick={() =>
                          action(async () => {
                            await rpc('sign_operational_report', {
                              p_facility: app.facilityId,
                              p_start: from,
                              p_end: to,
                              p_initials: initials,
                              p_attest: attest,
                              p_id: r.id,
                            })
                            reviews.refresh()
                          })
                        }
                      >
                        Verify and sign
                      </button>
                    )}
                    <button
                      className="btn"
                      onClick={() =>
                        copy(
                          JSON.stringify(
                            {
                              report: 'Team touch review',
                              submitted: r.submitted_at,
                              sdd: r.sdd_initials,
                              administrator: r.admin_initials,
                              approved: r.approved_at,
                              snapshot: r.snapshot,
                            },
                            null,
                            2,
                          ),
                        )
                      }
                    >
                      Copy saved report
                    </button>
                  </div>
                ))}
                <p role="status">{copyStatus}</p>
              </section>
            )}
          </>
        )}

        {kind === 'monthly' && (
          <div className="card card-body">
            <h2>Monthly KPI versus approved budget</h2>
            <p>
              Review the month's touches and referrals against goal, and export
              the underlying rows.
            </p>
            <Link className="btn" to="/touch-analysis">
              Touch analysis
            </Link>{' '}
            <Link className="btn" to="/referral-scorecard">
              Referral scorecard
            </Link>{' '}
            <Link className="btn" to="/reports/logs">
              Data / CSV reports
            </Link>
          </div>
        )}
      </OpsState>
    </>
  )
}
