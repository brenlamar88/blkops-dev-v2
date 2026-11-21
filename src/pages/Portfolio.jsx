import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../lib/data'
import { useOperations } from '../lib/operations'
import { OpsHead, OpsState, PersonPick } from '../components/Operations'
import { DataTable } from '../components/ui'
import { chicagoToday, plusDays } from '../lib/operations-core'
import {
  weeklyPulse,
  sourceRanking,
  territoryRelationships,
} from '../lib/performance'
import { budgetCarryForward } from '../lib/goal-allocation'
import StudyLibrary from '../components/StudyLibrary'
const labels = {
  touches: 'Touches',
  quality_touches: 'Quality touches',
  referrals: 'Referrals',
  admissions: 'Admissions',
  inservices: 'In-services',
  followups: 'Follow-ups',
  thankyous: 'Thank-you cards',
  needs: 'Needs analyses',
  surveys: 'Survey activities',
}
export default function Portfolio() {
  const app = useApp(),
    q = useOperations(),
    d = q.data,
    [person, setPerson] = useState(app.isAdmin ? '' : app.profile.id),
    date = chicagoToday(),
    user = app.isAdmin ? person : app.profile.id,
    team = app.isAdmin && !user
  useEffect(
    () => setPerson(app.isAdmin ? '' : app.profile.id),
    [app.facilityId, app.isAdmin, app.profile.id],
  )
  const member = d?.members.find((m) => m.user_id === user),
    profile = member?.profile || app.profile,
    territory = app.lookups.territories?.find(
      (t) => t.id === member?.territory_id,
    )?.name
  if (!d)
    return (
      <>
        <OpsHead title="My Portfolio" />
        <OpsState query={q} />
      </>
    )
  const pulse = weeklyPulse(d, user, date),
    relations = territoryRelationships(d, app.lookups.territories || [], date),
    sources = sourceRanking(d, '', plusDays(date, -90), date, '', user),
    old = new Set(
      d.referrals
        .filter(
          (r) =>
            (!user || r.submitted_by === user) &&
            r.arrival_confirmed &&
            r.admission_status === 'Admit' &&
            r.admit_denial_date < plusDays(date, -90),
        )
        .map((r) => r.prospect_company_id),
    ),
    recover = d.companies.filter(
      (c) =>
        old.has(c.company_id) &&
        !sources.some((s) => s.id === c.company_id && s.admissions > 0),
    ),
    carry = budgetCarryForward(d, date.slice(0, 7) + '-01')
  const days = d.plans
    .filter((p) => !p.archived_at && (!user || p.user_id === user))
    .flatMap((p) =>
      p.body.days.map((day) => ({
        ...day,
        program: p.program_id,
        user: p.user_id,
      })),
    )
    .filter((day) => day.date >= date)
    .sort((a, b) => a.date.localeCompare(b.date))
  return (
    <>
      <OpsHead title="My Portfolio" />
      <OpsState query={q}>
        {app.isAdmin && (
          <PersonPick
            data={d}
            value={person}
            onChange={setPerson}
            label="Hospital team / view a marketer"
          />
        )}
        <section className="card card-body">
          <h2>
            Welcome, {profile.first_name} {profile.last_name}
          </h2>
          <p>
            {app.facility.name} ·{' '}
            {team
              ? 'Administrator · hospital service development team'
              : (member?.role === 'rep' ? 'SDR' : member?.role || app.role) +
                ' · ' +
                (territory || 'Territory unassigned')}
          </p>
          <h3>It's a great day to have a great day.</h3>
          <Link
            className="btn btn-primary"
            to={'/rotation-schedules?day=' + date}
          >
            {team
              ? 'View team rotation schedules'
              : 'Start Day · open my route'}
          </Link>
          {team && (
            <Link className="btn" to="/reports/review">
              Administrator approval inbox
            </Link>
          )}
        </section>
        {carry && <p className="ops-warning">{carry}</p>}
        <div className="ops-two">
          <section className="card card-body portfolio-pulse">
            <h2>
              {team ? 'Hospital KPI pulse this week' : 'My weekly KPI pulse'}
            </h2>
            <DataTable
              rows={pulse}
              columns={[
                {
                  key: 'metric',
                  label: 'Metric',
                  render: (r) => labels[r.metric],
                },
                { key: 'actual', label: 'This week' },
                {
                  key: 'target',
                  label: 'Weekly goal',
                  render: (r) => r.target ?? 'Not set',
                },
                {
                  key: 'remaining',
                  label: 'Still needed',
                  render: (r) => r.remaining ?? '—',
                },
                { key: 'monthly', label: 'Monthly pace' },
              ]}
            />
            <p>
              {team
                ? 'Includes all recorded campus activity and referrals, including support staff. The touch goal counts each active representative once.'
                : '60 physical touches per full week.'}{' '}
              Referrals and admissions use approved territory budgets; approved
              weekly commitments take precedence. Counts refresh every 30
              seconds.
            </p>
            <p>
              Survey return rates and follow-up completion require
              eligible-patient and JotForm data. Logged activity counts alone do
              not prove completion.
            </p>
          </section>
          <section className="card card-body">
            <h2>{team ? 'Our company standing' : 'My company standing'}</h2>
            <p>
              Monthly and year-to-date performance for the campus pilot, with
              existing user attribution.
            </p>
            {team && (
              <p>
                <Link to="/marketing-settings">
                  Upload annual budget / review territory allocations
                </Link>
              </p>
            )}
            <h3>
              {team
                ? 'What the team is achieving / where to focus'
                : 'What is going well / where to focus'}
            </h3>
            {pulse
              .filter((r) => r.monthGoal != null)
              .map((r) => (
                <p key={r.metric}>
                  <b>{labels[r.metric]}</b> · {r.monthActual} / {r.monthGoal}{' '}
                  this month · {r.monthly}
                </p>
              ))}
            <p>
              Needs analyses, follow-up calls, thank-you cards and survey
              activities appear in the pulse. Missing task expectations are
              marked for review, not automatically failed.
            </p>
          </section>
        </div>
        {team ? (
          <div className="ops-three">
            {relations.map((r) => (
              <section className="card card-body" key={r.name}>
                <h2>{r.name} · relationship priorities</h2>
                <h3>Top 3 to recover</h3>
                <small>
                  Previous admissions; none in 90 days. Ranked by earlier
                  confirmed admission volume.
                </small>
                {r.recover.map((s) => (
                  <p key={s.id}>
                    <Link to={'/companies/' + s.id}>{s.name}</Link> · {s.prior}{' '}
                    earlier admits · last {s.last}
                  </p>
                ))}
                {!r.recover.length && (
                  <p>No matching sources in available records.</p>
                )}
                <h3>Top 3 to maintain</h3>
                {r.maintain.map((s) => (
                  <p key={s.id}>
                    <Link to={'/companies/' + s.id}>{s.name}</Link> · {s.recent}{' '}
                    admits / 90 days
                  </p>
                ))}
                {!r.maintain.length && (
                  <p>No confirmed recent admissions recorded.</p>
                )}
              </section>
            ))}
          </div>
        ) : (
          <div className="ops-two">
            <section className="card card-body">
              <h2>Relationships to recover</h2>
              {recover.slice(0, 10).map((c) => (
                <p key={c.company_id}>
                  <Link to={'/companies/' + c.company_id}>
                    {c.company.name}
                  </Link>
                </p>
              ))}
              {!recover.length && (
                <p>No matching recovery sources in the available records.</p>
              )}
              <Link to="/mis">Open MIS</Link>
            </section>
            <section className="card card-body">
              <h2>Strong relationships to maintain</h2>
              {sources
                .filter((s) => s.admissions > 0)
                .sort((a, b) => b.admissions - a.admissions)
                .slice(0, 10)
                .map((s) => (
                  <p key={s.id}>
                    <Link to={'/companies/' + s.id}>{s.name}</Link> ·{' '}
                    {s.admissions} confirmed admissions / 90 days
                  </p>
                ))}
            </section>
          </div>
        )}
        <div className="ops-two">
          {days.slice(0, team ? 6 : 2).map((day) => (
            <section
              className="card card-body"
              key={day.date + day.program + day.user}
            >
              <h2>{day.date} · upcoming route</h2>
              <p>
                {day.cities.join(' / ')} · {day.stops.length} stops
              </p>
              <Link
                className="btn"
                to={
                  '/rotation-schedules?day=' +
                  day.date +
                  '&program=' +
                  day.program
                }
              >
                View route and activities
              </Link>
            </section>
          ))}
        </div>
        <StudyLibrary pulse={pulse} user={user} />
      </OpsState>
    </>
  )
}
