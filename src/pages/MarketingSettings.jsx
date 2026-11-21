import { useState } from 'react'
import { useApp } from '../lib/data'
import { supabase } from '../lib/supabase'
import { useOperations } from '../lib/operations'
import {
  OpsHead,
  OpsState,
  PersonPick,
  ProgramPick,
} from '../components/Operations'
import { Banner, DataTable } from '../components/ui'
import { UNIT_TYPES } from '../lib/enums'
import { chicagoToday } from '../lib/operations-core'
export default function MarketingSettings() {
  const app = useApp(),
    q = useOperations(),
    d = q.data,
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [newProgram, setNewProgram] = useState({
    code: '',
    name: '',
    unit_type: 'Inpatient Geri',
  })
  const [user, setUser] = useState(app.profile.id),
    [program, setProgram] = useState(''),
    [period, setPeriod] = useState(chicagoToday().slice(0, 7) + '-01'),
    [cadence, setCadence] = useState('monthly'),
    [metric, setMetric] = useState('referrals'),
    [target, setTarget] = useState(''),
    [address, setAddress] = useState(app.facility.street_address || '')
  async function save(fn) {
    setError('')
    setBusy(true)
    try {
      const r = await fn()
      if (r.error) throw r.error
      await app.reloadMemberships()
      q.refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  if (!app.isAdmin)
    return (
      <>
        <OpsHead title="Marketing configuration" />
        <Banner>
          Only campus administrators may manage programs, territory assignments
          and approved budgets.
        </Banner>
      </>
    )
  if (!d) return <OpsState query={q} />
  return (
    <>
      <OpsHead title="Programs & Approved Budgets" />
      <OpsState query={q}>
        <Banner kind="error">{error}</Banner>
        <Banner>
          Annual budget-workbook upload and automatic territory allocation are
          managed separately and are not on this screen yet. Programs, territory
          assignments and approved goals below are live.
        </Banner>
        <section className="card card-body">
          <h2>Campus programs</h2>
          <p>
            Configure actual units here. Each transaction records its program
            explicitly. User names never determine the unit.
          </p>
          <DataTable
            rows={d?.programs || []}
            columns={[
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Program' },
              { key: 'unit_type', label: 'Unit type' },
            ]}
          />
          <div className="toolbar">
            <input
              aria-label="New program code"
              placeholder="Program code"
              value={newProgram.code}
              onChange={(e) =>
                setNewProgram({ ...newProgram, code: e.target.value })
              }
            />
            <input
              aria-label="New program name"
              placeholder="Program name"
              value={newProgram.name}
              onChange={(e) =>
                setNewProgram({ ...newProgram, name: e.target.value })
              }
            />
            <select
              value={newProgram.unit_type}
              onChange={(e) =>
                setNewProgram({ ...newProgram, unit_type: e.target.value })
              }
            >
              {UNIT_TYPES.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
            <button
              className="btn"
              disabled={
                busy || !newProgram.code.trim() || !newProgram.name.trim()
              }
              onClick={() =>
                save(() =>
                  supabase
                    .from('facility_programs')
                    .insert({ ...newProgram, facility_id: app.facilityId }),
                )
              }
            >
              Add program
            </button>
          </div>
          <label className="ops-field">
            Hospital street address for Monday route start
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <button
            className="btn"
            onClick={() =>
              save(() =>
                supabase
                  .from('facilities')
                  .update({ street_address: address })
                  .eq('id', app.facilityId),
              )
            }
          >
            Save hospital address
          </button>
        </section>
        <section className="card card-body">
          <h2>Marketer territory assignments</h2>
          {d?.members.map((m) => (
            <label className="ops-field" key={m.user_id}>
              {m.profile?.first_name} {m.profile?.last_name}
              <select
                value={m.territory_id || ''}
                onChange={(e) =>
                  save(() =>
                    supabase
                      .from('facility_members')
                      .update({ territory_id: e.target.value || null })
                      .eq('facility_id', app.facilityId)
                      .eq('user_id', m.user_id),
                  )
                }
              >
                <option value="">Unassigned</option>
                {app.lookups.territories.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </section>
        <section className="card card-body">
          <h2>Approved goals / weekly commitments</h2>
          <p>
            Record each employee's actual budget. Blank targets remain unknown.
            Use all programs for company leaderboard targets; use campus goals
            for ADC. A weekly goal can record an approved Battle Plan commitment
            without inventing its report template.
          </p>
          <div className="toolbar">
            <PersonPick data={d} value={user} onChange={setUser} />
            <button className="btn" onClick={() => setUser('')}>
              Use campus goal
            </button>
            <ProgramPick data={d} value={program} onChange={setProgram} all />
            <label className="ops-field">
              Period starts
              <input
                type="date"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              />
            </label>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value)}
            >
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
            </select>
            <select value={metric} onChange={(e) => setMetric(e.target.value)}>
              {[
                'referrals',
                'admissions',
                'touches',
                'quality_touches',
                'inservices',
                'adc',
              ].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <input
              type="number"
              min="0"
              step=".1"
              aria-label="Approved target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={busy || target === ''}
              onClick={() =>
                save(() =>
                  supabase.from('marketing_goals').upsert(
                    {
                      facility_id: app.facilityId,
                      user_id: user || null,
                      program_id: program || null,
                      period_start: period,
                      cadence,
                      metric,
                      target: Number(target),
                      updated_at: new Date().toISOString(),
                    },
                    {
                      onConflict:
                        'facility_id,user_id,program_id,period_start,cadence,metric',
                    },
                  ),
                )
              }
            >
              Save approved goal
            </button>
          </div>
          <DataTable
            rows={d?.goals || []}
            columns={[
              { key: 'period_start', label: 'Period' },
              { key: 'cadence', label: 'Cadence' },
              {
                key: 'user_id',
                label: 'Marketer',
                render: (r) => {
                  const p = d.members.find(
                    (m) => m.user_id === r.user_id,
                  )?.profile
                  return p ? [p.first_name, p.last_name].join(' ') : 'Campus'
                },
              },
              {
                key: 'program_id',
                label: 'Program',
                render: (r) =>
                  d.programs.find((p) => p.id === r.program_id)?.name ||
                  'All programs',
              },
              { key: 'metric', label: 'Metric' },
              { key: 'target', label: 'Approved goal' },
            ]}
          />
        </section>
      </OpsState>
    </>
  )
}
