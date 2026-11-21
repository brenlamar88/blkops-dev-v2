import {
  goalValue,
  weekdays,
  calendarMonths,
  plusDays,
} from './operations-core.js'
export function allocationRule(program) {
  if (program?.unit_type === 'Inpatient Geri')
    return { category: 'Eldercare', territories: ['RED', 'WHITE', 'BLUE'] }
  if (program?.unit_type === 'Inpatient Adol')
    return { category: 'Hospitals', territories: ['RED', 'WHITE'] }
  return null
}
// Largest remainder preserves the approved whole-number total; ties use Red, White, Blue.
export function allocateGoal(sourceTarget, counts) {
  const target = Math.ceil(Number(sourceTarget)),
    denominator = counts.reduce((s, r) => s + r.count, 0)
  if (!Number.isFinite(target) || target < 0 || !denominator) return null
  const rows = counts.map((r, i) => ({
    ...r,
    order: i,
    share: r.count / denominator,
    target: Math.floor((target * r.count) / denominator),
    remainder: ((target * r.count) / denominator) % 1,
  }))
  const extras = target - rows.reduce((s, r) => s + r.target, 0)
  ;[...rows]
    .sort((a, b) => b.remainder - a.remainder || a.order - b.order)
    .slice(0, extras)
    .forEach((r) => r.target++)
  return { sourceTarget: Number(sourceTarget), target, denominator, rows }
}
export function budgetCounts(data, program, territories) {
  const rule = allocationRule(program)
  if (!rule) return []
  return rule.territories.map((name) => {
    const territory = territories.find(
      (t) => t.name.trim().toUpperCase() === name,
    )
    const ids = new Set(
      data.eligibility
        .filter(
          (e) =>
            e.active &&
            e.program_id === program.id &&
            (
              e.category?.name ||
              data.companies.find((c) => c.company_id === e.company_id)?.company
                ?.category?.name ||
              ''
            )
              .toLowerCase()
              .replace(/[^a-z]/g, '') === rule.category.toLowerCase(),
        )
        .filter((e) => {
          const fc = data.companies.find((c) => c.company_id === e.company_id)
          return (
            territory &&
            fc?.active &&
            fc.territory_id === territory.id &&
            fc.company?.active &&
            fc.company.status !== 'closed' &&
            !fc.company.merged_into_id
          )
        })
        .map((e) => e.company_id),
    )
    return { id: territory?.id, name, count: ids.size }
  })
}
export function effectiveGoal(
  data,
  {
    user = '',
    territory = '',
    program = '',
    month,
    metric,
    cadence = 'monthly',
  },
) {
  const direct = !territory
    ? goalValue(data.goals, { user, program, month, metric, cadence })
    : null
  if (direct != null) return direct
  if (cadence !== 'monthly' || !['referrals', 'admissions'].includes(metric))
    return null
  const member = data.members.find((m) => m.user_id === user),
    tid = territory || member?.territory_id
  if (
    user &&
    (!tid ||
      data.members.filter((m) => m.role === 'rep' && m.territory_id === tid)
        .length !== 1 ||
      member.role !== 'rep')
  )
    return null
  const programs = program
    ? [program]
    : data.programs.filter((p) => p.active).map((p) => p.id)
  const values = programs.map((pid) => {
    if (!tid) return goalValue(data.goals, { program: pid, month, metric })
    const matches = (data.allocations || [])
      .filter(
        (g) =>
          g.program_id === pid &&
          g.period_start <= month &&
          g.period_start.slice(5) === month.slice(5) &&
          g.metric === metric &&
          g.territory_id === tid,
      )
      .sort((a, b) => b.period_start.localeCompare(a.period_start))
    const records = matches.filter(
      (g) => g.period_start === matches[0]?.period_start,
    )
    return records.length === 1 ? Number(records[0].target) : null
  })
  return values.length && values.every((v) => v != null)
    ? values.reduce((a, b) => a + b, 0)
    : null
}
export function weeklyBudgetRemainder(monthlyGoal, priorActual, weekStart) {
  if (monthlyGoal == null) return null
  const monthEnd = plusDays(
      calendarMonths(weekStart.slice(0, 7) + '-01', 1),
      -1,
    ),
    friday = plusDays(weekStart, 4),
    end = friday < monthEnd ? friday : monthEnd,
    days = weekdays(weekStart, monthEnd)
  return days
    ? Math.ceil(
        (Math.max(0, monthlyGoal - priorActual) * weekdays(weekStart, end)) /
          days,
      )
    : 0
}

export function budgetCarryForward(data, month) {
  const used = [
    ...(data.goals || []).filter((g) => g.cadence === 'monthly'),
    ...(data.allocations || []),
  ]
    .filter(
      (g) =>
        g.period_start < month && g.period_start.slice(5) === month.slice(5),
    )
    .sort((a, b) => b.period_start.localeCompare(a.period_start))
  const current = [...(data.goals || []), ...(data.allocations || [])].filter(
    (g) => g.period_start === month,
  )
  const key = (g) =>
    [g.user_id || '', g.territory_id || '', g.program_id || '', g.metric].join(
      '|',
    )
  const latest = [
    ...new Map([...used].reverse().map((g) => [key(g), g])).values(),
  ]
  const missing = latest.filter((g) => !current.some((c) => key(c) === key(g)))
  return missing.length
    ? 'Prior approved budget carried forward where ' +
        month.slice(0, 4) +
        ' goals are missing. Source year(s): ' +
        [...new Set(missing.map((g) => g.period_start.slice(0, 4)))]
          .sort()
          .join(', ') +
        '. Upload and approve the new budget in Programs & Budgets.'
    : ''
}
