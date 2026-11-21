import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { DataTable, Modal } from './ui'
import { Donut } from './charts'
import { programPool } from '../lib/operations'
import { coverageRows, scopedEvents, percent } from '../lib/workbook-core'
import { chicagoToday, activityTotals } from '../lib/operations-core'
export default function MarketOpportunity({
  data,
  program,
  territories,
  territory,
  user,
  start,
  end,
}) {
  const [city, setCity] = useState(null),
    [historyRange, setHistoryRange] = useState('all'),
    [historyProgram, setHistoryProgram] = useState('selected'),
    [ranking, setRanking] = useState('coverage'),
    pool = programPool(data, program, territory),
    events = scopedEvents(
      data,
      program,
      start,
      end < chicagoToday() ? end : chicagoToday(),
      { territory, user },
    ),
    cities = coverageRows(pool, events),
    totalAdmit = new Set(events.admissions.map((r) => r.prospect_company_id)),
    reached = pool.filter((p) => totalAdmit.has(p.id)).length
  const categories = [...new Set(pool.map((p) => p.category))]
    .map((name) => {
      const ps = pool.filter((p) => p.category === name),
        adm = ps.filter((p) => totalAdmit.has(p.id)).length
      return { id: name, name, n: ps.length, adm, gap: ps.length - adm }
    })
    .sort((a, b) => b.gap - a.gap)
  const active = city && cities.find((c) => c.id === city.id),
    ids = new Set(
      (active?.prospects || city?.prospects || []).map((c) => c.id),
    ),
    history = data.activities
      .filter(
        (a) =>
          ids.has(a.company_id) &&
          (historyProgram === 'all' || a.program_id === program) &&
          (!user || a.user_id === user) &&
          a.activity_date <= chicagoToday() &&
          (historyRange === 'all' ||
            (a.activity_date >= start && a.activity_date <= end)),
      )
      .sort(
        (a, b) =>
          b.activity_date.localeCompare(a.activity_date) ||
          a.id.localeCompare(b.id),
      )
  useEffect(() => setCity(null), [program, territory, user, start, end])
  const ranked =
    ranking === 'opportunity'
      ? [...cities].sort(
          (a, b) =>
            b.prospects.length -
              b.adm.length -
              (a.prospects.length - a.adm.length) ||
            a.city.localeCompare(b.city),
        )
      : cities
  const territoryCards = ['RED', 'WHITE', 'BLUE']
    .map(
      (name) =>
        territories.find((t) => t.name.trim().toUpperCase() === name) || {
          id: 'missing-' + name,
          name,
        },
    )
    .filter((t) => !territory || t.id === territory)
  const allProspects = active?.prospects || city?.prospects || []
  const chart = (adm, n) => (
    <>
      <Donut
        rows={[
          { label: 'Admitting sources', value: adm, color: '#2e7955' },
          { label: 'No admission in period', value: n - adm, color: '#d7dadd' },
        ]}
      />
      <p>
        <b>{percent(n ? adm / n : null)}</b> admitting-source coverage ·{' '}
        {n - adm} prospects without a matched admission this period.
      </p>
    </>
  )
  return (
    <>
      <p>
        Market Share · source coverage, using the same definition as your
        reference workbook: unique prospects with an admission ÷ eligible
        prospects. This is not the percentage of all patients admitted across
        competing hospitals. Current verified prospect assignments form the
        denominator; unresolved imports are excluded.
      </p>
      <div className="ops-three">
        {territoryCards.map((t) => {
          const ps = pool.filter((p) => p.territory_id === t.id),
            adm = ps.filter((p) => totalAdmit.has(p.id)).length,
            ref = ps.filter((p) =>
              events.referrals.some((r) => r.prospect_company_id === p.id),
            ).length
          return (
            <section className="card card-body market-card" key={t.id}>
              <h2
                className={'market-territory territory-' + t.name.toLowerCase()}
              >
                {t.name}
              </h2>
              <small>
                Referral {percent(ps.length ? ref / ps.length : null)}
              </small>
              {chart(adm, ps.length)}
              <p>{ps.length} prospects</p>
            </section>
          )
        })}
      </div>
      <p className="muted">
        Updates every 30 seconds while this page is visible and when you return
        to it. Green = admitting sources; gray = remaining prospects.
      </p>
      <div className="ops-two">
        <section className="card card-body">
          <h2>Selected program opportunity</h2>
          {chart(reached, pool.length)}
        </section>
        <section className="card card-body">
          <h2>Opportunity by category</h2>
          {categories.map((c) => (
            <div key={c.id} className="opportunity-bar">
              <b>{c.name}</b>
              <progress
                value={c.adm}
                max={c.n || 1}
                aria-label={c.name + ' admission coverage'}
              />
              <span>
                {c.adm} / {c.n} sources · {c.gap} to develop
              </span>
            </div>
          ))}
        </section>
      </div>
      <section className="card card-body">
        <h2>City ranking · where to move the needle</h2>
        <p>
          Compare current coverage with the largest number of prospects still to
          develop. Click a city or count to see its prospects and activity
          history.
        </p>
        <label className="ops-field">
          Rank cities by
          <select value={ranking} onChange={(e) => setRanking(e.target.value)}>
            <option value="coverage">Highest admission coverage</option>
            <option value="opportunity">
              Most prospects with no admission
            </option>
          </select>
        </label>
        <DataTable
          rows={ranked.map((c, i) => ({ ...c, rank: i + 1 }))}
          columns={[
            { key: 'rank', label: 'Rank' },
            {
              key: 'city',
              label: 'City / state',
              render: (r) => (
                <button className="btn" onClick={() => setCity(r)}>
                  {r.city}, {r.state}
                </button>
              ),
            },
            {
              key: 'territory_id',
              label: 'Territory',
              render: (r) =>
                territories.find((t) => t.id === r.territory_id)?.name ||
                'Unassigned',
            },
            {
              key: 'prospects',
              label: 'Prospects',
              render: (r) => (
                <button className="btn" onClick={() => setCity(r)}>
                  {r.prospects.length}
                </button>
              ),
            },
            {
              key: 'ref',
              label: 'Referral coverage',
              render: (r) => percent(r.ref.length / r.prospects.length),
            },
            {
              key: 'adm',
              label: 'Admission coverage',
              render: (r) => (
                <span className="coverage-cell">
                  <progress
                    value={r.adm.length}
                    max={r.prospects.length}
                    aria-label={r.city + ' coverage'}
                  />
                  {percent(r.adm.length / r.prospects.length)}
                </span>
              ),
            },
            {
              key: 'gap',
              label: 'Sources with no admission',
              render: (r) => r.prospects.length - r.adm.length,
            },
          ]}
        />
      </section>
      {city && (
        <Modal
          title={city.city + ', ' + city.state + ' · prospects and history'}
          onClose={() => setCity(null)}
        >
          <h3>Prospects</h3>
          <DataTable
            rows={allProspects}
            columns={[
              {
                key: 'name',
                label: 'Company',
                render: (r) => <Link to={'/companies/' + r.id}>{r.name}</Link>,
              },
              { key: 'category', label: 'Category' },
              { key: 'address_line1', label: 'Address' },
            ]}
          />
          <h3>Activity history</h3>
          <label className="ops-field">
            History period
            <select
              value={historyRange}
              onChange={(e) => setHistoryRange(e.target.value)}
            >
              <option value="all">All recorded history through today</option>
              <option value="period">Selected reporting month</option>
            </select>
          </label>
          <label className="ops-field">
            Activity program
            <select
              value={historyProgram}
              onChange={(e) => setHistoryProgram(e.target.value)}
            >
              <option value="selected">Selected workbook program</option>
              <option value="all">
                All programs, including unassigned legacy entries
              </option>
            </select>
          </label>
          <p>
            {history.length} recorded activities ·{' '}
            {activityTotals(history).touches} confirmed physical touches.
            History follows these company IDs; corrected city assignments do not
            duplicate activity.
          </p>
          <DataTable
            rows={history}
            columns={[
              { key: 'activity_date', label: 'Date' },
              {
                key: 'company_id',
                label: 'Prospect',
                render: (r) =>
                  allProspects.find((c) => c.id === r.company_id)?.name,
              },
              {
                key: 'program_id',
                label: 'Program',
                render: (r) =>
                  data.programs.find((p) => p.id === r.program_id)?.name ||
                  'Unassigned legacy entry',
              },
              { key: 'activity_type', label: 'Activity' },
              { key: 'type_of_contact', label: 'Contact method' },
              { key: 'number_of_activities', label: 'Count' },
              {
                key: 'user_id',
                label: 'Recorded by',
                render: (r) => {
                  const m = data.members.find((m) => m.user_id === r.user_id)
                  return m
                    ? [m.profile?.first_name, m.profile?.last_name].join(' ')
                    : r.source_rep_name || 'Legacy / unassigned'
                },
              },
              { key: 'visit_outcome', label: 'Outcome' },
              {
                key: 'open',
                label: 'Details',
                render: (r) => (
                  <Link to={'/activities/' + r.id + '/edit'}>
                    Open activity
                  </Link>
                ),
              },
            ]}
          />
        </Modal>
      )}
    </>
  )
}
