import { activityTotals, admissions, goalValue } from './operations-core.js'
const show = (v) => (v == null ? '?' : v)
const pct = (n, g) =>
  g > 0 ? ((n / g) * 100).toFixed(0) + '%' : 'budget needed'
export function reportText({ kind, data, date, user, facility, territories }) {
  const person = data.members.find((m) => m.user_id === user),
    territory =
      territories.find((t) => t.id === person?.territory_id)?.name ||
      'Unassigned'
  const own = data.activities.filter(
      (a) => a.user_id === user && a.activity_date === date,
    ),
    tot = activityTotals(own)
  const census = data.programs
    .filter((p) => p.active)
    .map((p) => ({
      p,
      c: data.census.find(
        (c) => c.program_id === p.id && c.census_date === date,
      ),
    }))
  if (kind === 'pm') {
    const labels = [
      ['Quality', 'Quality Touch'],
      ['F2F', 'Face to Face'],
      ['Cold Call', 'Cold Call'],
      ['HWD Survey', 'HWD Survey'],
      ['Leave Behind', 'Leave Behind'],
      ['Follow up', 'Follow-Up'],
      ['In service', 'In-Service'],
      ['Pre screen', 'Pre Screen'],
      ['Luncheon', 'Luncheon'],
      ['Thank you', "Thank You's"],
    ]
    return [
      'PM Report',
      territory,
      date,
      ...census.map(({ p, c }) => p.name + ' Census: ' + show(c?.actual)),
      '',
      'Total touches - ' + tot.touches,
      ...labels.map(([label, type]) => label + ' - ' + (tot.byType[type] || 0)),
      'Needs Analysis - ?',
      '',
      ...data.programs.map((p) => {
        const rs = data.referrals.filter(
          (r) =>
            r.submitted_by === user &&
            r.program_id === p.id &&
            r.referral_date === date,
        )
        const ads = admissions(
          data.referrals.filter((r) => r.submitted_by === user),
          date,
          date,
          p.id,
        ).length
        const pending = data.referrals.filter(
          (r) =>
            r.submitted_by === user &&
            r.program_id === p.id &&
            r.admission_status === 'Admit' &&
            r.arrival_confirmed !== true &&
            r.admit_denial_date === date,
        ).length
        return (
          p.name +
          ': Admits - ' +
          ads +
          ' confirmed' +
          (pending ? ' (' + pending + ' arrival not confirmed)' : '') +
          '; Referrals - ' +
          rs.length
        )
      }),
      'Inquiries - ?',
      'Dcs - ?',
      '',
      tot.unconfirmedPhysical
        ? tot.unconfirmedPhysical +
          ' recorded activities lack in-person confirmation and are excluded from physical-touch totals.'
        : '',
      '? = source not connected or not recorded. Counts are recorded activity; they do not certify completeness.',
    ]
      .filter((x) => x !== undefined)
      .join('\n')
  }
  const month = date.slice(0, 7) + '-01'
  const metricLines = (metric) =>
    data.members
      .filter((m) => m.role === 'rep')
      .map((m) => {
        const refs = data.referrals.filter((r) => r.submitted_by === m.user_id),
          acts = data.activities.filter(
            (a) =>
              a.user_id === m.user_id &&
              a.activity_date >= month &&
              a.activity_date <= date,
          )
        const actual =
          metric === 'admissions'
            ? admissions(refs, month, date).length
            : metric === 'referrals'
              ? refs.filter(
                  (r) => r.referral_date >= month && r.referral_date <= date,
                ).length
              : metric === 'quality_touches'
                ? activityTotals(acts).byType['Quality Touch'] || 0
                : activityTotals(acts).touches
        const goal = goalValue(data.goals, {
          user: m.user_id,
          program: '',
          month,
          metric,
        })
        return (
          (territories.find((t) => t.id === m.territory_id)?.name ||
            'Unassigned') +
          ' — ' +
          [m.profile?.first_name, m.profile?.last_name]
            .filter(Boolean)
            .join(' ') +
          ': ' +
          show(goal) +
          ' / ' +
          actual +
          ' ' +
          pct(actual, goal)
        )
      })
  return [
    'AM report: ' + date,
    facility,
    'Current Census: ' +
      (census.length && census.every((x) => x.c)
        ? census.reduce((s, x) => s + x.c.actual, 0)
        : '?'),
    ...census.map(
      ({ p, c }) =>
        p.name +
        ' Census Goal / Actual: ' +
        show(
          goalValue(data.goals, {
            user: '',
            program: p.id,
            month,
            metric: 'adc',
          }),
        ) +
        ' / ' +
        show(c?.actual),
    ),
    'Planned DCs: ?',
    'Pending Admits (current records through report date): ' +
      data.referrals.filter(
        (r) =>
          r.referral_date <= date &&
          r.admission_status === 'Admit' &&
          r.arrival_confirmed !== true &&
          (!r.admit_denial_date || r.admit_denial_date <= date),
      ).length,
    'Pending DCs: ?',
    'Planned In-services / Luncheons: ' +
      data.plans.flatMap((p) =>
        p.body.days
          .filter((d) => d.date === date)
          .flatMap((d) =>
            d.stops.filter((s) =>
              ['In-Service', 'Luncheon'].includes(s.planned_type),
            ),
          ),
      ).length,
    '',
    'KPI TRACKING — goal / month to date',
    'Admits per territory:',
    ...metricLines('admissions'),
    '',
    'Referral Goal vs MTD:',
    ...metricLines('referrals'),
    '',
    'QT goals vs Actual:',
    ...metricLines('quality_touches'),
    '',
    'TOTAL TOUCHES — confirmed in-person:',
    ...metricLines('touches'),
    '',
    '? = source or approved budget not available. Update original records to correct totals.',
  ].join('\n')
}
