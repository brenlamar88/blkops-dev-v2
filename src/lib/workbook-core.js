import { effectiveGoal } from './goal-allocation.js'
import {
  admissions,
  BENCHMARKS,
  calendarMonths,
  categoryName,
  censusAverage,
  goalValue,
  plusDays,
  tierOf,
  weekdays,
} from './operations-core.js'

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]
export const CATEGORY_COLORS = {
  Eldercare: '#dcefe3',
  Hospitals: '#e9f1d7',
  Practitioners: '#fffbc9',
  'Mental Health': '#f8eadc',
  'Home Based Care': '#fff0ca',
  Community: '#f3d6d9',
}
export const rankBand = (n) =>
  n <= 20 ? 'top20' : n <= 40 ? 'next20' : n <= 120 ? 'next80' : 'remaining'
export const ratio = (n, d) => (d ? n / d : null)
export const percent = (value) =>
  value == null ? '—' : (100 * value).toFixed(1) + '%'
export function orderedTerritories(territories) {
  const priority = (name) => {
    const n = ['RED', 'WHITE', 'BLUE'].indexOf(
      String(name).trim().toUpperCase(),
    )
    return n < 0 ? 3 : n
  }
  return [...territories].sort(
    (a, b) =>
      priority(a.name) - priority(b.name) || a.name.localeCompare(b.name),
  )
}
export function recordCategory(data, record, program, categories = []) {
  const override = data.eligibility.find(
    (e) =>
      e.program_id === program && e.company_id === record.prospect_company_id,
  )?.category?.name
  const recorded = categories.find((c) => c.id === record.category_id)?.name
  const shared = data.companies.find(
    (c) => c.company_id === record.prospect_company_id,
  )?.company?.category?.name
  return categoryName(override || recorded || shared)
}
export function scopedEvents(
  data,
  program,
  from,
  to,
  { territory = '', user = '' } = {},
) {
  const match = (r) =>
    (!territory || r.territory_id === territory) &&
    (!user || r.submitted_by === user)
  return {
    referrals: data.referrals.filter(
      (r) =>
        r.program_id === program &&
        r.referral_date >= from &&
        r.referral_date <= to &&
        match(r),
    ),
    admissions: admissions(data.referrals, from, to, program).filter(match),
  }
}
export function annualScorecard(
  data,
  program,
  year,
  scope = {},
  through,
  categories = [],
) {
  let cumulative = 0,
    completeGoals = true
  const months = MONTHS.map((label, i) => {
    const from = `${year}-${String(i + 1).padStart(2, '0')}-01`,
      to = plusDays(calendarMonths(from, 1), -1),
      future = from > through,
      cutoff = to < through ? to : through
    const events = scopedEvents(data, program, from, cutoff, scope)
    // Use approved territory allocations for filtered views, never the entire unit target.
    const goal = (metric) =>
      effectiveGoal(data, {
        user: scope.user,
        territory: scope.territory,
        program,
        month: from,
        metric,
      })
    const admissionGoal = goal('admissions'),
      referralGoal = goal('referrals')
    const census = censusAverage(data.census, program, from, cutoff)
    const adcGoal = goalValue(data.goals, {
      program,
      month: from,
      metric: 'adc',
    })
    const variance =
      future || admissionGoal == null
        ? null
        : events.admissions.length - admissionGoal
    if (!future) {
      if (admissionGoal == null) completeGoals = false
      else cumulative += variance
    }
    return {
      label,
      from,
      to,
      cutoff,
      future,
      weekdays: weekdays(from, to),
      days: Number(to.slice(-2)),
      ...events,
      admissionGoal,
      referralGoal,
      variance,
      running: future || !completeGoals ? null : cumulative,
      conversion: ratio(events.admissions.length, events.referrals.length),
      adcGoal,
      adc: census.average,
      censusDays: census.recorded,
      elapsed: census.days,
    }
  })
  const events = scopedEvents(
    data,
    program,
    `${year}-01-01`,
    `${year}-12-31` < through ? `${year}-12-31` : through,
    scope,
  )
  const sourceMap = new Map()
  for (const kind of ['referrals', 'admissions'])
    for (const r of events[kind]) {
      // Keep each transaction's territory so a historic assignment is not silently moved.
      const companyId = r.prospect_company_id || '',
        category = recordCategory(data, r, program, categories),
        territoryId = r.territory_id || ''
      const key = JSON.stringify([companyId, territoryId, category])
      if (!sourceMap.has(key)) {
        const c = data.companies.find(
          (x) => x.company_id === companyId,
        )?.company
        sourceMap.set(key, {
          id: key,
          companyId,
          name: c?.name || 'Unlinked source',
          city: c?.city || '',
          category,
          territory_id: territoryId,
          referrals: Array(12).fill(0),
          admissions: Array(12).fill(0),
        })
      }
      const index =
        Number(
          (kind === 'referrals' ? r.referral_date : r.admit_denial_date).slice(
            5,
            7,
          ),
        ) - 1
      sourceMap.get(key)[kind][index]++
    }
  return { months, events, sources: [...sourceMap.values()] }
}
export function rankedSources(sources, metric) {
  let running = 0
  return sources
    .map((s) => ({ ...s, total: s[metric].reduce((a, b) => a + b, 0) }))
    .filter((s) => s.total > 0)
    .sort(
      (a, b) =>
        b.total - a.total ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
    .map((s, i) => ({ ...s, rank: i + 1, running: (running += s.total) }))
}
export function categoryMix(data, program, events, categories = []) {
  const geri =
    data.programs.find((p) => p.id === program)?.unit_type === 'Inpatient Geri'
  const names = new Set(geri ? Object.keys(BENCHMARKS) : [])
  data.eligibility
    .filter((e) => e.program_id === program && e.active)
    .forEach((e) =>
      names.add(
        recordCategory(
          data,
          { prospect_company_id: e.company_id },
          program,
          categories,
        ),
      ),
    )
  for (const r of [...events.referrals, ...events.admissions])
    names.add(recordCategory(data, r, program, categories))
  const rows = [...names].map((category) => {
    const referrals = events.referrals.filter(
      (r) => recordCategory(data, r, program, categories) === category,
    ).length
    const admits = events.admissions.filter(
      (r) => recordCategory(data, r, program, categories) === category,
    ).length
    const target = geri ? (BENCHMARKS[category] ?? null) : null
    return {
      id: category,
      category,
      target,
      referrals,
      admissions: admits,
      referralMix: ratio(referrals, events.referrals.length),
      admissionMix: ratio(admits, events.admissions.length),
    }
  })
  return rows.sort(
    (a, b) =>
      (b.target ?? -1) - (a.target ?? -1) ||
      b.admissions - a.admissions ||
      b.referrals - a.referrals ||
      a.category.localeCompare(b.category),
  )
}
export function adcPace(month) {
  if (!month || month.future || month.adcGoal == null || month.adc == null)
    return null
  const remaining = month.days - month.elapsed
  return {
    variance: month.adc - month.adcGoal,
    patientDays: (month.adc - month.adcGoal) * month.elapsed,
    remaining,
    required:
      remaining > 0
        ? Math.max(
            0,
            (month.adcGoal * month.days - month.adc * month.elapsed) /
              remaining,
          )
        : null,
  }
}
export function rotationAssignments(data, program) {
  const map = new Map()
  for (const plan of data.plans.filter(
    (p) => p.program_id === program && !p.archived_at,
  )) {
    for (const day of plan.body?.days || [])
      for (const stop of day.stops || []) {
        if (!map.has(stop.company_id)) map.set(stop.company_id, [])
        const key = plan.id + '|' + day.date
        if (!map.get(stop.company_id).some((x) => x.key === key))
          map.get(stop.company_id).push({
            key,
            date: day.date,
            owner: plan.user_id,
            week:
              Math.floor(
                (Date.parse(day.date) - Date.parse(plan.start_date)) /
                  604800000,
              ) + 1,
          })
      }
  }
  return map
}
export function prospectMatrix(
  pool,
  tab,
  territories,
  assignments = new Map(),
) {
  const columns = [
    ...orderedTerritories(territories).map((t) => ({ id: t.id, name: t.name })),
    { id: 'unassigned', name: 'Unassigned' },
  ]
  const rows = new Map()
  for (const c of pool) {
    const known = columns.find((t) => t.id === c.territory_id),
      t = known?.id || 'unassigned'
    let labels
    if (tab === 'TERRITORY BY ROTATION')
      labels = [
        ...new Set((assignments.get(c.id) || []).map((a) => 'Week ' + a.week)),
      ]
    else
      labels = [
        tab === 'DASHBOARD BY STATE'
          ? c.state
          : tab === 'DASHBOARD BY STATUS'
            ? c.prospect_status || c.status
            : tab === 'TERRITORY BY CATEGORY'
              ? c.category
              : columns.find((x) => x.id === t)?.name,
      ]
    if (!labels.length) labels = ['Unassigned']
    for (const raw of labels) {
      const label = raw || 'Unassigned'
      if (!rows.has(label))
        rows.set(label, {
          id: label,
          label,
          cells: Object.fromEntries(columns.map((x) => [x.id, []])),
          prospects: [],
        })
      rows.get(label).cells[t].push(c)
      rows.get(label).prospects.push(c)
    }
  }
  const result = [...rows.values()].sort((a, b) =>
    tab === 'TERRITORY BY CATEGORY'
      ? (BENCHMARKS[b.label] ?? -1) - (BENCHMARKS[a.label] ?? -1) ||
        b.prospects.length - a.prospects.length
      : tab === 'TERRITORY SEGMENTATION'
        ? columns.findIndex((t) => t.name === a.label) -
          columns.findIndex((t) => t.name === b.label)
        : a.label.localeCompare(b.label, undefined, { numeric: true }),
  )
  return { columns, rows: result, total: new Set(pool.map((p) => p.id)).size }
}
export function coverageRows(pool, events) {
  const refs = new Set(events.referrals.map((r) => r.prospect_company_id)),
    adms = new Set(events.admissions.map((r) => r.prospect_company_id)),
    groups = new Map()
  for (const p of pool) {
    const id = JSON.stringify([
      p.territory_id || '',
      (p.city || '').trim().toUpperCase(),
      p.state?.trim().toUpperCase() || '',
    ])
    if (!groups.has(id))
      groups.set(id, {
        id,
        territory_id: p.territory_id,
        city: p.city || 'Unknown city',
        state: p.state || '',
        prospects: [],
      })
    groups.get(id).prospects.push(p)
  }
  return [...groups.values()]
    .map((x) => ({
      ...x,
      ref: x.prospects.filter((c) => refs.has(c.id)),
      adm: x.prospects.filter((c) => adms.has(c.id)),
    }))
    .sort(
      (a, b) =>
        b.adm.length / b.prospects.length - a.adm.length / a.prospects.length ||
        b.ref.length / b.prospects.length - a.ref.length / a.prospects.length ||
        b.adm.length - a.adm.length ||
        a.city.localeCompare(b.city),
    )
}
