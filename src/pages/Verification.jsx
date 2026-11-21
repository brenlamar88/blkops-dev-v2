import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApp, useQuery, fetchAll } from '../lib/data'
import { supabase } from '../lib/supabase'
import { rpc } from '../lib/operations'
import { OpsHead } from '../components/Operations'
import { Banner, Loading, Modal } from '../components/ui'
import { useProspectReview } from '../lib/prospect-review-hooks'
import {
  ProspectReviewQueue,
  ProspectReviewStatus,
} from '../components/ProspectReview'
export default function Verification() {
  const [params] = useSearchParams(),
    review = useProspectReview(),
    [section, setSection] = useState(params.get('section') || 'conflicts')
  const app = useApp(),
    [history, setHistory] = useState(false),
    [error, setError] = useState(''),
    [scanSummary, setScanSummary] = useState(''),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(null)
  const [values, setValues] = useState({}),
    [evidence, setEvidence] = useState(''),
    [initials, setInitials] = useState(''),
    [attest, setAttest] = useState(false),
    [restate, setRestate] = useState(false),
    [resolution, setResolution] = useState('correct')
  const q = useQuery(
    () =>
      fetchAll(() =>
        supabase
          .from('verification_flags')
          .select(
            '*,company:companies!verification_flags_company_id_fkey(*),candidate:companies!verification_flags_candidate_id_fkey(*),facility:facilities(name),territory:territories(name)',
          )
          .order('created_at')
          .order('id'),
      ),
    [app.facilityId],
  )
  const territories = useQuery(
    () =>
      supabase.from('territories').select('id,name,facility_id').order('name'),
    [],
  )
  const open = q.rows.filter((r) => ['open', 'submitted'].includes(r.status)),
    shown = history
      ? q.rows.filter((r) => !['open', 'submitted'].includes(r.status))
      : open
  const admin =
    selected &&
    app.memberships.some(
      (m) => m.facility_id === selected.facility_id && m.role === 'admin',
    )
  function edit(r) {
    setSelected(r)
    setValues(r.proposed || { ...r.suggestion })
    setEvidence(r.evidence || '')
    setInitials('')
    setAttest(false)
    setRestate(false)
    setResolution('correct')
    setError('')
  }
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
  async function save(next = false) {
    if (admin)
      await rpc('resolve_verification', {
        p_id: selected.id,
        p_version: selected.version,
        p_values: values,
        p_action: resolution,
        p_evidence: evidence,
        p_initials: initials,
        p_attest: attest,
        p_restate: restate,
      })
    else
      await rpc('propose_verification', {
        p_id: selected.id,
        p_version: selected.version,
        p_values: values,
        p_evidence: evidence,
        p_initials: initials,
        p_attest: attest,
      })
    const other = open.find((r) => r.id !== selected.id)
    q.refresh()
    if (next && other) edit(other)
    else setSelected(null)
  }
  const set = (key, value) => setValues((v) => ({ ...v, [key]: value }))
  return (
    <>
      <OpsHead title="Verification">
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            action(async () => {
              setScanSummary('')
              let added = 0
              for (const m of app.memberships)
                added += await rpc('scan_verification', {
                  p_facility: m.facility_id,
                })
              setScanSummary(
                'Scan complete: ' +
                  added +
                  ' new shared-directory flags. This scan only checks companies already saved in the database; it does not include files awaiting import.',
              )
              q.refresh()
            })
          }
        >
          Scan accessible campuses
        </button>
      </OpsHead>
      <div className="ops-tabs">
        <button
          className={'btn ' + (section === 'conflicts' ? 'btn-primary' : '')}
          onClick={() => setSection('conflicts')}
        >
          SHARED DATA CONFLICTS · {open.length}
        </button>
        <button
          className={'btn ' + (section === 'imports' ? 'btn-primary' : '')}
          onClick={() => setSection('imports')}
        >
          PROSPECTUS IMPORTS ·{' '}
          {review.loading
            ? 'CHECKING'
            : review.error
              ? 'UNAVAILABLE'
              : review.rows.filter((r) =>
                  ['pending', 'submitted'].includes(r.status),
                ).length}
        </button>
      </div>
      {section === 'imports' ? (
        <ProspectReviewQueue
          review={review}
          onChanged={() => q.refresh()}
          initialRow={params.get('row')}
        />
      ) : (
        <>
          <ProspectReviewStatus review={review} />
          {scanSummary && <p role="status">{scanSummary}</p>}
          <div className="kpis">
            <div className="kpi">
              <span className="l">Open flags</span>
              <span className="n">{open.length}</span>
            </div>
            <div className="kpi">
              <span className="l">Awaiting administrator</span>
              <span className="n">
                {open.filter((r) => r.status === 'submitted').length}
              </span>
            </div>
            <div className="kpi">
              <span className="l">Signed resolutions</span>
              <span className="n">{q.rows.length - open.length}</span>
            </div>
          </div>
          <p>
            Marketers receive their territory's conflicts. SDDs see their
            campuses; administrators verify and sign corrections. Suggestions
            require checking against the actual source.
          </p>
          <Link to="/reports/review">
            Open SDD / administrator approval inbox
          </Link>
          {params.get('row') &&
            open.find((r) => r.id === params.get('row')) && (
              <button
                className="btn btn-primary"
                onClick={() =>
                  edit(open.find((r) => r.id === params.get('row')))
                }
              >
                Resolve selected conflict
              </button>
            )}
          <button className="btn" onClick={() => setHistory(!history)}>
            {history ? 'Open conflicts' : 'Signed history'}
          </button>
          <Banner kind="error">{error || q.error}</Banner>
          {q.loading && <Loading />}
          <div className="ops-verification">
            {shown.map((r) => (
              <section className="ops-conflict card" key={r.id}>
                <div>
                  <h3>Flag location</h3>
                  {r.facility?.name}
                  <br />
                  {r.territory?.name || 'Unassigned / SDD'}
                  <p>{r.kind}</p>
                </div>
                <div>
                  <h3>Conflicting records</h3>
                  <strong>Option A · current record</strong>
                  <br />
                  <Link to={'/companies/' + r.company_id}>
                    {r.company?.name}
                  </Link>
                  <p>
                    {r.company?.address_line1}
                    <br />
                    {r.company?.city}, {r.company?.state}
                  </p>
                  {r.candidate && (
                    <>
                      <strong>Option B · possible match</strong>
                      <p>
                        <Link to={'/companies/' + r.candidate_id}>
                          {r.candidate.name}
                        </Link>
                        <br />
                        {r.candidate.address_line1}
                        <br />
                        {r.candidate.city}
                      </p>
                    </>
                  )}
                </div>
                <div>
                  <h3>What is the conflict?</h3>
                  <p>{r.conflict}</p>
                  <small>
                    {r.status} · {r.created_at}
                  </small>
                </div>
                <div>
                  <h3>Resolution suggestion / editing</h3>
                  <p>
                    {r.candidate
                      ? 'Compare the candidate and confirm whether this is the same company and physical location.'
                      : 'Verify the missing or reported details directly with the company; enter the corrected information.'}
                  </p>
                  {history ? (
                    <p>
                      Signed {r.initials} · {r.resolved_at}
                      <br />
                      {r.evidence}
                    </p>
                  ) : (
                    <button className="btn btn-primary" onClick={() => edit(r)}>
                      Resolve conflict
                    </button>
                  )}
                </div>
              </section>
            ))}
          </div>
          {!q.loading && !shown.length && (
            <p>
              No {history ? 'signed' : 'open'} items in your authorized scope.
            </p>
          )}
        </>
      )}
      {selected && (
        <Modal
          title={'Resolve · ' + selected.company?.name}
          onClose={() => setSelected(null)}
        >
          <div className="resolution-layout">
            <div>
              <p>{selected.conflict}</p>
              <details>
                <summary>Current record and proposed suggestion</summary>
                <pre>
                  {JSON.stringify(
                    {
                      current: selected.company,
                      suggestion: selected.suggestion,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <label className="ops-field">
                Resolution
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                >
                  <option value="correct">Correct record</option>
                  {selected.candidate && (
                    <option value="merge">Merge into candidate</option>
                  )}
                  {selected.candidate && (
                    <option value="distinct">
                      Verified distinct locations / records
                    </option>
                  )}
                </select>
              </label>
              <div className="ops-two">
                {[
                  ['name', 'Company name'],
                  ['address_line1', 'Address'],
                  ['city', 'City'],
                  ['state', 'State'],
                  ['zip', 'ZIP'],
                  ['phone', 'Phone'],
                  ['fax', 'Fax'],
                ].map(([key, label]) => (
                  <label key={key} className="ops-field">
                    {label}
                    <input
                      value={values[key] || ''}
                      onChange={(e) => set(key, e.target.value)}
                    />
                  </label>
                ))}
                <label className="ops-field">
                  Category
                  <select
                    value={values.category_id || ''}
                    onChange={(e) => set('category_id', e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {(app.lookups.categories || []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ops-field">
                  Campus territory
                  <select
                    value={values.territory_id || ''}
                    onChange={(e) => set('territory_id', e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {territories.rows
                      .filter((t) => t.facility_id === selected.facility_id)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="ops-field">
                  Company status
                  <select
                    value={values.status || 'active'}
                    onChange={(e) => set('status', e.target.value)}
                  >
                    <option value="active">Active</option>
                    <option value="name_change">Name change</option>
                    <option value="closed">Permanently closed</option>
                  </select>
                </label>
              </div>
              {resolution === 'merge' && (
                <label className="ops-check">
                  <input
                    type="checkbox"
                    checked={!!values.same_location}
                    onChange={(e) => set('same_location', e.target.checked)}
                  />
                  I verified these are the same company AND physical location.
                </label>
              )}
              <label className="ops-field">
                Evidence / how verified
                <textarea
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder="Who confirmed this, when, and the correct details"
                />
              </label>
              {admin && (
                <>
                  <label className="ops-check">
                    <input
                      type="checkbox"
                      checked={restate}
                      onChange={(e) => setRestate(e.target.checked)}
                    />
                    This was a category/territory error: also correct historical
                    referrals and activities at this campus. Leave unchecked for
                    a real territory transfer.
                  </label>
                </>
              )}
              <>
                <label className="ops-field">
                  {admin
                    ? 'Administrator initials'
                    : 'Your verification initials'}
                  <input
                    maxLength={8}
                    value={initials}
                    onChange={(e) => setInitials(e.target.value)}
                  />
                </label>
                <label className="ops-check">
                  <input
                    type="checkbox"
                    checked={attest}
                    onChange={(e) => setAttest(e.target.checked)}
                  />
                  {admin
                    ? 'I verified this correction and approve applying it to the linked records.'
                    : 'I checked these details and confirm this correction for administrator review.'}
                </label>
              </>
              <p>
                Shared company details update linked views. Original resolution
                evidence is retained. Historical representative credit is
                preserved. Merges retain prior needs-analysis history on the
                original company.
              </p>
              <Banner kind="error">{error}</Banner>
              <div className="row-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => action(() => save(false))}
                >
                  {admin
                    ? 'Apply signed resolution'
                    : 'Submit correction to administrator'}
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => action(() => save(true))}
                >
                  Save & next conflict
                </button>
                <button
                  className="btn"
                  onClick={() =>
                    action(async () => {
                      await rpc('refresh_verification', { p_id: selected.id })
                      setSelected(null)
                      q.refresh()
                    })
                  }
                >
                  Refresh changed record
                </button>
              </div>
            </div>
            <aside className="resolution-recommendation">
              <h3>Recommended review</h3>
              <p>
                {selected.candidate
                  ? 'Compare Option A with Option B. Link or merge only after verifying the same company and physical location.'
                  : 'Confirm the missing or reported fields with the company and enter the verified details.'}
              </p>
              <p>
                <b>You must validate these suggestions.</b>
              </p>
              <dl>
                {Object.entries(selected.suggestion || {})
                  .filter(([k]) =>
                    [
                      'name',
                      'address_line1',
                      'city',
                      'state',
                      'phone',
                      'fax',
                    ].includes(k),
                  )
                  .map(([k, v]) => (
                    <div key={k}>
                      <dt>{k.replaceAll('_', ' ')}</dt>
                      <dd>{v || 'Unknown'}</dd>
                    </div>
                  ))}
              </dl>
              <p>
                Reviewer initials and administrator sign-off are recorded
                separately.
              </p>
            </aside>
          </div>
        </Modal>
      )}
    </>
  )
}
