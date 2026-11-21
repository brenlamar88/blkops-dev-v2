import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp, useQuery, fetchAll } from '../lib/data'
import { Banner, Empty, Loading } from '../components/ui'

/* ------------------------------------------------------------------
   Program eligibility — which accounts each program (unit) works, and at
   what tier. This is what the rotation board schedules from: a company only
   becomes a routable stop once it is made eligible for a program here.

   Writes company_programs, which RLS limits to campus admins
   (operations_admin); everyone else sees it read-only.
------------------------------------------------------------------ */

const TIERS = ['Primary', 'Secondary', 'Tertiary']

export default function ProgramEligibility() {
  const { facilityId, facility, isAdmin, lookups } = useApp()
  const [program, setProgram] = useState('')
  const [search, setSearch] = useState('')
  const [onlyEligible, setOnlyEligible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const catName = useMemo(() => {
    const m = {}; for (const c of lookups.categories ?? []) m[c.id] = c.name; return m
  }, [lookups.categories])

  const programsQ = useQuery(() => facilityId
    ? supabase.from('facility_programs').select('*')
        .eq('facility_id', facilityId).eq('active', true).order('name')
    : null, [facilityId])

  const companiesQ = useQuery(() => facilityId
    ? fetchAll(() => supabase.from('facility_companies')
        .select('company_id, company:companies(id,name,city,category_id,status,merged_into_id,active)')
        .eq('facility_id', facilityId).eq('active', true).order('company_id'))
    : null, [facilityId])

  const eligQ = useQuery(() => (facilityId && program)
    ? supabase.from('company_programs').select('*')
        .eq('facility_id', facilityId).eq('program_id', program)
    : null, [facilityId, program])

  const eligMap = useMemo(() => {
    const m = new Map(); for (const e of eligQ.rows) m.set(e.company_id, e); return m
  }, [eligQ.rows])

  const companies = useMemo(() => {
    const term = search.trim().toLowerCase()
    return companiesQ.rows
      .map((fc) => fc.company)
      .filter((c) => c && c.active && !c.merged_into_id && c.status !== 'closed')
      .filter((c) => !term || (c.name || '').toLowerCase().includes(term))
      .filter((c) => !onlyEligible || eligMap.has(c.id))
      .sort((a, b) => {
        const ae = eligMap.has(a.id), be = eligMap.has(b.id)
        if (ae !== be) return ae ? -1 : 1 // eligible first
        return (a.name || '').localeCompare(b.name || '')
      })
  }, [companiesQ.rows, search, onlyEligible, eligMap])

  const shown = companies.slice(0, 200)

  const run = (fn) => async () => {
    setBusy(true); setError('')
    try { await fn(); eligQ.refresh() }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const add = (c) => run(async () => {
    const { error } = await supabase.from('company_programs').upsert({
      facility_id: facilityId, program_id: program, company_id: c.id,
      category_id: c.category_id ?? null, tier: 'Secondary',
    }, { onConflict: 'program_id,company_id' })
    if (error) throw new Error(error.message)
  })()
  const setTier = (c, tier) => run(async () => {
    const { error } = await supabase.from('company_programs').update({ tier })
      .eq('program_id', program).eq('company_id', c.id)
    if (error) throw new Error(error.message)
  })()
  const toggleMdr = (c, e) => run(async () => {
    const { error } = await supabase.from('company_programs')
      .update({ medical_director_rounds: !e.medical_director_rounds })
      .eq('program_id', program).eq('company_id', c.id)
    if (error) throw new Error(error.message)
  })()
  const remove = (c) => run(async () => {
    const { error } = await supabase.from('company_programs').delete()
      .eq('program_id', program).eq('company_id', c.id)
    if (error) throw new Error(error.message)
  })()

  const loading = programsQ.loading || companiesQ.loading
  const err = error || programsQ.error || companiesQ.error || eligQ.error

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Program eligibility</h1>
          <p>{facility?.name ?? 'No campus'} — assign accounts to a program and set their
             tier. The rotation board builds routes from the accounts you make eligible here.</p>
        </div>
      </div>

      <div className="toolbar">
        <select value={program} onChange={(e) => setProgram(e.target.value)} aria-label="Program">
          <option value="">Choose a program…</option>
          {programsQ.rows.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input type="search" placeholder="Search accounts…" value={search}
               onChange={(e) => setSearch(e.target.value)} aria-label="Search accounts" />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink-3)' }}>
          <input type="checkbox" checked={onlyEligible} onChange={(e) => setOnlyEligible(e.target.checked)} style={{ width: 'auto' }} />
          Only eligible
        </label>
        <div className="spacer" />
        <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 12 }}>
          {program ? `${eligMap.size} eligible` : ''}
        </span>
      </div>

      {err && <Banner kind="error">{err}</Banner>}
      {!isAdmin && (
        <Banner kind="info">You can view eligibility, but only a campus admin can change it.</Banner>
      )}

      {loading ? <Loading rows={8} /> : !program ? (
        <Empty title="Pick a program"
               body="Choose a program above to see and edit which accounts it works." />
      ) : !shown.length ? (
        <Empty title="No accounts match" body="Clear the search, or add accounts to this campus first." />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th><th>City</th><th>Category</th>
                  <th>Tier</th><th className="num">MDR</th><th>Eligible</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const e = eligMap.get(c.id)
                  return (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{c.city || '—'}</td>
                      <td>{catName[c.category_id] || '—'}</td>
                      <td>
                        {e ? (
                          <select value={e.tier} disabled={!isAdmin || busy}
                                  onChange={(ev) => setTier(c, ev.target.value)} aria-label="Tier">
                            {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        ) : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                      </td>
                      <td className="num">
                        {e ? (
                          <input type="checkbox" checked={!!e.medical_director_rounds}
                                 disabled={!isAdmin || busy}
                                 onChange={() => toggleMdr(c, e)} aria-label="Medical director rounds" />
                        ) : '—'}
                      </td>
                      <td>
                        {e ? (
                          <button className="btn btn-sm" type="button" disabled={!isAdmin || busy}
                                  onClick={() => remove(c)}>Remove</button>
                        ) : (
                          <button className="btn btn-sm btn-primary" type="button" disabled={!isAdmin || busy}
                                  onClick={() => add(c)}>Add</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {companies.length > shown.length && (
            <div className="card-body" style={{ color: 'var(--ink-3)', fontSize: 12 }}>
              Showing first {shown.length} of {companies.length} — narrow with search.
            </div>
          )}
        </div>
      )}
    </>
  )
}
