import { Link } from 'react-router-dom'
import {
  annualScorecard,
  rankedSources,
  categoryMix,
  MONTHS,
  percent,
  rankBand,
  CATEGORY_COLORS,
} from '../lib/workbook-core'
import { DataTable } from './ui'
export default function AnnualScorecard({
  data,
  program,
  year,
  through,
  territory,
  user,
  metric,
  categories,
  territories,
}) {
  const card = annualScorecard(
      data,
      program,
      year,
      { territory, user },
      through,
      categories,
    ),
    sources = rankedSources(card.sources, metric),
    mix = categoryMix(data, program, card.events, categories)
  const measures = [
    ['Admission goal', 'admissionGoal'],
    ['Referral goal', 'referralGoal'],
    ['Referrals', 'referrals'],
    ['Confirmed admissions', 'admissions'],
    ['Admission goal variance', 'variance'],
    ['Running admission variance', 'running'],
    ['Conversion ratio', 'conversion'],
    ['Weekdays (Mon–Fri)', 'weekdays'],
    ['ADC goal', 'adcGoal'],
    ['ADC actual', 'adc'],
    ['ADC variance', 'adcVariance'],
  ]
  const fmt = (m, k) => {
    if (k === 'weekdays') return m.weekdays
    if (m.future && !['admissionGoal', 'referralGoal', 'adcGoal'].includes(k))
      return '—'
    const v =
      k === 'adcVariance'
        ? m.adc != null && m.adcGoal != null
          ? m.adc - m.adcGoal
          : null
        : m[k]
    if (v == null) return '—'
    if (Array.isArray(v)) return v.length
    if (k === 'conversion') return percent(v)
    return Number.isInteger(v) ? v : Number(v).toFixed(1)
  }
  return (
    <>
      <section className="card card-body">
        <h2>{year} · monthly scorecard</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Measure</th>
                {MONTHS.map((m) => (
                  <th key={m}>{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {measures.map(([label, key]) => (
                <tr key={key}>
                  <th>{label}</th>
                  {card.months.map((m) => (
                    <td key={m.from}>{fmt(m, key)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Actuals through {through}. ADC requires every elapsed day's census.
          Goals use approved unit or territory allocations. A blank goal remains
          unknown. Conversion compares period admissions and referrals, not a
          matched referral cohort.
        </p>
      </section>
      <section className="card card-body">
        <h2>
          {metric === 'referrals' ? 'Referral' : 'Admission'} sources · annual
          ranking
        </h2>
        <DataTable
          rows={sources}
          columns={[
            {
              key: 'rank',
              label: 'Rank',
              render: (r) => (
                <span className={'score-rank ' + rankBand(r.rank)}>
                  {r.rank}
                </span>
              ),
            },
            {
              key: 'name',
              label: 'Source',
              render: (r) =>
                r.companyId ? (
                  <Link to={'/companies/' + r.companyId}>{r.name}</Link>
                ) : (
                  r.name
                ),
            },
            { key: 'city', label: 'City' },
            { key: 'category', label: 'Category' },
            {
              key: 'territory_id',
              label: 'Territory',
              render: (r) =>
                territories.find((t) => t.id === r.territory_id)?.name ||
                'Unassigned',
            },
            ...MONTHS.map((m, i) => ({
              key: m,
              label: m,
              render: (r) => r[metric][i],
            })),
            { key: 'total', label: 'Total' },
            { key: 'running', label: 'Running total' },
          ]}
        />
      </section>
      <section className="card card-body">
        <h2>Category benchmarks versus actual</h2>
        <DataTable
          rows={mix}
          columns={[
            {
              key: 'category',
              label: 'Category',
              render: (r) => (
                <span
                  style={{
                    background: CATEGORY_COLORS[r.category] || '#eee',
                    padding: '4px 8px',
                  }}
                >
                  {r.category}
                </span>
              ),
            },
            {
              key: 'target',
              label: 'Benchmark',
              render: (r) =>
                r.target == null
                  ? 'Awaiting program benchmark'
                  : percent(r.target),
            },
            { key: 'referrals', label: 'Referrals' },
            {
              key: 'referralMix',
              label: 'Referral mix',
              render: (r) => percent(r.referralMix),
            },
            { key: 'admissions', label: 'Admissions' },
            {
              key: 'admissionMix',
              label: 'Admission mix',
              render: (r) => percent(r.admissionMix),
            },
          ]}
        />
        <p>
          Geriatric category benchmarks remain separate from territory budget
          allocation. Adolescent category benchmarks await Jason's approved
          standards.
        </p>
      </section>
    </>
  )
}
