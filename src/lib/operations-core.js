// Shared rules ported from the approved working workbook. No independent report totals.
export const BENCHMARKS = {
  Eldercare: 0.4,
  Hospitals: 0.2,
  Practitioners: 0.15,
  'Mental Health': 0.125,
  'Home Based Care': 0.075,
  Community: 0.05,
}
export const EXPENSE_CATEGORIES = [
  'Lodging',
  'Meals & Entertainment',
  'Airfare',
  'Transportation/Taxi',
  'Supplies',
  'Rental Car',
  'Advertising',
  'Misc',
]
export const chicagoToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
export const plusDays = (date, n) =>
  new Date(Date.parse(date + 'T12:00:00Z') + n * 86400000)
    .toISOString()
    .slice(0, 10)
export function monday(date) {
  return plusDays(date, -((new Date(date + 'T12:00Z').getUTCDay() + 6) % 7))
}
export function calendarMonths(date, n) {
  const d = new Date(date + 'T12:00Z'),
    day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + n)
  d.setUTCDate(
    Math.min(
      day,
      new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
      ).getUTCDate(),
    ),
  )
  return d.toISOString().slice(0, 10)
}
export function weekdays(from, to) {
  let n = 0
  for (let d = from; d <= to; d = plusDays(d, 1))
    if (new Date(d + 'T12:00Z').getUTCDay() % 6 !== 0) n++
  return n
}
export const categoryName = (value) =>
  ({
    hospital: 'Hospitals',
    practitioner: 'Practitioners',
    eldercare: 'Eldercare',
    'home based care': 'Home Based Care',
    'mental health': 'Mental Health',
    community: 'Community',
  })[String(value ?? '').toLowerCase()] ||
  value ||
  'Unassigned'
export const tierOf = (c) =>
  ['Eldercare', 'Hospitals'].includes(categoryName(c.category)) ||
  c.medical_director_rounds
    ? 'Primary'
    : c.tier || 'Secondary'
// Daily rotation fills Primary accounts first, then Secondary, then Tertiary.
// Unknown tiers sort with Secondary so they never jump ahead of Primary.
export const TIER_PRIORITY = { Primary: 0, Secondary: 1, Tertiary: 2 }
export const tierRank = (c) => TIER_PRIORITY[tierOf(c)] ?? 1
export function spacingAllowed(tier, date, dates) {
  return dates.every((other) => {
    const a = other < date ? other : date,
      b = other < date ? date : other
    return (
      b >=
      (tier === 'Primary'
        ? plusDays(a, 14)
        : calendarMonths(a, tier === 'Tertiary' ? 3 : 1))
    )
  })
}
export function physical(a) {
  return (
    a.visit_outcome === 'completed' &&
    a.in_person === true &&
    a.type_of_contact !== 'Telephone Call' &&
    a.activity_type !== 'Cold Call'
  )
}
export function activityTotals(rows) {
  const unique = [...new Map(rows.map((a) => [a.id, a])).values()],
    done = unique.filter(
      (a) => a.visit_outcome !== 'closed' && a.visit_outcome !== 'unsuccessful',
    )
  const byType = {}
  for (const a of done)
    byType[a.activity_type] =
      (byType[a.activity_type] || 0) + Number(a.number_of_activities || 1)
  return {
    touches: done
      .filter(physical)
      .reduce((n, a) => n + Number(a.number_of_activities || 1), 0),
    recordedTouches: done.reduce(
      (n, a) => n + Number(a.number_of_activities || 1),
      0,
    ),
    byType,
    unconfirmedPhysical: done.filter((a) => a.in_person == null).length,
  }
}
export function admissions(rows, from, to, program = '') {
  return rows.filter(
    (r) =>
      r.admission_status === 'Admit' &&
      r.arrival_confirmed === true &&
      r.admit_denial_date >= from &&
      r.admit_denial_date <= to &&
      (!program || r.admitted_program_id === program),
  )
}
export function goalValue(
  goals,
  { user, program, month, metric, cadence = 'monthly' },
) {
  const scope = goals.filter(
    (g) =>
      (g.user_id || '') === (user || '') &&
      (g.program_id || '') === (program || '') &&
      g.metric === metric &&
      g.cadence === cadence,
  )
  const exact = scope.filter((g) => g.period_start === month)
  if (exact.length) return exact.length === 1 ? Number(exact[0].target) : null
  // Carry forward the corresponding calendar month, never silently zero a missing annual budget.
  const prior =
    cadence === 'monthly'
      ? scope
          .filter(
            (g) =>
              g.period_start < month &&
              g.period_start.slice(5) === month.slice(5),
          )
          .sort((a, b) => b.period_start.localeCompare(a.period_start))
      : []
  return prior.length ? Number(prior[0].target) : null
}
export function pace(actual, goal, date) {
  if (goal == null)
    return { label: 'Budget needed', expected: null, remaining: null }
  const start = date.slice(0, 7) + '-01',
    end = plusDays(calendarMonths(start, 1), -1)
  const expected = (goal * weekdays(start, date)) / weekdays(start, end)
  return {
    label:
      actual >= goal
        ? 'Goal met'
        : actual >= expected
          ? 'On pace'
          : 'Behind pace',
    expected,
    remaining: Math.max(0, goal - actual),
  }
}
export function moneyToCents(s) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(s)))
    throw Error('Enter an amount with at most two decimal places')
  const n = Math.round(Number(s) * 100)
  if (!Number.isSafeInteger(n) || n <= 0 || n > 100000000)
    throw Error('Enter a positive amount up to $1,000,000')
  return n
}
export const money = (cents) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    Number(cents || 0) / 100,
  )
export function cashBalance(entries, expenses, through = '9999-12-31') {
  return (
    entries
      .filter((e) => !e.voided && e.received_on <= through)
      .reduce(
        (s, e) => s + (e.kind === 'return' ? -1 : 1) * Number(e.cents),
        0,
      ) -
    expenses
      .filter(
        (e) =>
          !e.voided && e.payment === 'Cash advance' && e.spent_on <= through,
      )
      .reduce((s, e) => s + Number(e.cents), 0)
  )
}
export function onTime(start, submitted) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(submitted))
      .map((x) => [x.type, x.value]),
  )
  return (
    parts.year +
      '-' +
      parts.month +
      '-' +
      parts.day +
      'T' +
      parts.hour +
      ':' +
      parts.minute +
      ':' +
      parts.second <=
    plusDays(start, 7) + 'T10:00:00'
  )
}
export const fullAddress = (c) =>
  [c.address_line1, c.city, c.state, c.zip].filter(Boolean).join(', ')
export function mapLink(c, origin = '', apple = false) {
  const d = encodeURIComponent(fullAddress(c))
  return apple
    ? 'https://maps.apple.com/?daddr=' +
        d +
        '&saddr=' +
        encodeURIComponent(origin)
    : 'https://www.google.com/maps/dir/?api=1&destination=' +
        d +
        '&origin=' +
        encodeURIComponent(origin)
}
export function routeHistory(plans, activities, exclude) {
  const h = new Map(),
    add = (id, date) => {
      if (!h.has(id)) h.set(id, new Set())
      h.get(id).add(date)
    }
  for (const p of plans.filter((p) => p.id !== exclude))
    for (const d of p.body.days)
      for (const s of d.stops) {
        const attempts = activities.filter(
          (a) => a.company_id === s.company_id && a.activity_date === d.date,
        )
        if (
          !attempts.some((a) =>
            ['closed', 'unsuccessful', 'leave_behind'].includes(
              a.visit_outcome,
            ),
          ) ||
          attempts.some(physical)
        )
          add(s.company_id, d.date)
      }
  for (const a of activities.filter(physical))
    if (a.company_id) add(a.company_id, a.activity_date)
  return h
}
export function eligible(c, date, history) {
  return (
    c.active !== false &&
    c.status !== 'closed' &&
    !c.merged_into_id &&
    c.address_line1 &&
    spacingAllowed(tierOf(c), date, [...(history.get(c.id) || [])])
  )
}
export function fieldGoal(date, windows, program) {
  return new Date(date + 'T12:00Z').getUTCDay() === 1
    ? 12
    : windows.some(
          (w) =>
            w.program_id === program &&
            w.approved_by &&
            date >= w.starts &&
            date <= w.ends,
        )
      ? 18
      : 15
}
export function buildFiveWeeks({
  start,
  pool,
  history,
  windows = [],
  program,
  address = '',
  corridors,
}) {
  const h = new Map([...history].map(([k, v]) => [k, new Set(v)])),
    counts = {},
    days = []
  for (let i = 0; i < 25; i++) {
    const date = plusDays(start, Math.floor(i / 5) * 7 + (i % 5)),
      goal = fieldGoal(date, windows, program),
      cities = corridors[Math.floor(i / 5) % 2][i % 5],
      stops = []
    while (stops.length < goal) {
      const candidates = pool.filter(
        (c) => cities.includes(c.city.toUpperCase()) && eligible(c, date, h),
      )
      const total = Object.values(counts).reduce((a, b) => a + b, 0) + 1
      // Tier wins first — Primary accounts are scheduled ahead of Secondary (and
      // Tertiary). Category balance and name break ties within a tier.
      candidates.sort(
        (a, b) =>
          tierRank(a) - tierRank(b) ||
          (BENCHMARKS[b.category] || 0) * total -
            (counts[b.category] || 0) -
            ((BENCHMARKS[a.category] || 0) * total -
              (counts[a.category] || 0)) || a.name.localeCompare(b.name),
      )
      const c = candidates[0]
      if (!c) break
      stops.push({
        company_id: c.id,
        tier: tierOf(c),
        minutes: 20,
        planned_type: 'Face to Face',
      })
      counts[c.category] = (counts[c.category] || 0) + 1
      if (!h.has(c.id)) h.set(c.id, new Set())
      h.get(c.id).add(date)
    }
    stops.sort((a, b) => {
      const x = pool.find((c) => c.id === a.company_id),
        y = pool.find((c) => c.id === b.company_id)
      return (
        cities.indexOf(x.city.toUpperCase()) -
          cities.indexOf(y.city.toUpperCase()) ||
        x.address_line1.localeCompare(y.address_line1)
      )
    })
    days.push({ date, goal, cities, start: address, end: address, stops })
  }
  return { days }
}
export function suggestedCorridors(pool) {
  const cities = [...new Set(pool.map((c) => c.city.toUpperCase()))]
  cities.sort(
    (a, b) =>
      Math.min(
        ...pool
          .filter((c) => c.city.toUpperCase() === a)
          .map((c) => c.distance_miles ?? 999),
      ) -
        Math.min(
          ...pool
            .filter((c) => c.city.toUpperCase() === b)
            .map((c) => c.distance_miles ?? 999),
        ) || a.localeCompare(b),
  )
  const near = cities.slice(0, Math.max(1, Math.ceil(cities.length / 4))),
    far = cities.slice(near.length)
  const pick = (list, i) => [list[i % list.length]].filter(Boolean)
  return [0, 1].map((w) => [
    near,
    pick(far, w * 3),
    pick(far, w * 3 + 1),
    pick(far, w * 3 + 2),
    near,
  ])
}
// A rotation stop counts as completed when the route's rep logged a qualifying
// activity at that company on that day. Qualifying = a Quality Touch or a Face
// to Face (the two in-person visit types); other activity types (calls, cold
// calls, leave-behinds, follow-ups) do not complete the stop. Program is not
// required to match — production activity entry does not tag program_id.
const COMPLETING_ACTIVITY_TYPES = ['Quality Touch', 'Face to Face']
export function stopCompleted(day, stop, activities, user /* program */) {
  return activities.some(
    (a) =>
      a.user_id === user &&
      a.company_id === stop.company_id &&
      a.activity_date === day.date &&
      COMPLETING_ACTIVITY_TYPES.includes(a.activity_type),
  )
}
export function backupCandidates(pool, day, history) {
  return pool
    .filter(
      (c) =>
        day.cities.includes(c.city.toUpperCase()) &&
        !day.stops.some((s) => s.company_id === c.id) &&
        eligible(c, day.date, history),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 3)
}

// Approved Lake Charles city groupings, carried over from the working rotation.
export const LAKE_CHARLES_CORRIDORS = {
  RED: [
    [
      ['LAKE CHARLES', 'WESTLAKE'],
      ['BEAUMONT'],
      ['PORT ARTHUR', 'NEDERLAND'],
      ['SILSBEE', 'LUMBERTON', 'VIDOR'],
      ['LAKE CHARLES', 'SULPHUR'],
    ],
    [
      ['LAKE CHARLES', 'VINTON'],
      ['BEAUMONT'],
      ['WOODVILLE', 'NEWTON'],
      ['GROVES', 'NEDERLAND', 'PORT NECHES'],
      ['LAKE CHARLES', 'SULPHUR', 'MOSS BLUFF'],
    ],
  ],
  WHITE: [
    [
      ['WELSH', 'JENNINGS'],
      ['LAFAYETTE', 'CARENCRO'],
      ['ALEXANDRIA'],
      ['VILLE PLATTE', 'OPELOUSAS'],
      ['KINDER', 'OBERLIN', 'ELTON'],
    ],
    [
      ['CROWLEY', 'RAYNE'],
      ['LAFAYETTE', 'SCOTT'],
      ['PINEVILLE'],
      ['EUNICE'],
      ['WELSH', 'JENNINGS'],
    ],
  ],
  BLUE: [
    [
      ['ORANGE', 'BUNA'],
      ['LIBERTY', 'DAYTON', 'CLEVELAND'],
      ['LUFKIN', 'DIBOLL'],
      ['LIVINGSTON', 'CORRIGAN'],
      ['JASPER', 'KIRBYVILLE'],
    ],
    [
      ['ORANGE', 'KOUNTZE', 'SOUR LAKE'],
      ['CROCKETT', 'TRINITY', 'HUNTSVILLE'],
      ['LUFKIN', 'HUNTINGTON'],
      ['BAYTOWN', 'MONT BELVIEU'],
      ['JASPER', 'KIRBYVILLE', 'BUNA'],
    ],
  ],
}
export function defaultCorridors(pool, slug, territory) {
  return slug === 'lakecharles' &&
    LAKE_CHARLES_CORRIDORS[String(territory).toUpperCase()]
    ? structuredClone(LAKE_CHARLES_CORRIDORS[String(territory).toUpperCase()])
    : suggestedCorridors(pool)
}
export function cashRegister(entries, expenses) {
  const movements = [
    ...entries
      .filter((e) => !e.voided)
      .map((e) => ({
        ...e,
        date: e.received_on,
        description: e.reference,
        change: e.kind === 'return' ? -Number(e.cents) : Number(e.cents),
        type: e.kind,
      })),
    ...expenses
      .filter((e) => !e.voided && e.payment === 'Cash advance')
      .map((e) => ({
        ...e,
        date: e.spent_on,
        change: -Number(e.cents),
        type: 'expense',
      })),
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  )
  let balance = 0
  return movements.map((e) => ({ ...e, balance: (balance += e.change) }))
}

// Only closed days are due. In-progress and future days cannot count as missed.
export function weeklyDeviation(days, activities, user, program, today) {
  const weeks = new Map()
  for (const day of days) {
    const key = monday(day.date)
    if (!weeks.has(key)) weeks.set(key, { week: key, due: 0, completed: 0 })
    if (day.date >= today) continue
    const w = weeks.get(key)
    w.due += day.stops.length
    w.completed += day.stops.filter((s) =>
      stopCompleted(day, s, activities, user, program),
    ).length
  }
  return [...weeks.values()].map((w) => ({
    ...w,
    percent: w.due ? ((w.due - w.completed) / w.due) * 100 : 0,
  }))
}
export function censusAverage(rows, program, from, through) {
  const values = new Map(
    rows
      .filter(
        (r) =>
          r.program_id === program &&
          r.census_date >= from &&
          r.census_date <= through &&
          r.actual != null,
      )
      .map((r) => [r.census_date, Number(r.actual)]),
  )
  let days = 0
  for (let d = from; d <= through; d = plusDays(d, 1)) days++
  return {
    days,
    recorded: values.size,
    average:
      days && values.size === days
        ? [...values.values()].reduce((s, v) => s + v, 0) / days
        : null,
  }
}
