import {
  activityTotals,
  admissions,
  goalValue,
  monday,
  plusDays,
  pace,
} from './operations-core.js'
import { effectiveGoal, weeklyBudgetRemainder } from './goal-allocation.js'
export function performance(data, user, from, to, program = '') {
  const activities = data.activities.filter(
      (a) =>
        (!user || a.user_id === user) &&
        a.activity_date >= from &&
        a.activity_date <= to &&
        (!program || a.program_id === program),
    ),
    t = activityTotals(activities)
  return {
    referrals: data.referrals.filter(
      (r) =>
        (!user || r.submitted_by === user) &&
        r.referral_date >= from &&
        r.referral_date <= to &&
        (!program || r.program_id === program),
    ).length,
    admissions: admissions(
      data.referrals.filter((r) => !user || r.submitted_by === user),
      from,
      to,
      program,
    ).length,
    touches: t.touches,
    quality_touches: t.byType['Quality Touch'] || 0,
    inservices: (t.byType['In-Service'] || 0) + (t.byType.Luncheon || 0),
    followups: t.byType['Follow-Up'] || 0,
    thankyous: t.byType["Thank You's"] || 0,
    surveys: t.byType['HWD Survey'] || 0,
    needs: (data.needs || []).filter(
      (n) =>
        (!user || n.submitted_by === user) &&
        n.source === 'user' &&
        new Date(n.submitted_at).toLocaleDateString('en-CA', {
          timeZone: 'America/Chicago',
        }) >= from &&
        new Date(n.submitted_at).toLocaleDateString('en-CA', {
          timeZone: 'America/Chicago',
        }) <= to,
    ).length,
    unconfirmed: t.unconfirmedPhysical,
  }
}
export function weeklyPulse(data, user, date, program = '') {
  const start = monday(date),
    actual = performance(data, user, start, date, program),
    monthStart = date.slice(0, 7) + '-01',
    monthly = performance(data, user, monthStart, date, program)
  const reps = data.members.filter((m) => m.role === 'rep'),
    people = user ? 1 : reps.length
  return [
    'touches',
    'quality_touches',
    'referrals',
    'admissions',
    'inservices',
    'followups',
    'thankyous',
    'needs',
    'surveys',
  ].map((metric) => {
    const explicit = goalValue(data.goals, {
      user,
      program,
      month: start,
      metric,
      cadence: 'weekly',
    })
    const monthGoal =
      effectiveGoal(data, { user, program, month: monthStart, metric }) ??
      (metric === 'inservices' && !program && people ? 2 * people : null)
    // Remaining monthly work is spread over the remaining working days; approved weekly commitments take precedence.
    let derived = null
    if (['referrals', 'admissions'].includes(metric)) {
      const segmentStart = start < monthStart ? monthStart : start,
        prior = performance(
          data,
          user,
          monthStart,
          plusDays(segmentStart, -1),
          program,
        )
      derived = weeklyBudgetRemainder(monthGoal, prior[metric], segmentStart)
      if (start < monthStart) derived = null // An explicit cross-month commitment is needed rather than silently mixing budgets.
    }
    const target =
      explicit ??
      (metric === 'touches' && !program && people ? 60 * people : derived)
    return {
      id: metric,
      metric,
      actual: actual[metric],
      target,
      remaining: target == null ? null : Math.max(0, target - actual[metric]),
      monthly: pace(monthly[metric], monthGoal, date).label,
      monthGoal,
      monthActual: monthly[metric],
      basis:
        explicit != null
          ? 'Approved weekly commitment'
          : derived != null
            ? 'Remaining monthly budget'
            : metric === 'touches'
              ? '60 per representative'
              : 'Target / due-task feed needed',
    }
  })
}
export function territoryRelationships(data, territories, date) {
  const cutoff = plusDays(date, -90)
  return ['RED', 'WHITE', 'BLUE'].map((name) => {
    const t = territories.find((t) => t.name.toUpperCase() === name),
      map = new Map()
    if (t)
      for (const r of admissions(data.referrals, '0001-01-01', date).filter(
        (r) => r.territory_id === t.id,
      )) {
        if (!r.prospect_company_id) continue
        const c = data.companies.find(
          (c) => c.company_id === r.prospect_company_id,
        )?.company
        if (!c || !c.active || c.status === 'closed' || c.merged_into_id)
          continue
        if (!map.has(c.id))
          map.set(c.id, {
            id: c.id,
            name: c.name,
            prior: 0,
            recent: 0,
            last: '',
          })
        const s = map.get(c.id)
        if (r.admit_denial_date < cutoff) s.prior++
        else s.recent++
        if (r.admit_denial_date > s.last) s.last = r.admit_denial_date
      }
    return {
      name,
      recover: [...map.values()]
        .filter((s) => s.prior > 0 && !s.recent)
        .sort((a, b) => b.prior - a.prior || a.last.localeCompare(b.last))
        .slice(0, 3),
      maintain: [...map.values()]
        .filter((s) => s.recent > 0)
        .sort((a, b) => b.recent - a.recent || b.last.localeCompare(a.last))
        .slice(0, 3),
    }
  })
}
export function sourceRanking(
  data,
  program,
  from,
  to,
  territory = '',
  user = '',
) {
  const refers = data.referrals.filter(
    (r) =>
      (!program || r.program_id === program) &&
      r.referral_date >= from &&
      r.referral_date <= to &&
      (!territory || r.territory_id === territory) &&
      (!user || r.submitted_by === user),
  )
  const admits = admissions(data.referrals, from, to, program).filter(
    (r) =>
      (!territory || r.territory_id === territory) &&
      (!user || r.submitted_by === user),
  )
  const map = new Map()
  for (const r of [...refers, ...admits]) {
    const id = r.prospect_company_id || 'unknown'
    if (!map.has(id)) {
      const c = data.companies.find((x) => x.company_id === id)
      map.set(id, {
        id,
        name: c?.company?.name || 'Unlinked source',
        city: c?.company?.city || '',
        territory_id: c?.territory_id,
        category: c?.company?.category?.name || 'Unassigned',
        referrals: 0,
        admissions: 0,
      })
    }
  }
  for (const r of refers)
    map.get(r.prospect_company_id || 'unknown').referrals++
  for (const r of admits)
    map.get(r.prospect_company_id || 'unknown').admissions++
  return [...map.values()]
}
