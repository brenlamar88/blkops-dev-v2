import { useState, useEffect } from 'react'

import { Link, useSearchParams } from 'react-router-dom'

import { useApp, useQuery } from '../lib/data'

import { supabase } from '../lib/supabase'

import { useOperations, programPool, rpc } from '../lib/operations'

import {
  OpsHead,
  OpsState,
  ProgramPick,
  PersonPick,
} from '../components/Operations'

import { Banner, Modal } from '../components/ui'

import {
  chicagoToday,
  monday,
  plusDays,
  buildFiveWeeks,
  defaultCorridors,
  routeHistory,
  backupCandidates,
  eligible,
  tierOf,
  fullAddress,
  mapLink,
  stopCompleted,
  weeklyDeviation,
} from '../lib/operations-core'

export default function Rotations() {
  const app = useApp(),
    q = useOperations(),
    data = q.data,
    [params] = useSearchParams()

  const [program, setProgram] = useState(params.get('program') || ''),
    [territory, setTerritory] = useState(''),
    [owner, setOwner] = useState(app.profile.id)

  const [start, setStart] = useState(monday(chicagoToday())),
    [draft, setDraft] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)

  const [dayDate, setDayDate] = useState(params.get('day') || ''),
    [view, setView] = useState('rotation'),
    [search, setSearch] = useState(''),
    [service, setService] = useState(''),
    [serviceType, setServiceType] = useState('In-Service')

  const [corridors, setCorridors] = useState(null),
    [flag, setFlag] = useState(null),
    [reason, setReason] = useState(''),
    [flagKind, setFlagKind] = useState('Closed')

  const [low, setLow] = useState(false),
    [lowEnd, setLowEnd] = useState(plusDays(chicagoToday(), 14)),
    [initials, setInitials] = useState('')

  useEffect(() => {
    setProgram('')
    setTerritory('')
    setDraft(null)
    setCorridors(null)
    setOwner(app.profile.id)
  }, [app.facilityId])

  useEffect(() => {
    if (data && !program)
      setProgram(
        data.programs.find((p) => p.unit_type === 'Inpatient Geri')?.id ||
          data.programs[0]?.id ||
          '',
      )
    if (data && !territory)
      setTerritory(
        data.members.find((m) => m.user_id === owner)?.territory_id || '',
      )
  }, [data, program, territory, owner])

  const pool = programPool(data, program, territory),
    current = data?.plans.find(
      (p) =>
        p.program_id === program &&
        p.territory_id === territory &&
        p.start_date === start,
    )

  const body = draft || current?.body,
    day = body?.days.find((d) => d.date === dayDate),
    history = routeHistory(
      data?.plans || [],
      data?.activities || [],
      current?.id,
    )

  const canEdit = app.isManager || owner === app.profile.id

  useEffect(() => {
    if (current && current.user_id !== owner) setOwner(current.user_id)
  }, [current?.id])

  useEffect(() => {
    if (data && params.get('day')) {
      const p = data.plans.find(
        (p) =>
          p.user_id === app.profile.id &&
          p.body.days.some((d) => d.date === params.get('day')) &&
          (!params.get('program') || p.program_id === params.get('program')),
      )
      if (p) {
        setProgram(p.program_id)
        setTerritory(p.territory_id)
        setStart(p.start_date)
      }
    }
  }, [data?.plans, params.get('day')])

  const archive = useQuery(
    () =>
      view === 'archive' && current
        ? supabase
            .from('operations_audit')
            .select('*')
            .eq('entity', 'rotation_plans')
            .eq('entity_id', current.id)
            .order('id', { ascending: false })
        : null,
    [view, current?.id],
  )

  async function action(fn) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  function changeDay(next) {
    setDraft({
      ...body,
      days: body.days.map((d) => (d.date === next.date ? next : d)),
    })
  }

  function generate() {
    if (!program || !territory || !owner)
      throw Error('Choose a program, territory and assigned marketer')

    if (new Date(start + 'T12:00Z').getUTCDay() !== 1)
      throw Error('Choose a Monday')

    const corridorsNow =
      corridors ||
      defaultCorridors(
        pool,
        app.facility.slug,
        app.lookups.territories?.find((t) => t.id === territory)?.name,
      )

    setDraft(
      buildFiveWeeks({
        start,
        pool,
        history,
        windows: data.low,
        program,
        address: app.facility.street_address || '',
        corridors: corridorsNow,
      }),
    )
  }

  function addService(id, type = 'Face to Face', backup = false) {
    const c = pool.find((x) => x.id === id)
    if (!c) throw Error('Choose an eligible company')

    const existing = day.stops.find((s) => s.company_id === id)

    const plannedHistory = routeHistory([{ id: 'draft', body }], [], null)

    for (const [k, v] of history) {
      if (!plannedHistory.has(k)) plannedHistory.set(k, new Set())
      for (const date of v) plannedHistory.get(k).add(date)
    }

    if (!existing && !eligible(c, day.date, plannedHistory))
      throw Error('This contact is not due yet. The spacing rule still applies')

    changeDay({
      ...day,
      stops: existing
        ? day.stops.map((s) =>
            s.company_id === id ? { ...s, planned_type: type, minutes: 45 } : s,
          )
        : [
            ...day.stops,
            {
              company_id: id,
              tier: tierOf(c),
              planned_type: type,
              minutes: type === 'Face to Face' ? 20 : 45,
              backup,
            },
          ],
    })
  }

  async function savePlan() {
    await rpc('save_rotation', {
      p_id: current?.id || null,
      p_expected: current?.version || 0,
      p_facility: app.facilityId,
      p_program: program,
      p_territory: territory,
      p_user: owner,
      p_start: start,
      p_body: draft,
    })
    setDraft(null)
    q.refresh()
  }
  const linkActivity = (stop, date) =>
    '/activities/new?' +
    new URLSearchParams({
      company: stop.company_id,
      date,
      program,
      territory,
      return: '/rotation-schedules?day=' + date,
    })

  const stateOf = (d, s) =>
    stopCompleted(d, s, data.activities, owner, program)
      ? 'Completed'
      : data.activities.some(
            (a) =>
              a.company_id === s.company_id &&
              a.user_id === owner &&
              a.program_id === program &&
              a.activity_date === d.date &&
              a.visit_outcome !== 'completed',
          )
        ? 'Unavailable / unsuccessful'
        : d.date < chicagoToday()
          ? 'Missed / not recorded'
          : 'Planned'

  const stopRow = (d, s, i) => {
    const c =
      pool.find((c) => c.id === s.company_id) ||
      data.companies.find((x) => x.company_id === s.company_id)?.company
    const state = stateOf(d, s)
    const isDone = state === 'Completed'
    return (
      <li key={s.company_id} className={'ops-stop ' + s.tier.toLowerCase() + (isDone ? ' completed' : '')}>
        <b>
          {isDone && <span className="ops-check" aria-label="Completed">✓</span>}
          {c?.name || 'Company unavailable'}
        </b>
        <small>
          {c?.city} · {s.tier} · {s.planned_type}
        </small>
        <small className={isDone ? 'ops-done' : undefined}>{state}</small>
        <div className="row-actions">
          {canEdit &&
            (draft ? (
              <button
                className="btn btn-sm"
                disabled
                title="Save rotation before logging this visit"
              >
                Activity · save route first
              </button>
            ) : (
              <Link className="btn btn-sm" to={linkActivity(s, d.date)}>
                Activity
              </Link>
            ))}
          <button
            className="btn btn-sm"
            onClick={() => {
              setFlag({ id: s.company_id, date: d.date })
              setReason('')
            }}
          >
            Flag company
          </button>
        </div>
      </li>
    )
  }

  if (!data) return <><OpsHead title="Rotation Schedules" /><OpsState query={q} /></>

  return (
    <>
      <OpsHead title="Rotation Schedules" />
      <OpsState query={q}>
        <div className="toolbar">
          <ProgramPick
            data={data}
            value={program}
            onChange={(v) => {
              setProgram(v)
              setDraft(null)
              setCorridors(null)
            }}
          />

          <label className="ops-field">
            Territory
            <select
              value={territory}
              onChange={(e) => {
                setTerritory(e.target.value)
                setDraft(null)
                setCorridors(null)
              }}
            >
              <option value="">Choose territory</option>
              {(app.lookups.territories || [])
                .filter(
                  (t) =>
                    app.isManager ||
                    data?.members.find((m) => m.user_id === app.profile.id)
                      ?.territory_id === t.id,
                )
                .map((t) => (
                  <option value={t.id} key={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>

          {app.isManager && (
            <PersonPick
              data={data}
              value={owner}
              onChange={(v) => {
                setOwner(v)
                setDraft(null)
                setTerritory(
                  data.members.find((m) => m.user_id === v)?.territory_id || '',
                )
              }}
            />
          )}

          <label className="ops-field">
            Five-week start
            <input
              type="date"
              value={start}
              onChange={(e) => {
                setStart(e.target.value)
                setDraft(null)
              }}
            />
          </label>

          <button
            className="btn"
            disabled={busy || !canEdit}
            onClick={() => action(generate)}
          >
            Build five-week draft
          </button>

          <button
            className="btn btn-primary"
            disabled={busy || !draft || !canEdit}
            onClick={() => action(savePlan)}
          >
            Save rotation
          </button>
        </div>

        <Banner kind="error">{error}</Banner>
        {draft && (
          <Banner>
            Unsaved route changes. Save to share them with the team.
          </Banner>
        )}

        <p>
          Monday: three Battle Plan blocks, then 12 planned field stops (minimum
          9). Tuesday–Friday: 15; approved low census: 18. Primaries: at least
          14 days apart. Secondaries: one calendar month. Tertiaries: three
          months.
        </p>

        <div className="row-actions">
          <button className="btn" onClick={() => setLow(true)}>
            Low census action plan
          </button>
          {data?.low
            .filter((w) => w.program_id === program && !w.approved_by)
            .map((w) => (
              <span key={w.id}>
                Requested {w.starts}–{w.ends}{' '}
                {app.isAdmin && (
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      const sign = prompt(
                        'Administrator initials after reviewing this request: ' +
                          w.reason,
                      )
                      if (sign)
                        action(async () => {
                          await rpc('approve_low_census', {
                            p_id: w.id,
                            p_initials: sign,
                          })
                          q.refresh()
                        })
                    }}
                  >
                    Approve
                  </button>
                )}
              </span>
            ))}
        </div>

        {app.isAdmin &&
          data.low
            .filter((w) => w.program_id === program && !w.approved_by)
            .map((w) => (
              <div className="card card-body" key={w.id}>
                <b>
                  Low census approval requested · {w.starts}–{w.ends}
                </b>
                <p>{w.reason}</p>
                <button
                  className="btn"
                  onClick={() => {
                    const signed = window.prompt(
                      'Administrator initials to approve this low-census window',
                    )
                    if (signed)
                      action(async () => {
                        await rpc('approve_low_census', {
                          p_id: w.id,
                          p_initials: signed,
                        })
                        q.refresh()
                      })
                  }}
                >
                  Approve requested window
                </button>
              </div>
            ))}

        <details className="card card-body">
          <summary>Route corridors / Monday and Friday travel</summary>
          <p>
            Choose cities for each alternating week. Mondays start at the
            hospital; put nearby cities on Monday and preferably Friday. Driving
            time is not calculated until a routing provider is connected.
            Missing distance data must be reviewed.
          </p>
          <div className="ops-two">
            {[0, 1].map((w) => (
              <section key={w}>
                <h3>{w ? 'Weeks 2 / 4' : 'Weeks 1 / 3 / 5'}</h3>
                {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(
                  (label, i) => (
                    <label className="ops-field" key={i}>
                      {label}
                      <input
                        value={(corridors ||
                          defaultCorridors(
                            pool,
                            app.facility.slug,
                            app.lookups.territories?.find(
                              (t) => t.id === territory,
                            )?.name,
                          ))[w][i].join(' / ')}
                        onChange={(e) => {
                          const next = structuredClone(
                            corridors ||
                              defaultCorridors(
                                pool,
                                app.facility.slug,
                                app.lookups.territories?.find(
                                  (t) => t.id === territory,
                                )?.name,
                              ),
                          )
                          next[w][i] = e.target.value
                            .toUpperCase()
                            .split('/')
                            .map((x) => x.trim())
                            .filter(Boolean)
                          setCorridors(next)
                        }}
                      />
                    </label>
                  ),
                )}
              </section>
            ))}
          </div>
        </details>

        <div className="ops-tabs">
          {[
            ['rotation', 'Five-week rotation'],
            ['actual', 'Planned versus actual'],
            ['archive', 'Archive'],
          ].map(([v, l]) => (
            <button
              key={v}
              className={'btn ' + (v === view ? 'btn-primary' : '')}
              onClick={() => setView(v)}
            >
              {l}
            </button>
          ))}
        </div>

        {!body && (
          <div className="card card-body">
            Choose your program and territory, then build from the accounts made
            eligible for this program under Admin → Program eligibility. No demo
            contacts are inserted.
          </div>
        )}

        {body && program && territory && pool.length === 0 && (
          <Banner kind="error">
            No accounts are eligible for this program and territory yet, so every
            slot is unfilled. Add them under Admin → Program eligibility — an
            account also needs a street address and a city that falls in this
            route's corridors before it can be scheduled.
          </Banner>
        )}

        {view === 'rotation' && body && (
          <div className="ops-rotation">
            {body.days.map((d) => (
              <section className="card card-body" key={d.date}>
                <h3>
                  {d.date} ·{' '}
                  {new Date(d.date + 'T12:00Z').toLocaleDateString('en-US', {
                    weekday: 'long',
                    timeZone: 'UTC',
                  })}
                </h3>
                <p>{d.cities.join(' / ')}</p>
                <button className="btn" onClick={() => setDayDate(d.date)}>
                  Start day / route
                </button>
                <p>
                  {d.stops.length}/{d.goal} planned stops ·{' '}
                  {d.stops.filter((s) => s.tier === 'Primary').length} primary
                </p>
                {new Date(d.date + 'T12:00Z').getUTCDay() === 1 && (
                  <ol className="ops-meeting">
                    {[1, 2, 3].map((n) => (
                      <li key={n}>BATTLE PLAN</li>
                    ))}
                  </ol>
                )}
                <ol>{d.stops.map((s, i) => stopRow(d, s, i))}</ol>
                {d.stops.length < d.goal && (
                  <p className="ops-warning">
                    {d.goal - d.stops.length} unfilled —{' '}
                    {pool.length === 0
                      ? 'no eligible accounts for this program and territory'
                      : `no eligible account left in ${d.cities.join(' / ')} for this day (visit spacing preserved)`}
                    .
                  </p>
                )}
              </section>
            ))}
          </div>
        )}

        {view === 'actual' && body && (
          <div className="card card-body">
            {body.days.map((d) => {
              const done = d.stops.filter((s) =>
                stopCompleted(d, s, data.activities, owner, program),
              ).length
              return (
                <div className="ops-day-comparison" key={d.date}>
                  <strong>{d.date}</strong>
                  <span>{d.stops.length} planned</span>
                  <span>{done} completed</span>
                  <span>
                    {d.date < chicagoToday() && d.stops.length
                      ? (
                          ((d.stops.length - done) / d.stops.length) *
                          100
                        ).toFixed(1) + '% missed'
                      : 'Day open'}
                  </span>
                  <button className="btn" onClick={() => setDayDate(d.date)}>
                    Review day
                  </button>
                </div>
              )
            })}
            <h3>Weekly deviation</h3>
            {weeklyDeviation(
              body.days,
              data.activities,
              owner,
              program,
              chicagoToday(),
            ).map((w) => (
              <p key={w.week}>
                {w.week}: {w.completed}/{w.due} due planned visits completed ·{' '}
                {w.due
                  ? w.percent.toFixed(1) +
                    '% deviation · ' +
                    (w.percent <= 10 ? 'Within 10%' : 'Over 10% — review')
                  : 'No closed days yet'}
              </p>
            ))}
            <p>
              Weekly allowed deviation: 10% of due planned visits.
              Telephone/cold calls and unsuccessful attempts do not complete
              physical stops.
            </p>
          </div>
        )}

        {view === 'archive' && (
          <div className="card card-body">
            <h2>Saved versions</h2>
            <Banner kind="error">{archive.error}</Banner>
            {archive.rows.map((r) => (
              <details key={r.id}>
                <summary>
                  {r.happened_at} · {r.action}
                </summary>
                <pre>{JSON.stringify(r.payload, null, 2)}</pre>
              </details>
            ))}
          </div>
        )}

        {day && (
          <Modal
            title={'Active day · ' + day.date}
            onClose={() => setDayDate('')}
          >
            <div className="ops-active-progress">
              {
                day.stops.filter((s) =>
                  stopCompleted(day, s, data.activities, owner, program),
                ).length
              }{' '}
              / {day.goal} completed
            </div>
            <div className="ops-two">
              <label className="ops-field">
                Start location
                <input
                  value={day.start}
                  onChange={(e) => changeDay({ ...day, start: e.target.value })}
                />
              </label>
              <label className="ops-field">
                End location
                <input
                  value={day.end}
                  onChange={(e) => changeDay({ ...day, end: e.target.value })}
                />
              </label>
            </div>
            <button
              className="btn"
              onClick={() =>
                changeDay({
                  ...day,
                  stops: [...day.stops].sort((a, b) => {
                    const x = pool.find((c) => c.id === a.company_id),
                      y = pool.find((c) => c.id === b.company_id)
                    return (
                      (x?.city || '').localeCompare(y?.city || '') ||
                      (x?.address_line1 || '').localeCompare(
                        y?.address_line1 || '',
                      )
                    )
                  }),
                })
              }
            >
              Order by city / street
            </button>
            <p>
              Estimated order only. Check travel time and appointment times in
              Maps.
            </p>
            <ol>
              {day.stops.map((s, i) => {
                const c = pool.find((c) => c.id === s.company_id),
                  previous = i
                    ? pool.find((c) => c.id === day.stops[i - 1].company_id)
                    : null
                return (
                  <div key={s.company_id}>
                    {stopRow(day, s, i)}
                    {c && (
                      <p>
                        <a
                          href={mapLink(
                            c,
                            previous ? fullAddress(previous) : day.start,
                          )}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Google Maps
                        </a>{' '}
                        ·{' '}
                        <a
                          href={mapLink(
                            c,
                            previous ? fullAddress(previous) : day.start,
                            true,
                          )}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Apple Maps
                        </a>
                      </p>
                    )}
                  </div>
                )
              })}
            </ol>
            <h3>Add an in-service / lunch and learn</h3>
            <input
              aria-label="Search eligible companies"
              placeholder="Search company or city"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Company"
              value={service}
              onChange={(e) => setService(e.target.value)}
            >
              <option value="">Choose existing company</option>
              {pool
                .filter((c) =>
                  (c.name + ' ' + c.city)
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .slice(0, 100)
                .map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name} · {c.city}
                  </option>
                ))}
            </select>
            <select
              value={serviceType}
              onChange={(e) => setServiceType(e.target.value)}
            >
              <option>In-Service</option>
              <option>Luncheon</option>
            </select>
            <button
              className="btn"
              onClick={() => action(() => addService(service, serviceType))}
            >
              Add scheduled visit
            </button>
            <h3>Backup touches</h3>
            {backupCandidates(
              pool,
              day,
              routeHistory(
                [
                  { id: 'draft', body },
                  ...data.plans.filter((p) => p.id !== current?.id),
                ],
                data.activities,
                null,
              ),
            ).map((c) => (
              <p key={c.id}>
                {c.name} · {c.city}{' '}
                <button
                  className="btn"
                  onClick={() =>
                    action(() => addService(c.id, 'Face to Face', true))
                  }
                >
                  Add backup
                </button>
              </p>
            ))}
            <p>
              Up to three eligible alternatives. Original attempts and
              activities remain in the record.
            </p>
            <Banner kind="error">{error}</Banner>
            <button
              className="btn btn-primary"
              disabled={busy || !draft || !canEdit}
              onClick={() => action(savePlan)}
            >
              Save route changes
            </button>
          </Modal>
        )}

        {flag && (
          <Modal
            title="Flag company for verification"
            onClose={() => setFlag(null)}
          >
            <select
              value={flagKind}
              onChange={(e) => setFlagKind(e.target.value)}
            >
              {[
                'Closed',
                'Temporarily unavailable',
                'Name change',
                'Address correction',
                'Other',
              ].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <textarea
              placeholder="What did you find? Include the date and evidence."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await rpc('flag_company', {
                    p_facility: app.facilityId,
                    p_company: flag.id,
                    p_kind: flagKind,
                    p_conflict:
                      reason.trim().length >= 5
                        ? flag.date + ': ' + reason
                        : '',
                  })
                  setFlag(null)
                  q.refresh()
                })
              }
            >
              Send to verification
            </button>
            <Banner kind="error">{error}</Banner>
          </Modal>
        )}

        {low && (
          <Modal title="Low census action plan" onClose={() => setLow(false)}>
            <p>
              Request an approved window. An administrator must initial
              activation. Rebuild future routes after approval to increase
              Tuesday–Friday plans to 18.
            </p>
            <label className="ops-field">
              Through
              <input
                type="date"
                value={lowEnd}
                onChange={(e) => setLowEnd(e.target.value)}
              />
            </label>
            <textarea
              placeholder="Reason / census opportunity"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {app.isAdmin && (
              <input
                placeholder="Administrator initials to activate"
                value={initials}
                onChange={(e) => setInitials(e.target.value)}
              />
            )}
            <button
              className="btn btn-primary"
              onClick={() =>
                action(async () => {
                  await rpc('request_low_census', {
                    p_facility: app.facilityId,
                    p_program: program,
                    p_start: chicagoToday(),
                    p_end: lowEnd,
                    p_reason: reason,
                    p_initials: app.isAdmin && initials ? initials : null,
                  })
                  setLow(false)
                  q.refresh()
                })
              }
            >
              Save request / approval
            </button>
            <Banner kind="error">{error}</Banner>
          </Modal>
        )}
      </OpsState>
    </>
  )
}
