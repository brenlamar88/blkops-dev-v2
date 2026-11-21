import MarketOpportunity from '../components/MarketOpportunity'
import AnnualScorecard from '../components/AnnualScorecard'
import { effectiveGoal, budgetCarryForward } from '../lib/goal-allocation'
import {
  categoryMix,
  orderedTerritories,
  recordCategory,
} from '../lib/workbook-core'
import { useEffect, useState } from 'react'

import { Link, useSearchParams } from 'react-router-dom'

import { useApp } from '../lib/data'

import { useOperations, programPool } from '../lib/operations'

import { OpsHead, OpsState, ProgramPick } from '../components/Operations'

import { DataTable } from '../components/ui'

import {
  chicagoToday,
  calendarMonths,
  plusDays,
  categoryName,
  admissions,
  pace,
} from '../lib/operations-core'

import { sourceRanking, performance } from '../lib/performance'

const tabs = [
  'Overview',
  'QAPI Referral Scorecard',
  'QAPI Admission Scorecard',
  'Competitor SWOT',
  'KPI',
  'Admissions by Source',
  'Denial Analysis',
  'Insurance Utilization',
  'Physician Expenses',
  'Market Share',
  'Fax-out List',
]

export default function Workbook() {
  const app = useApp(),
    q = useOperations(),
    d = q.data,
    [params] = useSearchParams(),
    [tab, setTab] = useState(params.get('tab') || 'Overview'),
    [program, setProgram] = useState(''),
    [month, setMonth] = useState(chicagoToday().slice(0, 7)),
    [territory, setTerritory] = useState(''),
    [user, setUser] = useState('')

  useEffect(() => {
    setProgram('')
    setTerritory('')
    setUser('')
  }, [app.facilityId])

  useEffect(() => {
    if (d && !program) setProgram(d.programs[0]?.id || '')
  }, [d, program])

  const start = month + '-01',
    end = plusDays(calendarMonths(start, 1), -1),
    asof = end > chicagoToday() ? chicagoToday() : end

  const rows = d
      ? sourceRanking(d, program, start, end, territory, user).map((r) => ({
          ...r,
          category: recordCategory(
            d,
            { prospect_company_id: r.id },
            program,
            app.lookups.categories || [],
          ),
        }))
      : [],
    metric = tab === 'QAPI Referral Scorecard' ? 'referrals' : 'admissions',
    ranked = [...rows].sort(
      (a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name),
    )

  const refs =
      d?.referrals.filter(
        (r) =>
          r.program_id === program &&
          r.referral_date >= start &&
          r.referral_date <= end &&
          (!territory || r.territory_id === territory) &&
          (!user || r.submitted_by === user),
      ) || [],
    adm = d
      ? admissions(d.referrals, start, end, program).filter(
          (r) =>
            (!territory || r.territory_id === territory) &&
            (!user || r.submitted_by === user),
        )
      : []

  const pool = programPool(d, program, territory),
    terrs = orderedTerritories(app.lookups.territories || []),
    programName = d?.programs.find((p) => p.id === program)?.name

  const pct = (n, total) => (total ? ((100 * n) / total).toFixed(1) + '%' : '—')

  const totals = {
    Referrals: refs.length,
    'Confirmed admissions': adm.length,
    Conversion: pct(adm.length, refs.length),
    Denials: refs.filter((r) => r.admission_status === 'Denial').length,
  }

  const sourceCols = [
    {
      key: 'name',
      label: 'Source',
      render: (r) => <Link to={'/companies/' + r.id}>{r.name}</Link>,
    },
    { key: 'city', label: 'City' },
    { key: 'category', label: 'Category' },
    { key: 'referrals', label: 'Referrals' },
    { key: 'admissions', label: 'Confirmed admissions' },
  ]

  return (
    <>
      <OpsHead title="SDD Workbook" />
      <div className="ops-tabs">
        {tabs.map((name, i) => (
          <button
            key={name}
            className={
              'btn ops-workbook-tab tab-' +
              i +
              (name === tab ? ' selected' : '')
            }
            onClick={() => setTab(name)}
          >
            {name.toUpperCase()}
          </button>
        ))}
      </div>
      <OpsState query={q}>
        {d && (
          <>
            <div className="toolbar">
              <ProgramPick data={d} value={program} onChange={setProgram} />
              <label className="ops-field">
                Reporting month
                <input
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                />
              </label>
              <label className="ops-field">
                Territory
                <select
                  value={territory}
                  onChange={(e) => setTerritory(e.target.value)}
                >
                  <option value="">All territories</option>
                  {terrs.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ops-field">
                User
                <select value={user} onChange={(e) => setUser(e.target.value)}>
                  <option value="">All users</option>
                  {d?.members.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.profile?.first_name} {m.profile?.last_name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <p>
              {programName} · Counts refresh from the existing logs. Admissions
              require confirmed arrival and an admitted program. Legacy outcomes
              awaiting confirmation remain visible in the Referral Log.
            </p>

            <div className="kpis">
              {Object.entries(totals).map(([name, n]) => (
                <div className="kpi" key={name}>
                  <span className="l">{name}</span>
                  <span className="n">{n}</span>
                </div>
              ))}
            </div>

            {(tab === 'Overview' || tab.startsWith('QAPI')) && (
              <AnnualScorecard
                data={d}
                program={program}
                year={month.slice(0, 4)}
                through={asof}
                territory={territory}
                user={user}
                metric={metric}
                categories={app.lookups.categories || []}
                territories={terrs}
              />
            )}
            <p className="ops-warning">{budgetCarryForward(d, start)}</p>
            {tab === 'KPI' && (
              <section className="card card-body">
                <h2>Monthly marketer KPI</h2>
                <p className="ops-warning">
                  Corporate / administrator must enter each hospital and
                  marketer's approved budget.
                </p>
                <DataTable
                  rows={(d?.members || [])
                    .filter((m) => !user || m.user_id === user)
                    .flatMap((m) => {
                      const actual = performance(
                        d,
                        m.user_id,
                        start,
                        asof,
                        program,
                      )
                      return [
                        'touches',
                        'quality_touches',
                        'referrals',
                        'admissions',
                        'inservices',
                      ].map((metric) => {
                        const goal = effectiveGoal(d, {
                          user: m.user_id,
                          program,
                          month: start,
                          metric,
                        })
                        return {
                          id: m.user_id + metric,
                          name:
                            m.profile?.first_name + ' ' + m.profile?.last_name,
                          metric,
                          actual: actual[metric],
                          goal,
                          ...pace(actual[metric], goal, asof),
                        }
                      })
                    })}
                  columns={[
                    { key: 'name', label: 'Marketer' },
                    { key: 'metric', label: 'KPI' },
                    { key: 'actual', label: 'MTD' },
                    {
                      key: 'goal',
                      label: 'Goal',
                      render: (r) => r.goal ?? 'Budget needed',
                    },
                    { key: 'label', label: 'Pace' },
                  ]}
                />
              </section>
            )}

            {tab === 'Admissions by Source' &&
              terrs
                .filter((t) => !territory || territory === t.id)
                .map((t) => (
                  <section className="card card-body" key={t.id}>
                    <h2>{t.name}</h2>
                    {categoryMix(
                      d,
                      program,
                      { referrals: refs, admissions: adm },
                      app.lookups.categories || [],
                    ).map(({ category }) => (
                      <details key={category}>
                        <summary>
                          {category} ·{' '}
                          {rows
                            .filter(
                              (r) =>
                                r.territory_id === t.id &&
                                categoryName(r.category) === category,
                            )
                            .reduce((s, r) => s + r.admissions, 0)}
                        </summary>
                        <DataTable
                          rows={ranked.filter(
                            (r) =>
                              r.territory_id === t.id &&
                              categoryName(r.category) === category &&
                              r.admissions,
                          )}
                          columns={sourceCols}
                        />
                      </details>
                    ))}
                  </section>
                ))}

            {['Denial Analysis', 'Insurance Utilization'].includes(tab) && (
              <section className="card card-body">
                <h2>{tab}</h2>
                <DataTable
                  rows={(tab === 'Denial Analysis'
                    ? app.lookups.denialReasons
                    : app.lookups.payerSources || []
                  )
                    .map((x) => ({
                      id: x.id,
                      name: x.name,
                      count: refs.filter((r) =>
                        tab === 'Denial Analysis'
                          ? r.admission_status === 'Denial' &&
                            r.denial_reason_id === x.id
                          : r.primary_insurance_id === x.id,
                      ).length,
                    }))
                    .sort((a, b) => b.count - a.count)}
                  columns={[
                    {
                      key: 'name',
                      label: tab === 'Denial Analysis' ? 'Reason' : 'Payer',
                    },
                    { key: 'count', label: 'Referrals' },
                  ]}
                />
                {tab === 'Insurance Utilization' && (
                  <p>
                    Collection quality ratings require the UR / billing feed;
                    insurance labels alone do not establish payment.
                  </p>
                )}
              </section>
            )}

            {tab === 'Market Share' && (
              <MarketOpportunity
                data={d}
                program={program}
                territories={terrs}
                territory={territory}
                user={user}
                start={start}
                end={end}
              />
            )}

            {tab === 'Fax-out List' && (
              <>
                {[true, false].map((ready) => (
                  <section className="card card-body" key={String(ready)}>
                    <h2>
                      {ready
                        ? 'Fax number supplied · delivery unverified'
                        : 'Missing fax · needs analysis'}
                    </h2>
                    <DataTable
                      rows={pool.filter((c) => !!c.fax === ready)}
                      columns={[
                        { key: 'name', label: 'Company' },
                        { key: 'city', label: 'City' },
                        { key: 'fax', label: 'Fax' },
                        {
                          key: 'action',
                          label: 'Follow-up',
                          render: (r) => (
                            <Link to={'/needs-analysis/company/' + r.id}>
                              Needs analysis
                            </Link>
                          ),
                        },
                      ]}
                    />
                  </section>
                ))}
                <p>
                  Fax delivery provider connection is pending. A supplied number
                  is not proof of delivery.
                </p>
              </>
            )}

            {['Competitor SWOT', 'Physician Expenses'].includes(tab) && (
              <section className="card card-body">
                <h2>Integration pending</h2>
                <p>
                  The approved {tab.toLowerCase()} design remains in the
                  handoff. Its dedicated history / evidence workflow will be
                  connected after the priority operations modules.
                </p>
                {tab === 'Physician Expenses' && (
                  <p className="muted">
                    Marketing expense tracking is not part of this build yet.
                  </p>
                )}
              </section>
            )}
          </>
        )}
      </OpsState>
    </>
  )
}
